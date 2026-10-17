import assert from "node:assert/strict";
import test from "node:test";

import { percentile, resultFromSamples, summarize } from "./metrics.js";

test("percentiles interpolate a deterministic sorted distribution", () => {
  const values = [40, 10, 30, 20];
  assert.equal(percentile(values, 0.5), 25);
  assert.equal(percentile(values, 0.75), 32.5);
  assert.equal(percentile(values, 0.95), 38.5);
});

test("empty summaries are explicit zeroes", () => {
  assert.deepEqual(summarize([]), {
    min: 0,
    p50: 0,
    p75: 0,
    p95: 0,
    max: 0,
  });
});

test("resultFromSamples retains layer and work attribution", () => {
  const result = resultFromSamples("stream", "frontend", [1, 2, 3], {
    renders: 4,
  });
  assert.equal(result.samples, 3);
  assert.equal(result.distribution.p50, 2);
  assert.deepEqual(result.work, { renders: 4 });
});
