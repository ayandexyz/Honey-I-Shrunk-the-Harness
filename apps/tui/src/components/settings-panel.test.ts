import test from "node:test";
import assert from "node:assert/strict";
import { toSettingItems } from "./settings-panel.js";

const base = { label: "Checkpoints", description: "Snapshot each turn.", values: ["on", "off"], value: "on" };

test("a free setting cycles through its values", () => {
  const [item] = toSettingItems([{ key: "checkpoints.enabled", ...base }]);
  assert.deepEqual(item!.values, ["on", "off"]);
  assert.equal(item!.currentValue, "on");
});

test("a locked setting cannot cycle and says why", () => {
  const [item] = toSettingItems([
    { key: "checkpoints.enabled", ...base, locked: "Set by FREECODE_CHECKPOINTS=0" },
  ]);
  assert.equal(item!.values, undefined);
  assert.equal(item!.currentValue, "on (locked)");
  assert.match(item!.description!, /FREECODE_CHECKPOINTS=0/);
});
