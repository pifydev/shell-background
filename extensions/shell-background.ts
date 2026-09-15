/**
 * @pify/shell-background — long-running bash goes async.
 *
 * Re-registers pi's `bash` tool with the same shell, cwd and env, but a
 * different lifecycle:
 *
 *   - a command's stdout+stderr are written straight to a log file via
 *     inherited file descriptors (no pipes, so no drain deadlock and no lost
 *     output at any volume), the process is spawned detached and unref'd so it
 *     survives the tool returning;
 *   - a foreground command that is still running after the auto-background
 *     threshold (default 30s, interactive sessions only) is moved to the
 *     background: the tool returns "moved to background, id=…" and the result is
 *     delivered into the conversation when the command finishes;
 *   - `background: true` launches detached from the start and returns the id
 *     immediately.
 *
 * `shell_status` polls or collects a job (and lists them all); `shell_kill`
 * terminates one and its whole process tree. Delivery reuses the suite's
 * pending pattern and its one hard rule: it only works in a session that
 * outlives the run, so auto-background is off under headless `pi -p` (explicit
 * background still works, collected with shell_status inside the turn).
 *
 * pi has no native background bash — every command is awaited to completion —
 * so the spawn is our own, reusing pi's shell resolution (getShellConfig) for
 * byte-identical shell behaviour. Zero runtime dependencies.
 */
