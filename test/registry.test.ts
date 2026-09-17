import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobRegistry } from "../src/registry.ts";

function baseDir(): string {
  return mkdtempSync(join(tmpdir(), "sbg-reg-"));
}

test("ids are session-monotonic and logPath is under the base dir", () => {
  const dir = baseDir();
  try {
    const r = new JobRegistry(dir);
    const a = r.create("echo a", "/x");
    const b = r.create("echo b", "/x");
    assert.equal(a.id, "bg-1");
    assert.equal(b.id, "bg-2");
    assert.ok(a.logPath.includes("logs"));
    assert.equal(r.running().length, 2);
    assert.equal(r.get("bg-2")?.command, "echo b");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("persist writes a sidecar and load restores + continues the counter", () => {
  const dir = baseDir();
  try {
    const r1 = new JobRegistry(dir);
    const j = r1.create("sleep 1", "/x");
    j.pid = 999_999_999; // almost certainly not a live pid
    r1.persist(j);
    assert.ok(readdirSync(dir).some((f) => f === "bg-1.json"));

    // Fresh registry over the same dir: reconcile the dead running job to done,
    // and keep numbering after the highest restored id.
    const r2 = new JobRegistry(dir);
    r2.load();
    const restored = r2.get("bg-1");
    assert.ok(restored);
    assert.equal(restored!.status, "done", "a running job with a dead pid settles");
    assert.equal(r2.create("echo next", "/x").id, "bg-2", "counter continues past restored ids");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a running record from another host pid is orphaned, not adopted (finding f072)", () => {
  const dir = baseDir();
  try {
    // A sidecar left by a different (or since-crashed) host, whose pid happens to
    // be live and — worst case — is *ours*. It must never be treated as running,
    // or session_shutdown would killTree a pid this host did not spawn.
    const foreign = {
      id: "bg-1",
      command: "sleep 999",
      cwd: "/x",
      pid: process.pid,
      hostPid: process.pid + 100_000, // a host that is not this one
      status: "running",
      exitCode: null,
      signal: null,
      logPath: join(dir, "logs", "bg-1.log"),
      startedAt: Date.now(),
      endedAt: null,
      auto: false,
      delivered: false,
    };
    writeFileSync(join(dir, "bg-1.json"), JSON.stringify(foreign));
    const r = new JobRegistry(dir);
    r.load();
    assert.equal(r.get("bg-1")?.status, "orphaned", "a foreign-host running record is marked orphaned");
    assert.equal(r.running().length, 0, "and excluded from running() so it is never killed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a running record with no hostPid (pre-upgrade) is treated as foreign", () => {
  const dir = baseDir();
  try {
    const old = {
      id: "bg-1",
      command: "x",
      cwd: "/x",
      pid: process.pid,
      status: "running",
      exitCode: null,
      signal: null,
      logPath: join(dir, "logs", "bg-1.log"),
      startedAt: Date.now(),
      endedAt: null,
      auto: false,
      delivered: false,
    };
    writeFileSync(join(dir, "bg-1.json"), JSON.stringify(old));
    const r = new JobRegistry(dir);
    r.load();
    assert.equal(r.get("bg-1")?.status, "orphaned");
    assert.equal(r.running().length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("load tolerates a corrupt sidecar", () => {
  const dir = baseDir();
  try {
    const r = new JobRegistry(dir);
    writeFileSync(join(dir, "bg-9.json"), "{not json");
    assert.doesNotThrow(() => r.load());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
