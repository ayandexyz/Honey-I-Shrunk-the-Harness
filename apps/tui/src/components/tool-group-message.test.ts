import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { clearMessages, getMessages } from "../state/message-store.js";
import {
  createToolProgressMessage,
  createToolResultMessage,
  removeToolProgressMessage,
  createAssistantMessage,
  createSystemMessage,
  createUserMessage,
  createInProgressMessage,
  finalizeAssistantText,
  mainTranscript,
  sealToolGroups,
} from "./index.js";
import { ToolGroupMessage } from "./tool-group-message.js";
import { PROGRESS_ROW_DELAY_MS } from "./tool-progress-message.js";

function plain(lines: string[]): string {
  return lines.join("|").replace(/\x1b\[[0-9;]*m/g, "");
}

function addResult(name: string, args: Record<string, unknown>, success = true) {
  return createToolResultMessage(`call-${name}-${Math.random()}`, name, args, "ok", success);
}

test("consecutive tool results share one message and summarize by tool", () => {
  clearMessages();

  addResult("Read", { file_path: "a.ts" });
  addResult("Read", { file_path: "b.ts" });
  addResult("Bash", { command: "ls" });

  const messages = getMessages();
  assert.equal(messages.length, 1);
  const group = messages[0]!.component as ToolGroupMessage;
  assert.ok(group instanceof ToolGroupMessage);
  assert.equal(group.size, 3);

  // Collapsed from the start: the summary is the whole message, live or not.
  assert.doesNotMatch(plain(group.render(80)), /a\.ts/);

  sealToolGroups();
  const collapsed = group.render(80);
  assert.match(plain(collapsed), /Read 2 files, Ran 1 command/);
  assert.doesNotMatch(plain(collapsed), /a\.ts/);
  assert.match(plain(collapsed), /▶ /);
});

test("clicking the summary expands the group back to one row per call", () => {
  clearMessages();
  addResult("Read", { file_path: "a.ts" });
  addResult("Read", { file_path: "b.ts" });
  sealToolGroups();

  const group = getMessages()[0]!.component as ToolGroupMessage;
  group.render(80);
  assert.equal(group.isToggleLine(0), true); // summary is the first row

  group.toggleAt(0);
  const expanded = group.render(80);
  assert.match(plain(expanded), /a\.ts/);
  assert.match(plain(expanded), /b\.ts/);
  assert.match(plain(expanded), /▼ /);
});

test("a failed call marks the summary", () => {
  clearMessages();
  addResult("Bash", { command: "false" }, false);
  sealToolGroups();

  const group = getMessages()[0]!.component as ToolGroupMessage;
  assert.match(plain(group.render(80)), /Ran 1 command \(1 failed\)/);
});

test("an unknown tool falls back to a count instead of invented grammar", () => {
  clearMessages();
  addResult("mcp__thing__do", {});
  addResult("mcp__thing__do", {});
  sealToolGroups();

  const group = getMessages()[0]!.component as ToolGroupMessage;
  assert.match(plain(group.render(80)), /mcp__thing__do ×2/);
});

test("a still-running sibling tool does not split the group", () => {
  clearMessages();
  addResult("Read", { file_path: "a.ts" });
  // Parallel batch: a second tool is still streaming when the first result lands.
  createToolProgressMessage("call-live", "Bash", { command: "sleep 1" });
  addResult("Read", { file_path: "b.ts" });

  const groups = getMessages().filter((m) => m.component instanceof ToolGroupMessage);
  assert.equal(groups.length, 1);
  assert.equal((groups[0]!.component as ToolGroupMessage).size, 2);
});

test("an assistant reply seals the group, so the next call starts a new one", () => {
  clearMessages();
  addResult("Read", { file_path: "a.ts" });
  createAssistantMessage("done");
  addResult("Read", { file_path: "b.ts" });

  const groups = getMessages().filter((m) => m.component instanceof ToolGroupMessage);
  assert.equal(groups.length, 2);
  assert.equal((groups[0]!.component as ToolGroupMessage).isSealed, true);
});

test("ambient system notices do not split a run into one group per call", () => {
  clearMessages();
  addResult("Bash", { command: "ls" });
  // Every turn emits a cache-status line between tool calls.
  createSystemMessage("*Prompt cache hit: 13,440 tokens read*");
  addResult("Bash", { command: "pwd" });
  createSystemMessage("⚠ **Prompt-cache miss**");
  addResult("Read", { file_path: "a.ts" });
  sealToolGroups();

  const groups = getMessages().filter((m) => m.component instanceof ToolGroupMessage);
  assert.equal(groups.length, 1);
  assert.match(
    plain((groups[0]!.component as ToolGroupMessage).render(80)),
    /Ran 2 commands, Read 1 file/,
  );
});

test("expanding a child inside the group adds no blank framing rows", () => {
  clearMessages();
  addResult("Read", { file_path: "a.ts" });
  // Multi-line output so the child, once expanded, has a real body.
  createToolResultMessage("call-ls", "ls", { path: "/tmp" }, "one\ntwo\nthree", true);
  sealToolGroups();

  const group = getMessages()[0]!.component as ToolGroupMessage;
  group.toggle(); // expand the group
  let lines = group.render(80);

  // Expand the ls child by clicking its header row.
  const lsHeader = lines.findIndex((l) => plain([l]).includes("ls(") );
  assert.ok(lsHeader > 0);
  assert.equal(group.isToggleLine(lsHeader), true);
  group.toggleAt(lsHeader);

  lines = group.render(80);
  // The expanded child's standalone blank framing must not leak into the
  // stacked list.
  const blanks = lines.filter((l) => l === "").length;
  assert.equal(blanks, 0);
  assert.match(plain(lines), /one/);
});

test("file updates stand alone outside groups and split the run", () => {
  clearMessages();
  addResult("Read", { file_path: "a.ts" });
  addResult("Edit", { file_path: "c.ts" });
  addResult("Bash", { command: "ls" });

  const messages = getMessages();
  assert.equal(messages.length, 3);
  assert.ok(messages[0]!.component instanceof ToolGroupMessage);
  assert.ok(!(messages[1]!.component instanceof ToolGroupMessage));
  // The edit sealed the first group, so bash starts a fresh one.
  assert.ok(messages[2]!.component instanceof ToolGroupMessage);
  assert.notEqual(messages[0]!.component, messages[2]!.component);
});

test("a running call is drawn inside the open group, not as a row below it", () => {
  clearMessages();
  mock.timers.enable({ apis: ["Date"] });
  try {
    addResult("Read", { file_path: "a.ts" });
    const { message, progress } = createToolProgressMessage("call-live", "ls", { path: "src" });

    // One store entry: the group. No standalone progress message appeared.
    assert.equal(getMessages().length, 1);
    assert.equal(message.component, getMessages()[0]!.component);
    // Just started: only the summary, so a call that finishes at once never
    // flashes a row under it.
    const fresh = plain((message.component as ToolGroupMessage).render(80));
    assert.match(fresh, /Read 1 file/);
    assert.doesNotMatch(fresh, /path: src/);

    mock.timers.tick(PROGRESS_ROW_DELAY_MS);
    const before = plain((message.component as ToolGroupMessage).render(80));
    assert.match(before, /Read 1 file/);
    assert.match(before, /ls.*path: src/);

    removeToolProgressMessage(message, progress);
    createToolResultMessage("call-live", "ls", { path: "src" }, "a.ts", true);
    assert.equal(getMessages().length, 1);
    const after = plain((message.component as ToolGroupMessage).render(80));
    assert.match(after, /Read 1 file, Listed 1 directory/);
    assert.doesNotMatch(after, /path: src/);
  } finally {
    mock.timers.reset();
  }
});

test("a group that opens right under the prompt is set off by a blank row", () => {
  clearMessages();
  createUserMessage("this project is about?");
  createInProgressMessage("Thinking");
  addResult("Read", { file_path: "a.ts" });
  addResult("Read", { file_path: "b.ts" });

  const group = getMessages().find((m) => m.component instanceof ToolGroupMessage)!;
  const lines = group.component.render(80);
  assert.equal(lines[0], "");
  assert.match(plain(lines), /Read 2 files/);

  // After a reply, the next group is not the first thing under the prompt.
  createAssistantMessage("done");
  addResult("Read", { file_path: "c.ts" });
  const next = getMessages().filter((m) => m.component instanceof ToolGroupMessage)[1]!;
  assert.notEqual(next.component.render(80)[0], "");
});

test("tool preambles fold into one dim line while the final answer stays", () => {
  clearMessages();
  createUserMessage("fix it");
  createInProgressMessage("Thinking");

  // The first internal turn narrates the call. Once the call starts, that
  // prose should stop occupying its own assistant row.
  const first = finalizeAssistantText("Now reading the controller.\nPlease wait.");
  assert.ok(first);
  const started = createToolProgressMessage("call-read", "Read", {
    file_path: "controller.ts",
  });
  removeToolProgressMessage(started.message, started.progress);
  createToolResultMessage(
    "call-read",
    "Read",
    { file_path: "controller.ts" },
    "contents",
    true,
  );

  // A second preamble joins the same compact line and does not split the run.
  finalizeAssistantText("Re-running the tests.");
  const second = createToolProgressMessage("call-test", "Bash", {
    command: "pnpm test",
  });
  removeToolProgressMessage(second.message, second.progress);
  createToolResultMessage(
    "call-test",
    "Bash",
    { command: "pnpm test" },
    "ok",
    true,
  );

  const groups = getMessages().filter((m) => m.component instanceof ToolGroupMessage);
  assert.equal(groups.length, 1);
  const rendered = plain(groups[0]!.component.render(100));
  assert.match(rendered, /Read 1 file, Ran 1 command/);
  assert.match(
    rendered,
    /Now reading the controller\. Please wait\. · Re-running the tests\./,
  );

  // With no following tool_start, terminal prose remains a normal full row.
  finalizeAssistantText("Everything passes. Here is the full result.");
  const assistants = getMessages().filter((m) => m.type === "assistant");
  assert.equal(assistants.length, 1);
  assert.match(assistants[0]!.content, /Everything passes/);
});

test("a file-update preamble moves into its diff card", () => {
  clearMessages();
  finalizeAssistantText("Now updating the controller.");

  mainTranscript.apply({
    type: "tool_start",
    toolCallId: "call-edit",
    toolName: "Edit",
    args: { file_path: "controller.ts" },
  });
  mainTranscript.apply({
    type: "tool_complete",
    toolCallId: "call-edit",
    toolName: "Edit",
    result: "+ 1 changed",
    success: true,
  });

  const messages = getMessages();
  assert.equal(messages.filter((m) => m.type === "assistant").length, 0);
  const rendered = plain(messages.at(-1)!.component.render(100));
  assert.match(rendered, /Now updating the controller\./);
  assert.match(rendered, /Update\(/);
  assert.match(rendered, /controller\.ts/);
});