import {
  createBashToolDefinition,
  getAgentDir,
  getShellConfig,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { JobRegistry } from "../src/registry.ts";
import { spawnToFile } from "../src/spawn.ts";
import { killTree } from "../src/kill.ts";
import { readTail } from "../src/tail.ts";
import { DEFAULT_SETTINGS, resolveSettings, type ShellBgSettings } from "../src/config.ts";
import { backgroundedResult, deliveryMessage, DELIVERY_TYPE } from "../src/pending.ts";
import { formatResult, formatList, header } from "../src/format.ts";
import { buildWidgetLines } from "../src/widget.ts";
import { isFinished } from "../src/types.ts";
import type { Job } from "../src/types.ts";

type UiContext = ExtensionContext;
type AnyTool = { name: string; execute: (...a: never[]) => unknown; [k: string]: unknown };
type ToolResult = { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown>; isError?: boolean };

const WIDGET = "shell-bg";

export default function shellBackground(pi: ExtensionAPI) {
  let settings: ShellBgSettings = DEFAULT_SETTINGS;
  let registry: JobRegistry | null = null;
  let lastUiCtx: UiContext | null = null;

  // ── setup ──────────────────────────────────────────────────────────

  function sessionKey(cwd: string): string {
    const id = process.env.PI_SESSION_ID;
    if (id) return id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40);
    return createHash("sha256").update(cwd).digest("hex").slice(0, 16);
  }

  function loadSettings(cwd: string): string[] {
    for (const file of [join(cwd, ".pi", "shell-background.json"), join(getAgentDir(), "shell-background.json")]) {
      let raw: string;
      try {
        raw = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      try {
        const parsed = resolveSettings(JSON.parse(raw));
        settings = parsed.settings;
        return parsed.warnings;
      } catch (err) {
        settings = DEFAULT_SETTINGS;
        return [`${file}: ${err instanceof Error ? err.message : String(err)}`];
      }
    }
    const parsed = resolveSettings(undefined);
    settings = parsed.settings;
    return parsed.warnings;
  }

  /** Shell + args, reusing pi's resolution; command rides in argv (not stdin). */
  function shellArgv(): { shell: string; args: string[] } {
    const cfg = getShellConfig();
    // Our stdio has stdin ignored, so a stdin command transport (legacy WSL)
    // cannot receive the command — fall back to -c, which every bash accepts.
    const args = cfg.commandTransport === "stdin" ? ["-c"] : [...cfg.args];
    return { shell: cfg.shell, args };
  }

  function renderWidget(ctx: UiContext | null = lastUiCtx): void {
    if (!ctx || !ctx.hasUI || !registry) return;
    lastUiCtx = ctx;
    const now = Date.now();
    const lines = buildWidgetLines(registry.all(), ctx.ui.theme as never, now);
    if (lines.length === 0) {
      ctx.ui.setWidget(WIDGET, undefined);
      return;
    }
    ctx.ui.setWidget(WIDGET, (_tui: unknown) => new Text(lines.join("\n"), 0, 0), { placement: "aboveEditor" });
  }

  // ── run ────────────────────────────────────────────────────────────

  function snapshot(job: Job): ToolResult {
    const tail = readTail(job.logPath, settings.tailBytes);
    return {
      content: [{ type: "text", text: `${header(job)}\n${tail.text.replace(/\n+$/, "") || "(no output yet)"}` }],
      details: { id: job.id, status: job.status },
    };
  }

  function finished(job: Job): ToolResult {
    return {
      content: [{ type: "text", text: formatResult(job, settings.tailBytes) }],
      details: { id: job.id, status: job.status, exitCode: job.exitCode, signal: job.signal, background: false },
      isError: job.status === "failed",
    };
  }

  /** Deliver a finished background job into the conversation, once. */
  function scheduleDelivery(job: Job, exit: Promise<unknown>): void {
    exit
      .then(() => {
        if (job.delivered) return;
        job.delivered = true;
        registry?.persist(job);
        renderWidget();
        pi.sendMessage(
          {
            customType: DELIVERY_TYPE,
            content: deliveryMessage(job.id, formatResult(job, settings.tailBytes)),
            display: true,
            details: { id: job.id, status: job.status, exitCode: job.exitCode },
          },
          { deliverAs: "followUp", triggerTurn: true },
        );
      })
      .catch(() => {
        // A /reload can make captured handles throw; delivery is a convenience,
        // shell_status still collects the result.
      });
  }

  async function runBash(
    params: { command: string; timeout?: number; background?: boolean },
    signal: AbortSignal | undefined,
    onUpdate: ((r: ToolResult) => void) | undefined,
    ctx: UiContext,
  ): Promise<ToolResult> {
    lastUiCtx = ctx;
    if (!registry) throw new Error("shell-background not initialized");
    const command = String(params.command ?? "").trim();
    if (!command) return { content: [{ type: "text", text: "Empty command." }], details: {}, isError: true };

    const job = registry.create(command, ctx.cwd);
    const { shell, args } = shellArgv();

    let spawned;
    try {
      spawned = spawnToFile(shell, args, command, ctx.cwd, process.env, job.logPath);
    } catch (err) {
      job.status = "failed";
      job.endedAt = Date.now();
      registry.persist(job);
      return { content: [{ type: "text", text: `Failed to start: ${err instanceof Error ? err.message : String(err)}` }], details: {}, isError: true };
    }
    job.pid = spawned.pid;
    registry.persist(job);
    renderWidget(ctx);

    // Settle the job record the moment the process ends, whatever else happens.
    const settle = spawned.exit.then(({ code, signal: sig }) => {
      if (job.status === "running") {
        job.status = job.killedByUs ? "killed" : sig ? "killed" : code === 0 ? "done" : "failed";
      }
      job.exitCode = code;
      job.signal = sig;
      job.endedAt = Date.now();
      registry?.persist(job);
      renderWidget();
    });

    if (params.background) {
      scheduleDelivery(job, settle);
      const r = backgroundedResult({
        id: job.id,
        command,
        elapsedMs: 0,
        auto: false,
        interactive: ctx.hasUI,
        collectWith: "shell_status",
      });
      return { content: [{ type: "text", text: r.text }], details: r.details };
    }

    // Foreground: race the process against the auto-background threshold, an
    // optional timeout, and the turn's abort signal — streaming the tail.
    const autoMs = ctx.hasUI ? settings.autoBackgroundMs : 0;
    const timers: NodeJS.Timeout[] = [];
    const after = (ms: number, val: string) =>
      new Promise<string>((res) => {
        const t = setTimeout(() => res(val), ms);
        t.unref?.();
        timers.push(t);
      });
    const tick = setInterval(() => onUpdate?.(snapshot(job)), 1000);
    tick.unref?.();

    const abort = new Promise<string>((res) => {
      if (!signal) return;
      if (signal.aborted) res("abort");
      else signal.addEventListener("abort", () => res("abort"), { once: true });
    });

    try {
      const race: Array<Promise<string>> = [settle.then(() => "exit")];
      if (autoMs > 0) race.push(after(autoMs, "auto"));
      if (params.timeout && params.timeout > 0) race.push(after(params.timeout * 1000, "timeout"));
      if (signal) race.push(abort);

      const outcome = await Promise.race(race);

      if (outcome === "exit") return finished(job);

      if (outcome === "auto") {
        scheduleDelivery(job, settle);
        // A timeout the caller set still applies once the command is in the
        // background: schedule the kill for the time it has left so the deadline
        // the model expects is honoured rather than silently dropped. This timer
        // deliberately outlives the `finally` below, so it is not in `timers`.
        if (params.timeout && params.timeout > 0) {
          const remaining = params.timeout * 1000 - (Date.now() - job.startedAt);
          const killAt = setTimeout(() => {
            if (job.status !== "running") return;
            job.killedByUs = true;
            killTree(job.pid);
          }, Math.max(0, remaining));
          killAt.unref?.();
        }
        const r = backgroundedResult({
          id: job.id,
          command,
          elapsedMs: Date.now() - job.startedAt,
          auto: true,
          interactive: ctx.hasUI,
          collectWith: "shell_status",
        });
        return { content: [{ type: "text", text: r.text }], details: r.details };
      }

      // timeout or abort: stop the tree, let the record settle, report partial.
      job.killedByUs = true;
      killTree(job.pid);
      await Promise.race([settle, after(500, "gave-up")]);
      const note =
        outcome === "timeout"
          ? `\n\n[killed: exceeded the ${params.timeout}s timeout]`
          : `\n\n[killed: the turn was aborted]`;
      return {
        content: [{ type: "text", text: formatResult(job, settings.tailBytes) + note }],
        details: { id: job.id, status: job.status },
        isError: true,
      };
    } finally {
      timers.forEach(clearTimeout);
      clearInterval(tick);
    }
  }

  // ── tools & lifecycle ────────────────────────────────────────────────

  function registerBash(cwd: string): void {
    const original = createBashToolDefinition(cwd) as unknown as AnyTool;
    const guidelines = [
      ...(Array.isArray((original as { promptGuidelines?: unknown }).promptGuidelines)
        ? ((original as { promptGuidelines?: string[] }).promptGuidelines as string[])
        : []),
      `A command still running after ${Math.round(settings.autoBackgroundMs / 1000)}s is moved to the background and its result is delivered when it finishes; pass background:true to background a long task (a server, build, or watcher) immediately. Collect or check with shell_status.`,
    ];
    pi.registerTool({
      ...original,
      parameters: Type.Object({
        command: Type.String({ description: "Shell command to execute" }),
        timeout: Type.Optional(
          Type.Number({ description: "Timeout in seconds; a command that hits it is killed with its whole process tree." }),
        ),
        background: Type.Optional(
          Type.Boolean({ description: "Launch detached and return an id immediately instead of waiting for the command to finish." }),
        ),
      }),
      promptGuidelines: guidelines,
      // Let pi render the result with its default text renderer; keep the call
      // renderer (it only needs the command) if the original had one.
      renderResult: undefined,
      execute: async (_id: string, params: never, sig: never, upd: never, ctx: never) =>
        runBash(params, sig as AbortSignal | undefined, upd as never, ctx as UiContext),
    } as never);
  }

  pi.registerTool({
    name: "shell_status",
    label: "Background shell status",
    promptSnippet: "Check or collect a backgrounded command",
    description:
      "Report a background command by id (its status and output tail), or list all this session's background commands when given no id. Finished results survive until the session ends.",
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: "Job id, e.g. bg-1. Omit to list all." })),
    }),
    async execute(_id: string, params: { id?: string }): Promise<ToolResult> {
      if (!registry) return { content: [{ type: "text", text: "shell-background not initialized" }], details: {}, isError: true };
      const id = params.id?.trim();
      if (!id) return { content: [{ type: "text", text: formatList(registry.all()) }], details: {} };
      const job = registry.get(id);
      if (!job) {
        const known = registry.all().map((j) => j.id).join(", ") || "(none)";
        return { content: [{ type: "text", text: `No job "${id}". Known: ${known}` }], details: {}, isError: true };
      }
      // Reading a finished job marks it collected so it will not also be
      // delivered unasked. A still-running poll must never do this: setting
      // delivered here would permanently cancel the promised auto-delivery.
      if (isFinished(job)) {
        job.delivered = true;
        registry.persist(job);
      }
      return {
        content: [{ type: "text", text: formatResult(job, settings.tailBytes) }],
        details: { id: job.id, status: job.status, exitCode: job.exitCode },
      };
    },
  });

  pi.registerTool({
    name: "shell_kill",
    label: "Kill background shell",
    promptSnippet: "Stop a backgrounded command",
    description: "Terminate a background command and its whole process tree by id.",
    parameters: Type.Object({ id: Type.String({ description: "Job id, e.g. bg-1" }) }),
    async execute(_id: string, params: { id: string }): Promise<ToolResult> {
      if (!registry) return { content: [{ type: "text", text: "shell-background not initialized" }], details: {}, isError: true };
      const job = registry.get(params.id?.trim());
      if (!job) return { content: [{ type: "text", text: `No job "${params.id}".` }], details: {}, isError: true };
      if (job.status !== "running") {
        return { content: [{ type: "text", text: `${job.id} already ${job.status}.` }], details: { id: job.id, status: job.status } };
      }
      job.killedByUs = true;
      killTree(job.pid);
      return { content: [{ type: "text", text: `Killing ${job.id} (pid ${job.pid ?? "?"}) and its process tree.` }], details: { id: job.id } };
    },
  });

  pi.registerCommand("shell-bg", {
    description: "Background shell jobs: /shell-bg [kill <id>]",
    handler: async (args, ctx: UiContext) => {
      if (!ctx.hasUI || !registry) return;
      const [verb, id] = (args ?? "").trim().split(/\s+/);
      if (verb === "kill" && id) {
        const job = registry.get(id);
        if (job && job.status === "running") {
          job.killedByUs = true;
          killTree(job.pid);
          ctx.ui.notify(`Killing ${job.id}.`, "info");
        } else {
          ctx.ui.notify(job ? `${id} already ${job.status}.` : `No job "${id}".`, "warning");
        }
        return;
      }
      ctx.ui.notify(formatList(registry.all()), "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const warnings = loadSettings(ctx.cwd);
    registry = new JobRegistry(join(tmpdir(), "pify-shell-bg", sessionKey(ctx.cwd)));
    registry.load();
    registerBash(ctx.cwd);
    renderWidget(ctx);
    if (warnings.length > 0 && ctx.hasUI) ctx.ui.notify(`shell-background settings: ${warnings.join("; ")}`, "warning");
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    // Background jobs are tied to the session; do not leave orphans running
    // after pi exits.
    if (registry) for (const job of registry.running()) killTree(job.pid);
    if (ctx.hasUI) ctx.ui.setWidget(WIDGET, undefined);
  });
}
