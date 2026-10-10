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

export const resourceBenchmarks = [
	{
		title: "Memory footprint",
		detail: "One live session · proportional set size",
		unit: "MB",
		rows: [
			{ label: "freecode", value: 107.3, display: "107.3 MB", featured: true },
			{ label: "jcode", value: 156.4, display: "156.4 MB" },
			{ label: "pi", value: 160.3, display: "160.3 MB" },
			{ label: "claude code", value: 229.4, display: "229.4 MB" },
			{ label: "codex", value: 237.5, display: "237.5 MB" },
			{ label: "opencode", value: 658.4, display: "658.4 MB" },
		],
	},
	{
		title: "Time to ready",
		detail: "Median startup latency · ten interactive launches",
		unit: "s",
		rows: [
			{ label: "freecode", value: 0.14, display: "0.14 s", featured: true },
			{ label: "claude code", value: 0.57, display: "0.57 s" },
			{ label: "cursor agent", value: 0.79, display: "0.79 s" },
			{ label: "jcode", value: 0.95, display: "0.95 s" },
			{ label: "codex", value: 4.18, display: "4.18 s" },
			{ label: "pi", value: 5.29, display: "5.29 s" },
		],
	},
] as const;

export const tokenBenchmarks = [
	{ label: "freecode", value: 29313, display: "29.3k", featured: true, note: "retrieval" },
	{ label: "freecode · old", value: 45000, display: "45.0k", note: "re-run" },
	{ label: "pi", value: 45198, display: "45.2k", note: "retrieval" },
	{ label: "opencode", value: 45213, display: "45.2k", note: "retrieval" },
] as const;

export const evidenceSections = [
	{
		number: "01",
		title: "Resource efficiency",
		metric: "107 MB",
		label: "one session",
		copy: "Process-tree memory and time-to-ready measurements keep the cost of spawning another worker concrete.",
		command: "pnpm bench:memory",
	},
	{
		number: "02",
		title: "Agent comparison",
		metric: "3",
		label: "published matchups",
		copy: "The same bugs, model, key, and grader compare FreeCode with other coding agents on a shared axis.",
		command: "pnpm bench:agents --isolate",
	},
	{
		number: "03",
		title: "Optimization task",
		metric: "7",
		label: "published runs",
		copy: "Agents improve tested low-level primitives against exhaustive verifiers and deterministic cost models.",
		command: "pnpm bench:jcode",
	},
	{
		number: "04",
		title: "Confidence stepping",
		metric: "370",
		label: "trajectories",
		copy: "Confidence at assignment and completion exposes unsupported jumps and creates a reason to verify again.",
		command: "pnpm bench:signals",
	},
	{
		number: "05",
		title: "Hill-climbable goals",
		metric: "87.6",
		label: "mean score",
		copy: "Goals are rated for measurability so the harness can turn vague work into a metric the agent can climb.",
		command: "pnpm bench:signals",
	},
	{
		number: "06",
		title: "Auto-poke",
		metric: "83%",
		label: "productive pokes",
		copy: "Bounded continuation pulls an agent back when work remains open, and stops the moment another turn adds nothing.",
		command: "pnpm bench:signals",
	},
] as const;

export const summaryStats = [
	{ value: "198+", label: "API providers" },
	{ value: "5,313", label: "sessions measured" },
	{ value: "29.3k", label: "modeled tool tokens" },
] as const;
