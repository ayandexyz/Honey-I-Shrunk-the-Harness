// Phase 1 of spec 2026-10-13-finish-time-verification.md: replay the "no
// callers" check offline. (a) Real commits — each commit's own changes to
// non-test JS/TS files, refs grepped at that commit (`git grep <sha>`): a
// shipped commit is wired, so every hit is a false positive. (b) The nine v2
// long-task patches applied on their parent commit in a temp worktree.
//
//   pnpm bench:unwired [--commits 50] [--v2 <results dir>]
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  findUncalled,
  isJsFile,
  isTestPath,
  newDeclarations,
  type Declaration,
  type Grep,
} from "../../apps/core/src/agent/unwired.js";

const ROOT = path.resolve(import.meta.dirname, "../..");
const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const git = (args: string[], cwd = ROOT) =>
  spawnSync("git", args, { cwd, encoding: "utf-8", maxBuffer: 64 << 20 });
const show = (rev: string, file: string, cwd = ROOT) => {
  const r = git(["show", `${rev}:${file}`], cwd);
  return r.status === 0 ? r.stdout : "";
};
const grepAt = (rev: string | undefined, cwd: string): Grep => (name) => {
  const r = git(["grep", "-n", "-w", "-F", "-e", name, ...(rev ? [rev] : []), "--"], cwd);
  // `git grep <rev>` prefixes hits with "<rev>:"; strip it.
  return r.status === 0 ? r.stdout.split("\n").filter(Boolean).map((l) => (rev ? l.slice(rev.length + 1) : l)) : [];
};

function scan(changed: string[], before: (f: string) => string, after: (f: string) => string, grep: Grep): Declaration[] {
  const decls = changed
    .filter((f) => isJsFile(f) && !isTestPath(f))
    .flatMap((f) => newDeclarations(before(f), after(f), f));
  return findUncalled(decls, grep);
}

// (a) real commits
const n = Number(arg("commits") ?? 50);
const shas = git(["log", `-${n}`, "--format=%H", "--no-merges", "--", "apps/core/src"]).stdout.split("\n").filter(Boolean);
let flags = 0;
for (const sha of shas) {
  const changed = git(["diff", "--name-only", `${sha}^`, sha, "--", "apps/core/src"]).stdout.split("\n").filter(Boolean);
  const hits = scan(changed, (f) => show(`${sha}^`, f), (f) => show(sha, f), grepAt(sha, ROOT));
  flags += hits.length;
  if (hits.length) console.log(`${sha.slice(0, 8)}  ${hits.map((h) => `${h.name}@${h.file}:${h.line}`).join(", ")}`);
}
console.log(`\nreal commits: ${shas.length}, flags ${flags}, ${(flags / Math.max(1, shas.length)).toFixed(2)} per commit (bar: ≤ 1.00)`);

// (b) v2 patches
const v2 = arg("v2");
if (v2) {
  const tasks = JSON.parse(fs.readFileSync(path.join(ROOT, "bench/agent-bench/instances/freecode-commits.json"), "utf-8")).evalCommits as { id: string; parentSha: string }[];
  for (const t of tasks) {
    for (const trial of fs.readdirSync(path.join(v2, `freecode__${t.id}`)).filter((d) => d.startsWith("trial-")).sort()) {
      const patch = path.join(v2, `freecode__${t.id}`, trial, "freecode", "patch.diff");
      if (!fs.existsSync(patch)) continue;
      const wt = fs.mkdtempSync(path.join(os.tmpdir(), "unwired-wt-"));
      try {
        execFileSync("git", ["worktree", "add", "-q", "--detach", wt, t.parentSha], { cwd: ROOT, stdio: "pipe" });
        if (git(["apply", "--whitespace=nowarn", patch], wt).status !== 0) {
          console.log(`${t.id} ${trial}: patch did not apply`);
          continue;
        }
        git(["add", "-A"], wt);
        const changed = git(["diff", "--cached", "--name-only"], wt).stdout.split("\n").filter(Boolean);
        const hits = scan(changed, (f) => show(t.parentSha, f, wt), (f) => (fs.existsSync(path.join(wt, f)) ? fs.readFileSync(path.join(wt, f), "utf-8") : ""), grepAt(undefined, wt));
        console.log(`${t.id} ${trial}: ${hits.map((h) => `${h.name}@${h.file}:${h.line}`).join(", ") || "(none)"}`);
      } finally {
        spawnSync("git", ["worktree", "remove", "--force", wt], { cwd: ROOT });
      }
    }
  }
}

// (c) rollout history: runs with ≥3 distinct edited files — did a test
// command run after the last edit? (The baseline Phase 4 compares against.)
const roll = path.join(os.homedir(), ".freecode", "rollout", "sessions");
let big = 0, tested = 0;
for (const s of fs.existsSync(roll) ? fs.readdirSync(roll) : []) {
  const f = path.join(roll, s, "events.jsonl");
  if (!fs.existsSync(f)) continue;
  const ev = fs.readFileSync(f, "utf-8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  const edited = new Set<string>();
  let lastEdit = -1, lastTest = -1;
  ev.forEach((e, i) => {
    if (e.type !== "function.call") return;
    const p = e.args?.filePath ?? e.args?.path;
    if (["edit", "write"].includes(e.tool) && typeof p === "string") { edited.add(p); lastEdit = i; }
    if (e.tool === "bash" && /\b(?:test|vitest|jest|--test)\b/.test(e.args?.command ?? "")) lastTest = i;
  });
  if (edited.size >= 3) { big++; if (lastTest > lastEdit) tested++; }
}
console.log(`\nrollout sessions with ≥3 edited files: ${big}; ran a test command after the last edit: ${tested} (${big ? Math.round((100 * tested) / big) : 0}%)`);
