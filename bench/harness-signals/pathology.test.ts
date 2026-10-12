import test from "node:test";
import assert from "node:assert/strict";
import { aggregate, errorFingerprint, foldRuns, isBashWrite, type PathEvent } from "./pathology.js";

const MIN = 60_000;
let t = 0;
const at = (ms: number) => (t = ms);
const e = (x: Omit<PathEvent, "timestamp">, ms = t + 1000): PathEvent => ({ ...x, timestamp: at(ms) });
const req = (turn: string, ms?: number) => e({ type: "model.request", turnId: turn }, ms);
const res = (turn: string, inputTokens = 1000, ms?: number) =>
  e({ type: "model.response", turnId: turn, inputTokens, outputTokens: 10 }, ms);
const call = (tool: string, args: Record<string, unknown> = {}, ms?: number, callId?: string) =>
  e({ type: "function.call", turnId: "x", tool, args, callId }, ms);
const read = (filePath: string, ms?: number) => call("read", { filePath }, ms);
const edit = (filePath: string, ms?: number) => call("edit", { filePath, oldString: "a", newString: "b" }, ms);

test("a turn-0 request opens a run; a retry after an error does not", () => {
  t = 0;
  const runs = foldRuns([
    req("turn-0"),
    e({ type: "model.error", turnId: "turn-0" }),
    req("turn-0"), // retry: turn-0 never answered
    res("turn-0"),
    req("turn-0"), // turn-0 already answered: the next prompt
    res("turn-0"),
  ]);
  assert.equal(runs.length, 2);
  assert.equal(runs[0]!.modelCalls, 2);
});

test("old-format logs (turn.started after the response) split the same way", () => {
  t = 0;
  const runs = foldRuns([
    req("turn-0"),
    res("turn-0"),
    e({ type: "turn.started", turnId: "turn-0" }),
    call("ls"),
    req("turn-1"),
    res("turn-1"),
    e({ type: "turn.started", turnId: "turn-1" }),
    req("turn-0", 100 * MIN),
    res("turn-0"),
  ]);
  assert.equal(runs.length, 2);
  assert.ok(runs[0]!.durationMs < MIN, "the 100-minute idle gap is not billed to the first run");
});

test("the next prompt's checkpoint and turn.started never stretch the previous run", () => {
  t = 0;
  const runs = foldRuns([
    e({ type: "turn.started", turnId: "turn-0" }),
    req("turn-0"),
    res("turn-0"),
    e({ type: "checkpoint.captured" }, 600 * MIN),
    e({ type: "turn.started", turnId: "turn-0" }),
    req("turn-0"),
    res("turn-0"),
  ]);
  assert.equal(runs.length, 2);
  assert.ok(runs[0]!.durationMs < MIN);
});

test("dry stretch and first edit; time spent waiting on a question is excluded", () => {
  t = 0;
  const [r] = foldRuns([
    req("turn-0", 0),
    res("turn-0"),
    call("question", {}, 1 * MIN, "q1"),
    e({ type: "function.output", turnId: "x", tool: "question", callId: "q1" }, 61 * MIN), // the user thought for an hour
    ...Array.from({ length: 5 }, (_, i) => read(`f${i}`, (62 + i) * MIN)),
    edit("f0", 70 * MIN),
    read("f9", 71 * MIN),
  ]);
  assert.equal(r!.waitingOnUserMs, 60 * MIN);
  assert.equal(r!.longestDryMs, 10 * MIN);
  assert.equal(r!.longestDryCalls, 7); // question, then 5 reads, then the edit
  assert.equal(r!.firstEditMs, 70 * MIN);
  assert.equal(r!.durationMs, 11 * MIN);
});

test("rereads: same range again with no edit in between; after a compaction is counted apart", () => {
  t = 0;
  const [r] = foldRuns([
    req("turn-0"),
    res("turn-0"),
    read("a"),
    read("a"), // reread
    edit("a"),
    read("a"), // the file changed: not a reread
    call("read", { filePath: "a", offset: 100 }), // a different range
    read("b"),
    e({ type: "compact.occurred" }),
    read("b"), // re-reading what it forgot
  ]);
  assert.equal(r!.reads, 6);
  assert.equal(r!.rereads, 2);
  assert.equal(r!.rereadsAfterCompact, 1);
});

test("compaction loop: a second compaction with no progress since the first; shrink is measured", () => {
  t = 0;
  const [r] = foldRuns([
    req("turn-0"),
    res("turn-0", 100_000),
    e({ type: "compact.occurred" }),
    req("turn-1"),
    res("turn-1", 60_000),
    read("x"),
    e({ type: "compact.occurred" }),
    req("turn-2"),
    res("turn-2", 59_000),
    edit("x"),
    e({ type: "compact.occurred" }),
  ]);
  assert.equal(r!.compactions, 3);
  assert.equal(r!.compactNoProgress, 1);
  assert.deepEqual(
    r!.compactShrink.map((x) => Math.round(x * 100)),
    [40, 2],
  );
  assert.ok(r!.flags.includes("compact_loop"));
});

