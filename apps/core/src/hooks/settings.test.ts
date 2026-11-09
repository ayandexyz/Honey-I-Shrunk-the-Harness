// =============================================================================
// settings.json hooks — scopes and hook types.
// A launcher (a board, a CI wrapper, an editor) hands one process its own hooks
// through FREECODE_SETTINGS, the way `claude --settings` and OPENCODE_CONFIG
// work, without writing into the project or the user's own settings.
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { HookSettingsManager } from "./settings.js";
import { getHooksForEvent, unregisterAllHooks } from "./registry.js";
import type { HttpHook } from "./types.js";

function project(hooks?: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "freecode-hook-settings-"));
  if (hooks) {
    mkdirSync(join(root, ".freecode"), { recursive: true });
    writeFileSync(join(root, ".freecode", "settings.json"), JSON.stringify({ hooks }));
  }
  return root;
}

function settingsFile(hooks: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "freecode-launch-settings-"));
  const file = join(dir, "settings.json");
  writeFileSync(file, JSON.stringify({ hooks }));
  return file;
}

function stopHooks() {
  return getHooksForEvent("Stop").filter((h) => h.source === "settings");
}

const boardHttp = {
  hooks: [
    {
      type: "http",
      url: "http://127.0.0.1:9/hooks/s1",
      headers: { "X-Launch": "$LAUNCH_ID" },
      allowedEnvVars: ["LAUNCH_ID"],
      timeout: 5,
    },
  ],
};

test("launch settings from a file are registered", () => {
  unregisterAllHooks("settings");
  const manager = new HookSettingsManager(project(), {
    launchSettings: settingsFile({ Stop: [{ command: "true" }] }),
  });
  try {
    assert.equal(stopHooks().length, 1);
  } finally {
    manager.dispose();
    unregisterAllHooks("settings");
  }
});

test("launch settings may be an inline JSON document", () => {
  unregisterAllHooks("settings");
  const manager = new HookSettingsManager(project(), {
    launchSettings: JSON.stringify({ hooks: { Stop: [{ command: "true" }] } }),
  });
  try {
    assert.equal(stopHooks().length, 1);
  } finally {
    manager.dispose();
    unregisterAllHooks("settings");
  }
});

test("launch hooks are added alongside the project's, not over them", () => {
  unregisterAllHooks("settings");
  const manager = new HookSettingsManager(
    project({ Stop: [{ hooks: [{ command: "echo project" }] }] }),
    { launchSettings: settingsFile({ Stop: [{ hooks: [{ command: "echo launch" }] }] }) },
  );
  try {
    const commands = stopHooks().map((h) => (h.command as { command: string }).command);
    assert.deepEqual(commands.sort(), ["echo launch", "echo project"]);
  } finally {
    manager.dispose();
    unregisterAllHooks("settings");
  }
});

test("a named launch hook overrides the project hook of the same name", () => {
  unregisterAllHooks("settings");
  const manager = new HookSettingsManager(
    project({ Stop: [{ name: "notify", command: "echo project" }] }),
    { launchSettings: settingsFile({ Stop: [{ name: "notify", command: "echo launch" }] }) },
  );
  try {
    const hooks = stopHooks();
    assert.equal(hooks.length, 1);
    assert.equal((hooks[0].command as { command: string }).command, "echo launch");
  } finally {
    manager.dispose();
    unregisterAllHooks("settings");
  }
});

test("http entries register as http hooks", () => {
  unregisterAllHooks("settings");
  const manager = new HookSettingsManager(project(), {
    launchSettings: settingsFile({ Stop: [boardHttp] }),
  });
  try {
    const hooks = stopHooks();
    assert.equal(hooks.length, 1);
    const command = hooks[0].command as HttpHook;
    assert.equal(command.type, "http");
    assert.equal(command.url, "http://127.0.0.1:9/hooks/s1");
    assert.deepEqual(command.headers, { "X-Launch": "$LAUNCH_ID" });
    assert.deepEqual(command.allowedEnvVars, ["LAUNCH_ID"]);
    assert.equal(command.timeout, 5);
  } finally {
    manager.dispose();
    unregisterAllHooks("settings");
  }
});

test("an http entry without a url is skipped", () => {
  unregisterAllHooks("settings");
  const manager = new HookSettingsManager(project(), {
    launchSettings: settingsFile({ Stop: [{ hooks: [{ type: "http" }] }] }),
  });
  try {
    assert.equal(stopHooks().length, 0);
  } finally {
    manager.dispose();
    unregisterAllHooks("settings");
  }
});

test("an unsupported hook type is skipped", () => {
  unregisterAllHooks("settings");
  const manager = new HookSettingsManager(project(), {
    launchSettings: settingsFile({ Stop: [{ hooks: [{ type: "mcp_tool", command: "x" }] }] }),
  });
  try {
    assert.equal(stopHooks().length, 0);
  } finally {
    manager.dispose();
    unregisterAllHooks("settings");
  }
});

test("a missing launch settings file registers nothing and does not throw", () => {
  unregisterAllHooks("settings");
  const manager = new HookSettingsManager(project(), {
    launchSettings: join(tmpdir(), "freecode-no-such-settings.json"),
  });
  try {
    assert.equal(stopHooks().length, 0);
  } finally {
    manager.dispose();
    unregisterAllHooks("settings");
  }
});

test("FREECODE_SETTINGS is the default launch scope", () => {
  unregisterAllHooks("settings");
  const previous = process.env.FREECODE_SETTINGS;
  process.env.FREECODE_SETTINGS = settingsFile({ Stop: [{ command: "true" }] });
  const manager = new HookSettingsManager(project());
  try {
    assert.equal(stopHooks().length, 1);
  } finally {
    manager.dispose();
    if (previous === undefined) delete process.env.FREECODE_SETTINGS;
    else process.env.FREECODE_SETTINGS = previous;
    unregisterAllHooks("settings");
  }
});
