import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getShellConfig } from "@earendil-works/pi-coding-agent";
import { spawnToFile } from "../src/spawn.ts";
import { readTail } from "../src/tail.ts";
import { killTree } from "../src/kill.ts";

/** Resolve a real shell the same way the extension does. */
function shell(): { shell: string; args: string[] } {
  const c = getShellConfig();
  return { shell: c.shell, args: c.commandTransport === "stdin" ? ["-c"] : [...c.args] };
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

test("spawnToFile writes output to the log and resolves the exit code", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sbg-spawn-"));
  try {
    const log = join(dir, "l.log");
    const { shell: sh, args } = shell();
    const s = spawnToFile(sh, args, "printf 'hello\\nworld\\n'", dir, process.env, log);
    assert.ok(s.pid && s.pid > 0, "has a pid");
    const { code } = await s.exit;
    assert.equal(code, 0);
    await sleep(50);
    assert.match(readTail(log, 65536).text, /hello\nworld/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a long command keeps running until the tree is killed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sbg-kill-"));
  try {
    const log = join(dir, "l.log");
    const { shell: sh, args } = shell();
    const s = spawnToFile(sh, args, "sleep 30", dir, process.env, log);
    let exited = false;
    void s.exit.then(() => {
      exited = true;
    });
    await sleep(300);
    assert.equal(exited, false, "still running after 300ms");
    killTree(s.pid);
    const outcome = await Promise.race([s.exit.then(() => "exited"), sleep(4000).then(() => "timeout")]);
    assert.equal(outcome, "exited", "killTree terminated the command");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("killTree is a safe no-op on invalid pids", () => {
  assert.doesNotThrow(() => {
    killTree(0);
    killTree(null);
    killTree(undefined);
    killTree(-5);
  });
});
