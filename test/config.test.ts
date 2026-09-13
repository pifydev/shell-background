import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveSettings, DEFAULT_SETTINGS } from "../src/config.ts";

test("defaults when there is no config", () => {
  const { settings, warnings } = resolveSettings(undefined, {});
  assert.deepEqual(settings, DEFAULT_SETTINGS);
  assert.deepEqual(warnings, []);
});

test("valid overrides are taken", () => {
  const { settings } = resolveSettings({ autoBackgroundMs: 10_000, tailBytes: 8192 }, {});
  assert.equal(settings.autoBackgroundMs, 10_000);
  assert.equal(settings.tailBytes, 8192);
});

test("0 disables auto-background", () => {
  const { settings } = resolveSettings({ autoBackgroundMs: 0 }, {});
  assert.equal(settings.autoBackgroundMs, 0);
});

test("out-of-range and wrong-type values fall back with a warning", () => {
  const { settings, warnings } = resolveSettings({ autoBackgroundMs: 999_999_999, tailBytes: "big" }, {});
  assert.equal(settings.autoBackgroundMs, 3_600_000, "clamped to max");
  assert.equal(settings.tailBytes, DEFAULT_SETTINGS.tailBytes, "kept default");
  assert.ok(warnings.some((w) => w.includes("clamped")));
  assert.ok(warnings.some((w) => w.includes("must be a number")));
});

test("unknown keys warn and are ignored", () => {
  const { warnings } = resolveSettings({ nope: 1 }, {});
  assert.ok(warnings.some((w) => w.includes('unknown setting "nope"')));
});

test("PIFY_SHELL_BG_MS overrides the threshold", () => {
  const { settings } = resolveSettings({ autoBackgroundMs: 30_000 }, { PIFY_SHELL_BG_MS: "5000" });
  assert.equal(settings.autoBackgroundMs, 5_000);
  const bad = resolveSettings(undefined, { PIFY_SHELL_BG_MS: "soon" });
  assert.equal(bad.settings.autoBackgroundMs, DEFAULT_SETTINGS.autoBackgroundMs);
  assert.ok(bad.warnings.some((w) => w.includes("not a number")));
});