test("repeated identical searches only count with no progress between them", () => {
  t = 0;
  const g = () => call("grep", { pattern: "foo" });
  const [r] = foldRuns([req("turn-0"), res("turn-0"), g(), g(), g(), edit("z"), g(), g()]);
  assert.equal(r!.repeatSearches, 3);
});

test("a model call that hangs is flagged hung_call, not long_dry", () => {
  t = 0;
  const [r] = foldRuns([req("turn-0", 0), e({ type: "model.error", turnId: "turn-0" }, 400 * MIN)]);
  assert.deepEqual(r!.flags, ["hung_call"]);
});

test("long_dry needs both the time and the call count", () => {
  t = 0;
  const reads = (n: number, from: number) => Array.from({ length: n }, (_, i) => read(`p${i}`, from + i * MIN));
  assert.ok(foldRuns([req("turn-0", 0), res("turn-0"), ...reads(31, MIN)])[0]!.flags.includes("long_dry"));
  t = 0;
  assert.ok(!foldRuns([req("turn-0", 0), res("turn-0"), ...reads(5, 10 * MIN), read("q", 30 * MIN)])[0]!.flags.length);
});

test("bash writes: in-place edits and redirects count, logs and /dev/null do not", () => {
  for (const c of ["sed -i 's/a/b/' x.ts", "cat > src/a.ts <<'EOF'", "echo hi >> notes.md", "git apply p.diff", "cd x && rm a.js", "mkdir -p src/x"])
    assert.ok(isBashWrite(c), c);
  for (const c of ["pnpm lint > /tmp/lint.txt 2>&1", "ls 2>/dev/null", "curl -s -o /dev/null http://x", "node a.js > out.log", "grep -rn foo src", "git status"])
    assert.ok(!isBashWrite(c), c);
});

test("aggregate only counts runs with enough tool calls", () => {
  t = 0;
  const big = foldRuns([req("turn-0"), res("turn-0"), ...Array.from({ length: 12 }, (_, i) => read(`r${i}`))]);
  t = 0;
  const small = foldRuns([req("turn-0"), res("turn-0"), read("a")]);
  const rep = aggregate([...big, ...small]);
  assert.equal(rep.runs, 2);
  assert.equal(rep.substantive, 1);
  assert.equal(rep.withEdits, 0);
});

test("repeat commands: an identical non-writing bash command with no progress since", () => {
  t = 0;
  const od = () => call("bash", { command: "awk 'NR==175' s.ts | od -c" });
  const tsc = () => call("bash", { command: "pnpm tsc --noEmit" });
  const [r] = foldRuns([req("turn-0"), res("turn-0"), od(), od(), od(), tsc(), edit("s.ts"), tsc(), od()]);
  // od twice more before the edit; tsc and od once each after it are fresh.
  assert.equal(r!.repeatCommands, 2);
});

test("stuck error: the same error set coming back counts across edits", () => {
  t = 0;
  const out = (output: string) => e({ type: "function.output", turnId: "x", tool: "bash", output });
  const tscOut = (ms: number) =>
    out(`src/a.ts(217,2): error TS1161: Unterminated regular expression literal.\nDone in ${ms}ms`);
  const [r] = foldRuns([
    req("turn-0"),
    res("turn-0"),
    tscOut(812),
    edit("a.ts"),
    tscOut(790), // edits in between, timing differs: still the same error
    edit("a.ts"),
    tscOut(1203),
    out("src/b.ts(1,1): error TS2307: Cannot find module"),
    edit("a.ts"),
    tscOut(800),
    out("all good"),
  ]);
  assert.equal(r!.stuckErrorRepeats, 4);
  assert.ok(r!.flags.includes("stuck_error"));
  assert.ok(!r!.flags.includes("long_dry"));
});

test("error fingerprint: order-free, timings stripped, undefined without errors", () => {
  assert.equal(errorFingerprint("ok\nall passed"), undefined);
  assert.equal(errorFingerprint("    except ValueError:\n        pass"), undefined);
  assert.ok(errorFingerprint("TypeError: x is not a function"));
  assert.equal(
    errorFingerprint("x.ts(1,1): error TS1 a\nnot ok 3 - y (12.5ms)"),
    errorFingerprint("not ok 3 - y (40ms)\nx.ts(1,1): error TS1 a"),
  );
});

test("question wait is read from duration_ms when the log has no callIds", () => {
  t = 0;
  const [r] = foldRuns([
    req("turn-0", 0),
    res("turn-0"),
    call("question", {}, MIN),
    e({ type: "function.output", turnId: "x", tool: "question", duration_ms: 27 * MIN }, 28 * MIN),
    edit("a", 29 * MIN),
  ]);
  assert.equal(r!.waitingOnUserMs, 27 * MIN);
  assert.equal(r!.firstEditMs, 29 * MIN); // wall clock, as the user saw it
  assert.ok(r!.longestDryMs <= 2 * MIN);
});
