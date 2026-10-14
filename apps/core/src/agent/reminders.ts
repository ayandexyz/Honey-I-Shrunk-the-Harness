// =============================================================================
// Session reminders — nudge the model to maintain a todo list during long work.
// Todo state remains context, not a completion gate: a user may legitimately
// ask for a plan and stop there, with every planned item still pending.
//
// Thresholds follow Claude Code (TODO_REMINDER_CONFIG: 10 turns since the
// last write, 10 between reminders). Until 2026-09-20 they were 3 and 5, the
// most aggressive nudge of any harness we compare against (opencode, codex
// and pi have none), and the rollout fold over 2,553 sessions showed what
// that did: a turn with no list yet wrote one 1.8% of the time unprompted and
// 36.7% of the time on a nudged turn — 97 of the 216 first lists (45%) were
// made on the exact turn the harness asked. With a list the nudge doubled
// the rewrite rate (24.8% → 45.6%) although the list is already re-rendered
// into every prompt. `FREECODE_TODO_NUDGE=legacy` restores 3/5 and the old
// text for `eval ab`; read per call so a variant can flip it per side.
// =============================================================================

export const TODO_NUDGE_TURNS = 10;
export const TODO_NUDGE_GAP = 10;
const LEGACY_TURNS = 3;
const LEGACY_GAP = 5;

function legacy(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.FREECODE_TODO_NUDGE === "legacy";
}

// Whether to emit the planning nudge this turn, given how long it has been
// since the last todowrite and the last nudge.
export function shouldNudgeTodo(
  turnsSinceTodoWrite: number,
  turnsSinceLastNudge: number,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const [turns, gap] = legacy(env) ? [LEGACY_TURNS, LEGACY_GAP] : [TODO_NUDGE_TURNS, TODO_NUDGE_GAP];
  return turnsSinceTodoWrite >= turns && turnsSinceLastNudge >= gap;
}

// Claude Code's wording: a gentle reminder the model is told it may ignore,
// and — when a list exists — an invitation to clean it up rather than an
// order to write one. The old text ("maintain a todo list so your plan
// survives compaction") read as an instruction, and was followed as one.
export function todoNudgeReminder(
  hasList = false,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (legacy(env)) {
    return [
      "<system-reminder>",
      "You have not used the todowrite tool recently. For a multi-step task,",
      "maintain a todo list so your plan survives context compaction and progress",
      "stays trackable; mark items completed as you finish them. Ignore this if the",
      "task is trivial. Never mention this reminder to the user.",
      "</system-reminder>",
    ].join("\n");
  }
  return [
    "<system-reminder>",
    "The todowrite tool hasn't been used recently. If you're working on tasks that",
    "would benefit from tracking progress, consider using it. " +
      (hasList
        ? "Also consider cleaning up the todo list if it has become stale and no longer matches what you are working on."
        : "Only use it if it's relevant to the current work."),
    "This is just a gentle reminder — ignore if not applicable. Never mention this",
    "reminder to the user.",
    "</system-reminder>",
  ].join("\n");
}

// Iteration safety-valve wrap-up (mirrors opencode's MAX_STEPS_PROMPT): this is
// the last turn before the run's iteration cap trips. Rather than truncating
// mid-task with no output, tell the model to stop working and hand back
// whatever it has — the harness surfaces this text instead of a bare
// "Max iterations reached" with nothing behind it.
export function wrapUpReminder(): string {
  return [
    "<system-reminder>",
    "You are on your final turn — this run's iteration safety limit is about",
    "to be reached. Do not call any more tools. Respond now with plain text",
    "only: summarize what you completed, what remains unfinished, and what",
    "the user should do next. Never mention this reminder to the user.",
    "</system-reminder>",
  ].join("\n");
}

