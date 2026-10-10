export interface BenchmarkAgent {
	id: string;
	version: string;
	autonomy: string;
	trials: number;
	successes: number;
	rate: number;
	medianMs: number;
	medianPatchBytes: number;
	meanTokens: number;
	meanUsd: number;
	worstUsd: number;
	meanTurns: number;
	cacheHitRate: number;
}

export interface BenchmarkCell {
	agent: string;
	wins: number;
	trials: number;
	meanTokens: number;
	meanUsd: number;
}

export interface BenchmarkRun {
	key: string;
	label: string;
	model: string;
	isolation: "container" | "none";
	generatedAt: string;
	runId: string;
	agents: BenchmarkAgent[];
	tokenEdge: number;
	cost: Array<{ id: string; meanUsd: number; meanTokens: number }>;
	instances: Array<{ id: string; cells: BenchmarkCell[] }>;
}

export const taskTitles: Record<string, string> = {
	"django__django-10914": "Set default FILE_UPLOAD_PERMISSION to 0o644.",
	"django__django-10924": "Allow FilePathField path to accept a callable.",
	"django__django-11001": "Incorrect removal of order_by created as multiline RawSQL.",
	"django__django-11019": "Media merges can raise unnecessary MediaOrderConflictWarnings.",
	"django__django-11039": "sqlmigrate wraps output when transactional DDL is unsupported.",
	"django__django-11049": "Correct the expected format in DurationField errors.",
	"django__django-11099": "UsernameValidator allows a trailing newline.",
	"django__django-11133": "HttpResponse does not handle memoryview objects.",
	"django__django-11179": "delete() does not clear PKs for dependency-free models.",
	"django__django-11283": "Proxy-model permission migration fails after model recreation.",
};

