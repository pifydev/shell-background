/**
 * The environment a backgrounded command is spawned with.
 *
 * pi's own bash does not hand the child a raw `process.env`: it starts from
 * `getShellEnv()` (process.env with `<agentDir>/bin` — where pi auto-installs
 * `fd`/`rg` — prepended to PATH) and, since exposeSessionEnvironment defaults on,
 * sets PI_SESSION_ID / PI_SESSION_FILE / PI_PROVIDER / PI_MODEL /
 * PI_REASONING_LEVEL from the session ctx. The pi host never sets those PI_*
 * vars in its own process.env (it injects them only into its bash tool's child),
 * so a command spawned with plain `process.env` sees none of them and cannot
 * resolve the managed `fd`/`rg` — despite the inherited description/guidelines
 * promising both. This rebuilds the same env so a backgrounded command behaves
 * like a foreground one.
 *
 * Pure and pi-free (the binDir and a minimal ctx shape are passed in) so it unit
 * tests standalone. Zero dependencies — node:path only.
 */
import { delimiter } from "node:path";

/** The slice of the pi ExtensionContext this needs, kept structural for tests. */
export interface EnvCtx {
  sessionManager?: { getSessionId?(): string; getSessionFile?(): string | undefined };
  model?: { provider?: string; id?: string } | undefined;
  thinkingLevel?: string | undefined;
}

/**
 * Copy `base`, prepend `binDir` to PATH when absent, and set the PI_* session
 * variables from `ctx`. The ctx reads are wrapped so a stale ctx after a
 * `/reload` degrades to plain env rather than failing the spawn.
 */
export function buildEnv(
  ctx: EnvCtx,
  binDir: string,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };

  // PATH is case-insensitive on Windows; find the real key so we do not create a
  // second, ignored "PATH" alongside an inherited "Path". Only prepend when the
  // bin dir is not already on it (mirrors pi's getShellEnv hasBinDir check).
  if (binDir) {
    const pathKey = Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "PATH";
    const current = env[pathKey] ?? "";
    const entries = current.split(delimiter).filter(Boolean);
    if (!entries.includes(binDir)) {
      env[pathKey] = [binDir, current].filter(Boolean).join(delimiter);
    }
  }

  try {
    const sid = ctx.sessionManager?.getSessionId?.();
    if (sid) env.PI_SESSION_ID = sid;
    const sessionFile = ctx.sessionManager?.getSessionFile?.();
    if (sessionFile) env.PI_SESSION_FILE = sessionFile;
    const model = ctx.model;
    if (model) {
      if (model.provider) env.PI_PROVIDER = model.provider;
      if (model.id) env.PI_MODEL = model.id;
    }
    if (ctx.thinkingLevel) env.PI_REASONING_LEVEL = ctx.thinkingLevel;
  } catch {
    // Stale ctx (e.g. read after /reload): a plain env still runs the command.
  }

  return env;
}