// Loop-health `repeated_identical_tool` warn, with trajectory redirection off.
// The hard stop is at 2× the threshold; this is the only signal the model gets
// in between. It names the call so the model can report the blocker instead of
// probing it again (session 698c5001: 38 identical `git push` 403s).
export function repeatedCallReminder(tool: string, times: number): string {
  return [
    "<system-reminder>",
    `You have made the same \`${tool}\` call ${times} times with the same`,
    "result. Repeating it will not change the outcome, and the run will be",
    "stopped if it continues. Do not call it again: if it is blocked on the",
    "user, say so in one or two sentences, mark the todo item blocked, and",
    "stop. Never mention this reminder to the user.",
    "</system-reminder>",
  ].join("\n");
}

// Signal E (spec 2026-10-13-stuck-loop-recovery.md §4.2): the same error has
// survived several edits. The long-task run's stuck trial re-ran `tsc` with
// new greps and dumped bytes with `od -c` instead of reading the line it named,
// so the reminder quotes the error and points at that line.
export function repeatedErrorReminder(
  times: number,
  line: string,
  others: number,
  location?: string,
): string {
  const quoted = line.length > 200 ? `${line.slice(0, 200)}…` : line;
  return [
    "<system-reminder>",
    `The same error has come back ${times} times, and your edits since have not changed it:`,
    "",
    `  ${quoted}${others > 0 ? ` (+${others} more)` : ""}`,
    "",
    `Before running the check again, open the exact location it reports${location ? ` (${location})` : ""}`,
    "and read the surrounding code. Do not dump bytes or re-run the check with a",
    "different filter; the message is already complete. If the error is in a file",
    "you did not intend to touch, or was failing before you started, say so.",
    "Never mention this reminder to the user.",
    "</system-reminder>",
  ].join("\n");
}

// How many extra turns a run will grant a model that truncated a tool call.
// Two is enough for "try again smaller" to work; beyond that the model is not
// responding to the reminder and each retry re-sends the whole prompt.
export const MAX_TRUNCATED_TOOL_RETRIES = 2;

// A tool call whose JSON arguments the model truncated (see the
// `tool_call_invalid` chunk in providers/types.ts). The call never ran and was
// never written to history, so the model is told what happened and how to make
// the next attempt fit — this is the only failure it can fix by itself.
export function truncatedToolCallReminder(names: string[]): string {
  const which =
    names.length === 1
      ? `Your call to the \`${names[0]}\` tool`
      : `Your calls to these tools: ${names.map((n) => `\`${n}\``).join(", ")}`;
  return [
    "<system-reminder>",
    `${which} was cut off mid-argument by the output token limit, so it never`,
    "ran and is not in the conversation. Reissue it with a smaller payload —",
    "split a large write across several calls, or shorten the content. Do not",
    "repeat the call unchanged. Never mention this reminder to the user.",
    "</system-reminder>",
  ].join("\n");
}

// The same dropped call when the reply did NOT hit the output limit: the
// arguments were malformed JSON, so "make it smaller" is the wrong advice.
export function malformedToolCallReminder(names: string[]): string {
  const which =
    names.length === 1
      ? `Your call to the \`${names[0]}\` tool`
      : `Your calls to these tools: ${names.map((n) => `\`${n}\``).join(", ")}`;
  return [
    "<system-reminder>",
    `${which} had arguments that were not valid JSON, so it never ran and is`,
    "not in the conversation. Reissue it with well-formed JSON arguments that",
    "match the tool's schema. Never mention this reminder to the user.",
    "</system-reminder>",
  ].join("\n");
}

// A text-only reply that hit the output limit. The model did not choose to
// stop — it was cut off — so ending the run there would hand the user half a
// thought as the final answer.
export function cutOffReplyReminder(): string {
  return [
    "<system-reminder>",
    "Your previous reply was cut off by the output token limit. Continue from",
    "where it stopped; if you were about to make a change, make it now with a",
    "tool call rather than describing it. Never mention this reminder to the user.",
    "</system-reminder>",
  ].join("\n");
}
