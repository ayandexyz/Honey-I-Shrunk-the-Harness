import test from "node:test";
import assert from "node:assert/strict";
import { summarizeMessages } from "./summarizer.js";
import type { MemoryMessage } from "./types.js";

function msg(
  id: string,
  role: MemoryMessage["role"],
  content: string,
): MemoryMessage {
  return {
    id,
    role,
    content,
    tokenCount: Math.ceil(content.length / 4),
    timestamp: Number(id),
  };
}

test("summarizeMessages creates an anchored continuation summary", () => {
  const summary = summarizeMessages({
    sessionId: "session-1",
    previousSummary: undefined,
    messages: [
      msg("1", "user", "Add memory compaction to apps/core/src/agent/loop.ts"),
      msg("2", "assistant", "Implemented selector and storage"),
    ],
  });

  assert.match(summary.content, /## Goal/);
  assert.match(summary.content, /memory compaction/);
  assert.match(summary.content, /## Recent Progress/);
  assert.equal(summary.originalMessageCount, 2);
});

test("summarizeMessages carries previous summary forward", () => {
  const summary = summarizeMessages({
    sessionId: "session-1",
    previousSummary: "## Goal\n- Build memory safely",
    messages: [msg("3", "user", "Now wire it into prompts")],
  });

  assert.match(summary.content, /Previous Summary/);
  assert.match(summary.content, /Build memory safely/);
  assert.match(summary.content, /wire it into prompts/);
});

// Sessions 50f4745d / 8b4b7a32 / 181c471a: every compaction fell back to this
// summarizer, which wrote "Continue the current coding session", filed reads
// of code mentioning "error" under Blocked, and kept nothing any read found.
const transcript = [
  msg(
    "2",
    "assistant",
    [
      'Tool read: {"filePath":"/p/apps/core/src/server.ts"} -> function resolveProviderModel(session) { // global config.current wins over session.model; throw new Error("no provider") }',
      'Tool grep: {"pattern":"setCurrentModel"} -> apps/tui/src/index.ts-92- setCurrentModel(provider, model)',
    ].join("\n"),
  ),
  msg("3", "assistant", 'Tool bash: {"command":"pnpm test"} -> failed: exit 1: 2 tests failing in session.test.ts'),
];

test("the goal is the preserved founding request when it is not in the summarized set", () => {
  const summary = summarizeMessages({
    sessionId: "s",
    messages: transcript,
    goal: "can i have multiple sessions with multiple models??",
  });
  assert.match(summary.content, /## Goal\n- can i have multiple sessions with multiple models\?\?/);
  assert.doesNotMatch(summary.content, /Continue the current coding session/);
});

test("tool output mentioning 'error' is a finding, not a blocker; a failed call is a blocker", () => {
  const content = summarizeMessages({ sessionId: "s", messages: transcript }).content;
  const blocked = content.split("## Blocked")[1]!.split("\n## ")[0]!;
  assert.match(blocked, /pnpm test.*failed: exit 1/);
  assert.doesNotMatch(blocked, /resolveProviderModel/);
  const findings = content.split("## Recent Findings")[1]!.split("\n## ")[0]!;
  assert.match(findings, /global config\.current wins over session\.model/);
  assert.match(findings, /setCurrentModel/);
});

test("relevant files drop read envelopes and grep line markers", () => {
  const content = summarizeMessages({
    sessionId: "s",
    messages: [
      msg("4", "assistant", 'Tool read: {"filePath":"x"} -> <path>apps/core/src/server.ts</path> apps/tui/src/index.ts-92- apps/core/src/a.ts:12: x'),
    ],
  }).content;
  const files = content.split("## Relevant Files")[1]!.split("\n## ")[0]!;
  assert.match(files, /- apps\/core\/src\/server\.ts\n/);
  assert.match(files, /- apps\/tui\/src\/index\.ts\n/);
  assert.match(files, /- apps\/core\/src\/a\.ts/);
  assert.doesNotMatch(files, /<\/path>|-92-|:12:/);
});