export const benchmarkRuns: BenchmarkRun[] = [
	{
		key: "minimax-claude",
		label: "FreeCode vs Claude Code",
		model: "MiniMax-M3",
		isolation: "container",
		generatedAt: "2026-09-28T23:36:41.186Z",
		runId: "2026-09-28T21-04-25-029Z",
		tokenEdge: 67,
		agents: [
			{
				id: "freecode", version: "0.43.0", autonomy: "--agent danger", trials: 30,
				successes: 22, rate: 0.7333, medianMs: 58453, medianPatchBytes: 625,
				meanTokens: 325817, meanUsd: 0.02764, worstUsd: 0.09579, meanTurns: 19.1,
				cacheHitRate: 0.9494,
			},
			{
				id: "claude-code", version: "2.1.251", autonomy: "--dangerously-skip-permissions",
				trials: 30, successes: 22, rate: 0.7333, medianMs: 53732, medianPatchBytes: 642,
				meanTokens: 974896, meanUsd: 0.08799, worstUsd: 0.48772, meanTurns: 27.6,
				cacheHitRate: 0.9488,
			},
		],
		cost: [
			{ id: "freecode", meanUsd: 0.01496, meanTokens: 171457 },
			{ id: "claude-code", meanUsd: 0.02815, meanTokens: 310220 },
		],
		instances: [
			["django__django-10914", [["freecode", 3, 3, 164991, 0.01471], ["claude-code", 3, 3, 383706, 0.03326]]],
			["django__django-10924", [["freecode", 2, 3, 630749, 0.05415], ["claude-code", 1, 3, 2119467, 0.15799]]],
			["django__django-11001", [["freecode", 3, 3, 178667, 0.01635], ["claude-code", 3, 3, 375971, 0.04415]]],
			["django__django-11019", [["freecode", 0, 3, 1072700, 0.09079], ["claude-code", 0, 3, 3383227, 0.33044]]],
			["django__django-11039", [["freecode", 3, 3, 134592, 0.01117], ["claude-code", 3, 3, 266250, 0.02346]]],
			["django__django-11049", [["freecode", 3, 3, 169353, 0.01409], ["claude-code", 3, 3, 266413, 0.02405]]],
			["django__django-11099", [["freecode", 3, 3, 43340, 0.00388], ["claude-code", 3, 3, 88136, 0.01141]]],
			["django__django-11133", [["freecode", 2, 3, 174964, 0.01457], ["claude-code", 3, 3, 274313, 0.02373]]],
			["django__django-11179", [["freecode", 3, 3, 55681, 0.00608], ["claude-code", 3, 3, 86586, 0.00744]]],
			["django__django-11283", [["freecode", 0, 3, 633135, 0.05057], ["claude-code", 0, 3, 2504889, 0.22402]]],
		].map(([id, cells]) => ({
			id: id as string,
			cells: (cells as Array<[string, number, number, number, number]>).map(
				([agent, wins, trials, meanTokens, meanUsd]) => ({ agent, wins, trials, meanTokens, meanUsd }),
			),
		})),
	},
	{
		key: "minimax-opencode",
		label: "FreeCode vs OpenCode",
		model: "MiniMax-M3",
		isolation: "container",
		generatedAt: "2026-09-29T01:59:09.330Z",
		runId: "2026-09-28T23-36-43-360Z",
		tokenEdge: 43,
		agents: [
			{
				id: "freecode", version: "0.43.0", autonomy: "--agent danger", trials: 30,
				successes: 22, rate: 0.7333, medianMs: 56085, medianPatchBytes: 625,
				meanTokens: 357412, meanUsd: 0.03199, worstUsd: 0.15372, meanTurns: 18.8,
				cacheHitRate: 0.9389,
			},
			{
				id: "opencode", version: "1.18.25", autonomy: "--auto", trials: 30,
				successes: 23, rate: 0.7667, medianMs: 76359, medianPatchBytes: 654,
				meanTokens: 627698, meanUsd: 0.05788, worstUsd: 0.62968, meanTurns: 25.5,
				cacheHitRate: 0.9486,
			},
		],
		cost: [
			{ id: "freecode", meanUsd: 0.01628, meanTokens: 190212 },
			{ id: "opencode", meanUsd: 0.03058, meanTokens: 343159 },
		],
		instances: [
			["django__django-10914", [["freecode", 3, 3, 185080, 0.01494], ["opencode", 3, 3, 347074, 0.02874]]],
			["django__django-10924", [["freecode", 2, 3, 557176, 0.04618], ["opencode", 3, 3, 1261890, 0.10839]]],
			["django__django-11001", [["freecode", 2, 3, 300893, 0.02803], ["opencode", 3, 3, 297535, 0.03154]]],
			["django__django-11019", [["freecode", 0, 3, 1454068, 0.13976], ["opencode", 0, 3, 601984, 0.09271]]],
			["django__django-11039", [["freecode", 3, 3, 118212, 0.01044], ["opencode", 3, 3, 114442, 0.01014]]],
			["django__django-11049", [["freecode", 3, 3, 314156, 0.02399], ["opencode", 3, 3, 265755, 0.02286]]],
			["django__django-11099", [["freecode", 3, 3, 39961, 0.00359], ["opencode", 3, 3, 46680, 0.00489]]],
			["django__django-11133", [["freecode", 3, 3, 180610, 0.01756], ["opencode", 3, 3, 266468, 0.02406]]],
			["django__django-11179", [["freecode", 3, 3, 48645, 0.00463], ["opencode", 2, 3, 48137, 0.00549]]],
			["django__django-11283", [["freecode", 0, 3, 375322, 0.03077], ["opencode", 0, 3, 3027011, 0.25002]]],
		].map(([id, cells]) => ({
			id: id as string,
			cells: (cells as Array<[string, number, number, number, number]>).map(
				([agent, wins, trials, meanTokens, meanUsd]) => ({ agent, wins, trials, meanTokens, meanUsd }),
			),
		})),
	},
	{
		key: "haiku-claude",
		label: "FreeCode vs Claude Code",
		model: "Claude Haiku 4.5",
		isolation: "none",
		generatedAt: "2026-10-10T16:47:33.406Z",
		runId: "2026-10-10T16-11-30-047Z",
		tokenEdge: 34,
		agents: [
			{
				id: "freecode", version: "0.43.2", autonomy: "--agent danger", trials: 6,
				successes: 5, rate: 0.8333, medianMs: 95918, medianPatchBytes: 1599,
				meanTokens: 1032438, meanUsd: 0.18468, worstUsd: 0.46943, meanTurns: 25.5,
				cacheHitRate: 0.9694,
			},
			{
				id: "claude-code", version: "2.1.283", autonomy: "--dangerously-skip-permissions",
				trials: 6, successes: 5, rate: 0.8333, medianMs: 105190, medianPatchBytes: 1164,
				meanTokens: 1553154, meanUsd: 0.30544, worstUsd: 1.0212, meanTurns: 25,
				cacheHitRate: 0.9642,
			},
		],
		cost: [
			{ id: "freecode", meanUsd: 0.12773, meanTokens: 780735 },
			{ id: "claude-code", meanUsd: 0.16228, meanTokens: 848367 },
		],
		instances: [
			["django__django-11039", [["freecode", 1, 1, 1660955, 0.2624], ["claude-code", 1, 1, 1539688, 0.29103]]],
			["django__django-11099", [["freecode", 1, 1, 265853, 0.04724], ["claude-code", 1, 1, 168757, 0.04302]]],
			["django__django-11133", [["freecode", 1, 1, 650284, 0.10632], ["claude-code", 1, 1, 633328, 0.12888]]],
			["django__django-10924", [["freecode", 1, 1, 852558, 0.13465], ["claude-code", 1, 1, 1620609, 0.28077]]],
			["django__django-11001", [["freecode", 1, 1, 474026, 0.08805], ["claude-code", 1, 1, 279454, 0.06771]]],
			["django__django-11019", [["freecode", 0, 1, 2290954, 0.46943], ["claude-code", 0, 1, 5077087, 1.0212]]],
		].map(([id, cells]) => ({
			id: id as string,
			cells: (cells as Array<[string, number, number, number, number]>).map(
				([agent, wins, trials, meanTokens, meanUsd]) => ({ agent, wins, trials, meanTokens, meanUsd }),
			),
		})),
	},
];

export const caveats = [
	{
		title: "A demo, not a leaderboard",
		body: "The container runs cover 10 Django instances from SWE-bench Lite, not all 300 instances across 11 repositories. Treat the result as directional evidence.",
	},
	{
		title: "Public fixes can contaminate",
		body: "Every SWE-bench Lite fix predates these models. Closing the network stops lookup, not recall, so these results support relative comparisons—not absolute capability claims.",
	},
	{
		title: "Harnesses, not models",
		body: "Each matchup pins both agents to the same model and key while preserving each harness's own system prompt, tools, and control loop.",
	},
	{
		title: "We are in our own table",
		body: "The task set and grader are external, artifacts are published, and losses stay visible. The incentives still point one way, so inspect the evidence.",
	},
];
