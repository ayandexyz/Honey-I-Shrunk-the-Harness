import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  isBool,
  pickSetting,
  readSettingsFile,
  readSettingsScopes,
  settingsSections,
} from "./load.js";
import { loadMemorySettings } from "../memory/extract-policy.js";
import { PermissionSettingsManager } from "../permission/settings.js";

let home: string;
let project: string;

const write = (root: string, doc: unknown): string => {
  const file = path.join(root, ".freecode", "settings.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof doc === "string" ? doc : JSON.stringify(doc));
  return file;
};

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "freecode-home-"));
  project = fs.mkdtempSync(path.join(os.tmpdir(), "freecode-proj-"));
  process.env.HOME = home; // os.homedir() reads it per call
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("FREECODE_")) delete process.env[k];
  }
});

test("project beats user key by key; what the project leaves out falls through", () => {
  write(home, { memory: { autoExtract: false, extractEveryNRuns: 3 } });
  write(project, { memory: { extractEveryNRuns: 9 } });
  const m = loadMemorySettings(project);
  assert.equal(m.intervalRuns, 9);
  assert.equal(m.autoExtract, false);
});

test("an invalid project value falls through to the user's valid one", () => {
  write(home, { tasks: { notify: false } });
  write(project, { tasks: { notify: "nope" } });
  assert.equal(pickSetting(settingsSections(project, "tasks"), "notify", isBool), false);
});

test("lists accumulate across scopes", () => {
  write(home, { permissions: { allow: ["Grep"], deny: ["Bash(rm:*)"] } });
  write(project, { permissions: { allow: ["Read"] } });
  const rules = new PermissionSettingsManager(project).getRuleSet();
  assert.equal(rules.allow.length, 2);
  assert.equal(rules.deny.length, 1);
});

test("an unparseable file is empty for its scope, not for the other", () => {
  write(home, { memory: { autoRecall: false } });
  write(project, "{ not json");
  assert.deepEqual(readSettingsScopes(project).map((d) => d.scope), ["user"]);
  assert.equal(loadMemorySettings(project).autoRecall, false);
});

test("a project rooted at home reads the one file once, as the user's", () => {
  write(home, { memory: { autoRecall: false } });
  assert.deepEqual(readSettingsScopes(home).map((d) => d.scope), ["user"]);
});

test("a changed file is re-read", () => {
  const file = write(project, { tasks: { notify: true } });
  assert.deepEqual(readSettingsFile(file), { tasks: { notify: true } });
  write(project, { tasks: { notify: false, x: 1 } });
  assert.deepEqual(readSettingsFile(file), { tasks: { notify: false, x: 1 } });
});
