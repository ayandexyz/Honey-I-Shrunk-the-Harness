// =============================================================================
// Sandbox — the neutral home for "what may a shell touch".
//
// `plan.ts` turns axes into a bubblewrap argv; `axes.ts` turns an agent
// envelope into axes; `env.ts` holds the environment and toolchain mounts both
// need. Two callers share it: an enveloped agent's `bash` tool and an
// unattended night run (spec docs/specs/2026-09-27-agent-control-and-definitions.md §5.5).
// =============================================================================

export {
  sandboxPlan,
  worktreeAxes,
  type SandboxAxes,
  type SandboxPlan,
} from "./plan.js";
export { envelopeAxes, type AxesVerdict } from "./axes.js";
export {
  bubblewrapAvailable,
  homeToolchainMounts,
  isWithin,
  sandboxAvailable,
  sandboxEnvironment,
} from "./env.js";
