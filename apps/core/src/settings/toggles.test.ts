import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { listSettings, setSetting } from "./toggles.js";

let home: string;
let project: string;
const userFile = () => path.join(home, ".freecode", "settings.json");
const view = (key: string, env: NodeJS.ProcessEnv = {}) =>
  listSettings(project, env).find((s) => s.key === key)!;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "freecode-home-"));
  project = fs.mkdtempSync(path.join(os.tmpdir(), "freecode-proj-"));
  process.env.HOME = home; // os.homedir() reads it per call
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("FREECODE_")) delete process.env[k];
  }
});

test("defaults come from each setting's own reader", () => {
  assert.equal(view("memory.autoRecall").value, "on");
  assert.equal(view("memory.retrievalJudge").value, "off");
  assert.equal(view("checkpoints.enabled").value, "on");
  assert.equal(view("cache.warming").value, "off");
  assert.equal(view("signals.autoPoke.enabled").value, "off");
  assert.equal(view("memory.autoRecall").locked, undefined);
});

test("a write lands in the user file, nested, and the reader sees it", () => {
  setSetting("signals.autoPoke.enabled", "on");
  setSetting("cache.warming", "idle");
  const written = JSON.parse(fs.readFileSync(userFile(), "utf-8"));
  assert.deepEqual(written, { signals: { autoPoke: { enabled: true } }, cache: { warming: "idle" } });
  assert.equal(view("signals.autoPoke.enabled").value, "on");
  assert.equal(view("cache.warming").value, "idle");
});

test("a write keeps every other key in the user file", () => {
  fs.mkdirSync(path.dirname(userFile()), { recursive: true });
  const before = { permissions: { allow: ["Bash(ls:*)"] }, memory: { extractEveryNRuns: 4 } };
  fs.writeFileSync(userFile(), JSON.stringify(before));
  setSetting("memory.autoRecall", "off");
  const after = JSON.parse(fs.readFileSync(userFile(), "utf-8"));
  assert.deepEqual(after, {
    permissions: { allow: ["Bash(ls:*)"] },
    memory: { extractEveryNRuns: 4, autoRecall: false },
  });
});

test("an unparseable user file is never overwritten", () => {
  fs.mkdirSync(path.dirname(userFile()), { recursive: true });
  fs.writeFileSync(userFile(), "{ not json");
  assert.throws(() => setSetting("tasks.notify", "off"), /not valid JSON/);
  assert.equal(fs.readFileSync(userFile(), "utf-8"), "{ not json");
});

test("unknown keys and out-of-list values are refused", () => {
  assert.throws(() => setSetting("memory.nope", "on"), /Unknown setting/);
  assert.throws(() => setSetting("cache.warming", "always"), /must be one of/);
});

test("an env var or a project file locks the setting, with the reason", () => {
  assert.match(
    view("checkpoints.enabled", { FREECODE_CHECKPOINTS: "0" }).locked ?? "",
    /FREECODE_CHECKPOINTS=0/,
  );
  fs.mkdirSync(path.join(project, ".freecode"));
  fs.writeFileSync(
    path.join(project, ".freecode", "settings.json"),
    JSON.stringify({ tasks: { notify: false } }),
  );
  const v = view("tasks.notify");
  assert.equal(v.value, "off");
  assert.match(v.locked ?? "", /project/);
  assert.equal(view("memory.autoRecall").locked, undefined, "other keys stay free");
});
