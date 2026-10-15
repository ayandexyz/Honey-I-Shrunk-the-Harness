import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRecorder } from "../rollout/recorder.js";
import { createToolOrchestrator } from "../tools/orchestrator.js";
import { createAgentLoop } from "./loop.js";

test("agent tools use the session project instead of the process cwd", async () => {
  const projectPath = mkdtempSync(join(tmpdir(), "freecode-project-cwd-"));
  const rolloutDir = mkdtempSync(join(tmpdir(), "freecode-project-cwd-rollout-"));
  const relativePath = `relative-write-${Date.now()}-${process.pid}.txt`;
  const loop = createAgentLoop("project-cwd", {
    orchestrator: createToolOrchestrator(),
    recorder: createRecorder("project-cwd", { rolloutDir }),
  });

  try {
    assert.notEqual(projectPath, process.cwd());
    (loop as any).state.projectPath = projectPath;
    (loop as any).state.agentMode = "danger";
    (loop as any).runModel = { provider: "test", model: "test" };

    const result = await (loop as any).executeTool({
      id: "bash-project-cwd",
      tool: "bash",
      args: {
        command: `pwd && printf rooted > ${relativePath}`,
      },
      execution: "sequential",
    });

    assert.equal(result.error, undefined);
    assert.equal(result.stdout?.split("\n")[0], projectPath);
    assert.equal(existsSync(join(projectPath, relativePath)), true);
    assert.equal(existsSync(join(process.cwd(), relativePath)), false);
  } finally {
    rmSync(join(process.cwd(), relativePath), { force: true });
    rmSync(projectPath, { recursive: true, force: true });
    rmSync(rolloutDir, { recursive: true, force: true });
  }
});
