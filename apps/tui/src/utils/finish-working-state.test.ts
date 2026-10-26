import assert from "node:assert/strict";
import test from "node:test";
import { finishWorkingState } from "./finish-working-state.js";

test("completed runs leave the working state synchronously", () => {
  const removed: number[] = [];

  const elapsed = finishWorkingState(
    (id) => removed.push(id),
    42,
    1_000,
    1_275,
  );

  assert.deepEqual(removed, [42]);
  assert.equal(elapsed, 275);
});

test("a backwards clock cannot produce a negative displayed duration", () => {
  assert.equal(finishWorkingState(() => {}, 42, 2_000, 1_000), 0);
});
