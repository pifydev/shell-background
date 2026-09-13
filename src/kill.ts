/**
 * Kill a shell command and everything it spawned, on every platform.
 *
 * A `bash -c "…"` is a tree: the shell, and whatever it launched. Killing only
 * the shell's own pid orphans the grandchildren, which keep running and keep
 * writing to the log. So we kill the whole tree.
 *
 *  - POSIX: the command is spawned `detached`, which makes its pid a process
 *    group leader, so a signal to the negative pid reaches the group. Send
 *    SIGTERM, then escalate to SIGKILL after a grace period for anything that
 *    ignored the polite signal. Fall back to the bare pid if the group send
 *    fails (e.g. the group already gone).
 *  - Windows: no process groups; `taskkill /T` walks and kills the tree. Use
 *    the absolute System32 path so it works regardless of PATH, spawned with an
 *    error handler so a missing binary can never throw into the caller.
 *
 * Zero dependencies — node:child_process only.
 */
import { spawn } from "node:child_process";

const GRACE_MS = 3000;

export function killTree(pid: number | null | undefined): void {
  if (!pid || pid <= 0) return;

  if (process.platform === "win32") {
    const taskkill = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\taskkill.exe`;
    try {
      spawn(taskkill, ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on(
        "error",
        () => {},
      );
    } catch {
      // A machine without taskkill is not one we can do better on.
    }
    return;
  }

  const signalGroup = (sig: NodeJS.Signals) => {
    try {
      process.kill(-pid, sig);
      return true;
    } catch {
      try {
        process.kill(pid, sig);
        return true;
      } catch {
        return false;
      }
    }
  };

  if (!signalGroup("SIGTERM")) return;
  const timer = setTimeout(() => signalGroup("SIGKILL"), GRACE_MS);
  timer.unref?.();
}
