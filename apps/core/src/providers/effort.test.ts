import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEffort, clampToSupported } from "./effort.js";

test("clampToSupported: a supported value passes through unchanged", () => {
  assert.equal(clampToSupported("high", ["low", "high"]), "high");
});

test("clampToSupported: undefined values means the full five-tier scale is accepted", () => {
  assert.equal(clampToSupported("xhigh", undefined), "xhigh");
});

test("clampToSupported: an unsupported top-tier value snaps down to the highest one available", () => {
  assert.equal(clampToSupported("max", ["low", "medium", "high"]), "high");
  assert.equal(clampToSupported("xhigh", ["low", "medium", "high"]), "high");
});

test("clampToSupported: a value with no higher option snaps to the nearest lower one", () => {
  assert.equal(clampToSupported("max", ["low", "high", "xhigh"]), "xhigh");
});

test("clampToSupported: equidistant between two supported values prefers the cheaper (lower) one", () => {
  // "medium" sits exactly between "low" and "high" in EFFORT_ORDER.
  assert.equal(clampToSupported("medium", ["low", "high", "max"]), "low");
});

test("applyEffort: no effort and no effortFamily are both no-ops", () => {
  const opts: { providerOptions?: Record<string, unknown> } = {};
  applyEffort(opts, { id: "x" }, undefined);
  assert.equal(opts.providerOptions, undefined);
  applyEffort(opts, { id: "x", effortFamily: "anthropic" }, undefined);
  assert.equal(opts.providerOptions, undefined);
  applyEffort(opts, { id: "x" }, "high");
  assert.equal(opts.providerOptions, undefined);
});

test("applyEffort: openai-compatible family keys providerOptions by the entry id, not a fixed string", () => {
  const opts: { providerOptions?: Record<string, unknown> } = {};
  applyEffort(opts, { id: "some-vendor", effortFamily: "openai-compatible" }, "low");
  assert.deepEqual(opts.providerOptions, { "some-vendor": { reasoningEffort: "low" } });
});

test("applyEffort: clamps before writing the provider options, not after", () => {
  const opts: { providerOptions?: Record<string, unknown> } = {};
  applyEffort(
    opts,
    { id: "groq", effortFamily: "groq", effortValues: ["low", "medium", "high"] },
    "max",
  );
  assert.deepEqual(opts.providerOptions, { groq: { reasoningEffort: "high" } });
});

test("applyEffort: merges into providerOptions rather than clobbering an existing key", () => {
  const opts: { providerOptions?: Record<string, unknown> } = {
    providerOptions: { anthropic: { somethingElse: true } },
  };
  applyEffort(opts, { id: "anthropic", effortFamily: "anthropic" }, "high");
  assert.deepEqual(opts.providerOptions, {
    anthropic: { somethingElse: true, effort: "high" },
  });
});
