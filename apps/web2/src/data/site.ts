export const githubUrl = "https://github.com/ayandexyz/Honey-I-Shrunk-the-Harness";
export const docsUrl = "https://docs.freecode.website/";

export const installCommands = [
	{ id: "curl", label: "curl", command: "curl -fsSL https://freecode.website/install | bash" },
	{ id: "npm", label: "npm", command: "npm i -g freecode" },
	{ id: "bun", label: "bun", command: "bun add -g freecode" },
	{ id: "brew", label: "brew", command: "brew install anomalyco/tap/freecode" },
	{ id: "paru", label: "paru", command: "paru -S freecode" },
] as const;

export const principles = [
	{
		number: "01",
		title: "Scale the work",
		copy: "Agent swarms turn test-time compute into parallel attempts, reviews, and verification instead of one long serial guess.",
	},
	{
		number: "02",
		title: "Keep the context",
		copy: "Persistent memory and compact sessions let the harness learn across turns without making every prompt carry the whole past.",
	},
	{
		number: "03",
		title: "Measure the result",
		copy: "Rollout traces, outcome checks, and reproducible benchmarks make capability visible—including the losses.",
	},
] as const;

/** Copy for the harness-bench index; the numbers come from data/home.ts. */
export const evidenceCopy: Record<string, string> = {
	"resource-efficiency": "Process-tree memory and time-to-ready measurements keep the cost of spawning another worker concrete.",
	"agent-comparison": "The same bugs, model, key, and grader compare Histh with other coding agents on a shared axis.",
	"optimization-task": "Agents improve tested low-level primitives against exhaustive verifiers and deterministic cost models.",
	"confidence-stepping": "Confidence at assignment and completion exposes unsupported jumps and creates a reason to verify again.",
	"hill-climbable-goals": "Goals are rated for measurability so the harness can turn vague work into a metric the agent can climb.",
	"auto-poke": "Bounded continuation pulls an agent back when work remains open, and stops the moment another turn adds nothing.",
};
