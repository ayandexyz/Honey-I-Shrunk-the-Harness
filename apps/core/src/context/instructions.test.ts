import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compileInstructionsSection, loadInstructions } from "./instructions.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fc-instr-"));
}

test("returns empty string when no instruction files exist", () => {
  const project = tmpDir();
  const global = tmpDir();
  assert.equal(compileInstructionsSection(project, global), "");
});

test("loads AGENTS.md from project root when it is the only file", () => {
  const project = tmpDir();
  const global = tmpDir();
  fs.writeFileSync(path.join(project, "AGENTS.md"), "use tabs");
  const section = compileInstructionsSection(project, global);
  assert.ok(section.includes("use tabs"));
  assert.ok(
    section.includes(`Instructions from: ${path.join(project, "AGENTS.md")}`),
  );
});

test("CLAUDE.md takes precedence over AGENTS.md in the same directory", () => {
  const project = tmpDir();
  const global = tmpDir();
  fs.writeFileSync(path.join(project, "CLAUDE.md"), "claude rules");
  fs.writeFileSync(path.join(project, "AGENTS.md"), "agents rules");
  const section = compileInstructionsSection(project, global);
  assert.ok(section.includes("claude rules"));
  assert.ok(!section.includes("agents rules"));
});

test("global instructions come before project instructions", () => {
  const project = tmpDir();
  const global = tmpDir();
  fs.writeFileSync(path.join(global, "AGENTS.md"), "GLOBAL-MARK");
  fs.writeFileSync(path.join(project, "CLAUDE.md"), "PROJECT-MARK");
  const section = compileInstructionsSection(project, global);
  assert.ok(section.indexOf("GLOBAL-MARK") < section.indexOf("PROJECT-MARK"));
});

test("empty or whitespace-only file is skipped, falls through to AGENTS.md", () => {
  const project = tmpDir();
  const global = tmpDir();
  fs.writeFileSync(path.join(project, "CLAUDE.md"), "   \n");
  fs.writeFileSync(path.join(project, "AGENTS.md"), "fallback rules");
  const section = compileInstructionsSection(project, global);
  assert.ok(section.includes("fallback rules"));
});

test("an oversized file is sent whole, never sliced", () => {
  const project = tmpDir();
  const global = tmpDir();
  const body = "x".repeat(50_000) + "TAIL-MARK";
  fs.writeFileSync(path.join(project, "CLAUDE.md"), body);
  const section = compileInstructionsSection(project, global);
  assert.ok(section.endsWith("TAIL-MARK"));
  assert.ok(!section.includes("Truncated"));
});

test("two files that fit together are both kept whole", () => {
  const project = tmpDir();
  const global = tmpDir();
  fs.writeFileSync(path.join(global, "CLAUDE.md"), "GLOBAL-MARK");
  fs.writeFileSync(path.join(project, "CLAUDE.md"), "PROJECT-MARK");
  const section = compileInstructionsSection(project, global);
  assert.ok(section.includes("GLOBAL-MARK"));
  assert.ok(section.includes("PROJECT-MARK"));
});

test("walks repository ancestors from root to the active project", () => {
  const repo = tmpDir();
  fs.mkdirSync(path.join(repo, "packages", "app"), { recursive: true });
  fs.mkdirSync(path.join(repo, ".git"));
  fs.writeFileSync(path.join(repo, "AGENTS.md"), "REPO-MARK");
  fs.writeFileSync(path.join(repo, "packages", "AGENTS.md"), "PACKAGE-MARK");
  fs.writeFileSync(path.join(repo, "packages", "app", "CLAUDE.md"), "APP-MARK");
  const section = compileInstructionsSection(path.join(repo, "packages", "app"), tmpDir());
  assert.ok(section.indexOf("REPO-MARK") < section.indexOf("PACKAGE-MARK"));
  assert.ok(section.indexOf("PACKAGE-MARK") < section.indexOf("APP-MARK"));
});

test("expands bounded relative imports and ignores outside imports", () => {
  const repo = tmpDir();
  fs.mkdirSync(path.join(repo, ".git"));
  fs.writeFileSync(path.join(repo, "AGENTS.md"), "ROOT\n@import rules.md\n@import ../outside.md");
  fs.writeFileSync(path.join(repo, "rules.md"), "IMPORTED");
  fs.writeFileSync(path.join(path.dirname(repo), "outside.md"), "OUTSIDE");
  const loaded = loadInstructions(repo, tmpDir());
  assert.ok(loaded.text.includes("ROOT"));
  assert.ok(loaded.text.includes("IMPORTED"));
  assert.ok(!loaded.text.includes("OUTSIDE"));
  assert.ok(loaded.sources.some((source) => source.kind === "import"));
});

test("injects only scoped rules matching frozen files", () => {
  const project = tmpDir();
  fs.mkdirSync(path.join(project, ".freecode", "rules"), { recursive: true });
  fs.writeFileSync(path.join(project, ".freecode", "rules", "ts.md"), "---\nglobs: [src/**/*.ts]\n---\nTS-RULE");
  fs.writeFileSync(path.join(project, ".freecode", "rules", "py.md"), "---\nglobs: [**/*.py]\n---\nPY-RULE");
  const loaded = loadInstructions(project, tmpDir(), ["src/main.ts"]);
  assert.ok(loaded.text.includes("TS-RULE"));
  assert.ok(!loaded.text.includes("PY-RULE"));
  assert.equal(loaded.sources.find((source) => source.kind === "scoped-rule")?.scope?.[0], "src/**/*.ts");
});

test("does not follow an import symlink outside the repository", () => {
  const repo = tmpDir();
  const outside = tmpDir();
  fs.mkdirSync(path.join(repo, ".git"));
  fs.writeFileSync(path.join(outside, "secret.md"), "SYMLINK-OUTSIDE");
  fs.symlinkSync(path.join(outside, "secret.md"), path.join(repo, "secret.md"));
  fs.writeFileSync(path.join(repo, "AGENTS.md"), "@import secret.md");
  assert.ok(!loadInstructions(repo, tmpDir()).text.includes("SYMLINK-OUTSIDE"));
});
