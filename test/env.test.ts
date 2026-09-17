/**
 * The spawn environment helper (finding f074): a backgrounded command must get
 * the same PATH (with pi's managed bin dir) and PI_* session vars pi's own bash
 * hands its child, not a raw process.env — otherwise `fd`/`rg` and every
 * PI_SESSION_* the guidelines promise are missing. Pure, so it tests standalone.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { delimiter } from "node:path";
import { buildEnv } from "../src/env.ts";

test("buildEnv prepends the bin dir to PATH, once", () => {
  const env = buildEnv({}, "/agent/bin", { PATH: "/usr/bin" });
  assert.equal(env.PATH, `/agent/bin${delimiter}/usr/bin`);

  // Already present → not prepended again.
  const already = buildEnv({}, "/agent/bin", { PATH: `/agent/bin${delimiter}/usr/bin` });
  assert.equal(already.PATH, `/agent/bin${delimiter}/usr/bin`);
});

test("buildEnv finds a case-insensitive PATH key (Windows 'Path')", () => {
  const env = buildEnv({}, "C:\\agent\\bin", { Path: "C:\\Windows" });
  assert.equal(env.Path, `C:\\agent\\bin${delimiter}C:\\Windows`);
  assert.equal(env.PATH, undefined, "did not create a second, ignored PATH key");
});

test("buildEnv sets the PI_* session vars from ctx", () => {
  const env = buildEnv(
    {
      sessionManager: { getSessionId: () => "sess-1", getSessionFile: () => "/s/file.json" },
      model: { provider: "anthropic", id: "opus" },
      thinkingLevel: "high",
    },
    "/agent/bin",
    { PATH: "/usr/bin" },
  );
  assert.equal(env.PI_SESSION_ID, "sess-1");
  assert.equal(env.PI_SESSION_FILE, "/s/file.json");
  assert.equal(env.PI_PROVIDER, "anthropic");
  assert.equal(env.PI_MODEL, "opus");
  assert.equal(env.PI_REASONING_LEVEL, "high");
});

test("buildEnv omits absent optional PI_* vars", () => {
  const env = buildEnv(
    { sessionManager: { getSessionId: () => "s", getSessionFile: () => undefined } },
    "/agent/bin",
    { PATH: "/usr/bin" },
  );
  assert.equal(env.PI_SESSION_ID, "s");
  assert.equal(env.PI_SESSION_FILE, undefined);
  assert.equal(env.PI_PROVIDER, undefined);
  assert.equal(env.PI_MODEL, undefined);
  assert.equal(env.PI_REASONING_LEVEL, undefined);
});

test("buildEnv degrades to plain env when a stale ctx throws", () => {
  const env = buildEnv(
    {
      sessionManager: {
        getSessionId: () => {
          throw new Error("ctx is stale after /reload");
        },
      },
    },
    "/agent/bin",
    { PATH: "/usr/bin" },
  );
  assert.equal(env.PI_SESSION_ID, undefined, "no session id, but no crash either");
  assert.equal(env.PATH, `/agent/bin${delimiter}/usr/bin`, "PATH is still built");
});
