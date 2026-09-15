/**
 * Regression tests that drive the extension itself (not just the src/ helpers)
 * through a minimal mock of the pi ExtensionAPI. They pin two bugs:
 *
 *  1. Polling a still-running job with shell_status must not set delivered=true,
 *     which would permanently cancel the promised auto-delivery.
 *  3. A timeout the caller passed must still fire after a command auto-moves to
 *     the background — the kill the model expects may not be silently dropped.
 *
 * Both spawn a real, short-lived shell command, so they use the same portable
 * pipe→file spawn path the extension does (no numeric-fd stdio; Windows-safe).
 * Every spawned command is torn down before the test returns so the test runner
 * never blocks on a lingering child.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import shellBackground from "../extensions/shell-background.ts";
import { DELIVERY_TYPE } from "../src/pending.ts";

type AnyTool = { name: string; execute: (...a: any[]) => Promise<any> };
type AnyHandler = (event: any, ctx: any) => any;

interface Harness {
  pi: ExtensionAPI;
  tools: Map<string, AnyTool>;
  handlers: Map<string, AnyHandler>;
  sent: any[];
}

function harness(): Harness {
  const tools = new Map<string, AnyTool>();
  const handlers = new Map<string, AnyHandler>();
  const sent: any[] = [];
  const pi = {
    registerTool: (tool: AnyTool) => tools.set(tool.name, tool),
    registerCommand: () => {},
    on: (event: string, handler: AnyHandler) => handlers.set(event, handler),
    sendMessage: (msg: unknown) => sent.push(msg),
  };
  return { pi: pi as unknown as ExtensionAPI, tools, handlers, sent };
}

function makeCtx(cwd: string, hasUI: boolean): ExtensionContext {
  return {
    cwd,
    hasUI,
    ui: {
      setWidget: () => {},
      notify: () => {},
      theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t },
    },
  } as unknown as ExtensionContext;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitFor(pred: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await pred()) return;
    if (Date.now() >= deadline) throw new Error("waitFor: condition not met in time");
    await sleep(25);
  }
}

/** A unique, filesystem-safe session id so each test gets its own registry dir. */
function uniqueSession(): { id: string; regDir: string } {
  const id = `sbgtest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return { id, regDir: join(tmpdir(), "pify-shell-bg", id) };
}

/**
 * Kill every still-running job and wait until nothing runs, so no child process
 * outlives the test and blocks the runner from exiting.
 */
async function teardown(h: Harness, ctx: ExtensionContext): Promise<void> {
  const shutdown = h.handlers.get("session_shutdown");
  if (shutdown) await shutdown({ type: "session_shutdown", reason: "quit" }, ctx);
  const status = h.tools.get("shell_status");
  if (!status) return;
  await waitFor(async () => {
    const list = await status.execute("teardown", {});
    return /^0 running/.test(String(list.content[0].text));
  }, 8000).catch(() => {});
}

test("polling a running job does not cancel its auto-delivery (bug #1)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sbg-ext1-"));
  const { id: sid, regDir } = uniqueSession();
  const prevSid = process.env.PI_SESSION_ID;
  process.env.PI_SESSION_ID = sid;
  const h = harness();
  const ctx = makeCtx(cwd, false);
  try {
    shellBackground(h.pi);
    await h.handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx);

    const bash = h.tools.get("bash")!;
    const shellStatus = h.tools.get("shell_status")!;

    // Launch a background command that takes ~2s to finish.
    const started = await bash.execute("t1", { command: "sleep 2", background: true }, undefined, undefined, ctx);
    const jobId = started.details.id as string;
    assert.ok(jobId, "the launch returned a job id");

    // Poll it while it is still running — this must NOT mark it delivered.
    const polled = await shellStatus.execute("t2", { id: jobId });
    assert.equal(polled.details.status, "running", "job is still running when polled");
    assert.equal(h.sent.length, 0, "nothing delivered while still running");

    // Delivery must still fire when it finishes, because the poll did not cancel
    // it. (Before the fix, the poll set delivered=true and this never arrives, so
    // this waitFor times out and the test fails.)
    await waitFor(() => h.sent.length > 0, 6000);
    assert.equal(h.sent.length, 1, "the finished job was auto-delivered exactly once");
    assert.equal(h.sent[0].customType, DELIVERY_TYPE);
    assert.equal(h.sent[0].details.id, jobId);
  } finally {
    await teardown(h, ctx);
    rmSync(cwd, { recursive: true, force: true });
    rmSync(regDir, { recursive: true, force: true });
    if (prevSid === undefined) delete process.env.PI_SESSION_ID;
    else process.env.PI_SESSION_ID = prevSid;
  }
});

test("a timeout still fires after a command auto-backgrounds (bug #3)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sbg-ext3-"));
  const { id: sid, regDir } = uniqueSession();
  const prevSid = process.env.PI_SESSION_ID;
  const prevMs = process.env.PIFY_SHELL_BG_MS;
  process.env.PI_SESSION_ID = sid;
  // Move to the background quickly so the test does not wait the default 30s.
  process.env.PIFY_SHELL_BG_MS = "200";
  const h = harness();
  const ctx = makeCtx(cwd, true); // hasUI so auto-background is enabled
  try {
    shellBackground(h.pi);
    await h.handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx);

    const bash = h.tools.get("bash")!;
    const shellStatus = h.tools.get("shell_status")!;

    // A command with a 1s timeout that outlives both the 200ms auto-background
    // threshold and the timeout: it must auto-background, then the timeout must
    // survive that move and kill it around the 1s mark (well before it would end
    // on its own).
    const res = await bash.execute("t1", { command: "sleep 3", timeout: 1 }, undefined, undefined, ctx);
    assert.equal(res.details.background, true, "the command was moved to the background");
    const jobId = res.details.id as string;

    // Before the fix the timeout is dropped, so it is still "running" past the
    // 1s deadline; after the fix the surviving timeout kills it.
    await waitFor(async () => (await shellStatus.execute("p", { id: jobId })).details.status !== "running", 6000);
    const final = await shellStatus.execute("f", { id: jobId });
    assert.equal(final.details.status, "killed", "the surviving timeout killed the backgrounded job");
  } finally {
    await teardown(h, ctx);
    rmSync(cwd, { recursive: true, force: true });
    rmSync(regDir, { recursive: true, force: true });
    if (prevSid === undefined) delete process.env.PI_SESSION_ID;
    else process.env.PI_SESSION_ID = prevSid;
    if (prevMs === undefined) delete process.env.PIFY_SHELL_BG_MS;
    else process.env.PIFY_SHELL_BG_MS = prevMs;
  }
});
