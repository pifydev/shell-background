import { test } from "node:test";
import assert from "node:assert/strict";
import { backgroundedResult, deliveryMessage, DELIVERY_TYPE } from "../src/pending.ts";

const base = { id: "bg-1", command: "npm run build", collectWith: "shell_status" };

test("interactive: promises delivery and does not require polling", () => {
  const r = backgroundedResult({ ...base, elapsedMs: 30_000, auto: true, interactive: true });
  assert.equal(r.details.pollRequired, false);
  assert.equal(r.details.background, true);
  assert.match(r.text, /still running after 30s — moved to the background/);
  assert.match(r.text, /delivered here automatically/);
});

test("headless: no delivery, must collect within the turn", () => {
  const r = backgroundedResult({ ...base, elapsedMs: 30_000, auto: true, interactive: false });
  assert.equal(r.details.pollRequired, true);
  assert.match(r.text, /headless run/);
  assert.match(r.text, /again in this same turn/);
  assert.ok(!/delivered here automatically/.test(r.text));
});

test("explicit background reads differently from auto", () => {
  const explicit = backgroundedResult({ ...base, elapsedMs: 0, auto: false, interactive: true });
  assert.match(explicit.text, /started in the background/);
  assert.equal(explicit.details.auto, false);
});

test("the command is shown and clipped", () => {
  const long = "x".repeat(200);
  const r = backgroundedResult({ ...base, command: long, elapsedMs: 0, auto: false, interactive: true });
  assert.match(r.text, /\$ x+…/);
});

test("delivery message wraps the body and explains itself", () => {
  const m = deliveryMessage("bg-2", "  build ok  ");
  assert.match(m, /<shell_background_result id="bg-2">/);
  assert.match(m, /<\/shell_background_result>/);
  assert.match(m, /build ok/);
  assert.ok(!m.includes("  build ok  "), "body is trimmed");
  assert.match(m, /sent to the background/);
});

test("delivery type is stable", () => {
  assert.equal(DELIVERY_TYPE, "pify-shell-background-result");
});
