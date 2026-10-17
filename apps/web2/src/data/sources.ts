// The bench publishers (bench/*/publish.ts, bench/harness-signals/run.ts,
// scripts/bench_*.ts) still write into apps/web/app/data. Reading from there
// at build time keeps this site on the same numbers instead of a hand-copied
// snapshot. When apps/web is retired, move the directory and repoint DATA_DIR
// here and in the publishers — nothing else reads the path.
// Vercel cannot see this cross-directory read: a commit touching only
// apps/web/app/data is skipped as "no changes to the root directory", so
// redeploy by hand (or set the Ignored Build Step to also diff ../web/app/data).
import type { RawBenchmark } from "./agent-bench";
import type { RawOptTask } from "./jcode-bench";
import { EMPTY_SIGNALS, type SignalsReport } from "./harness-signals";

const sorted = <T>(mods: Record<string, T>): T[] =>
	Object.keys(mods)
		.sort()
		.map((k) => mods[k]!);

export const matchupFiles = sorted(
	import.meta.glob<RawBenchmark>("../../../web/app/data/benchmarks/*.json", {
		eager: true,
		import: "default",
	}),
);

export const optTaskFiles = sorted(
	import.meta.glob<RawOptTask>("../../../web/app/data/jcode-bench/*.json", {
		eager: true,
		import: "default",
	}),
);

const signalsFile = import.meta.glob<SignalsReport>("../../../web/app/data/harness/signals.json", {
	eager: true,
	import: "default",
});
export const signals: SignalsReport = Object.values(signalsFile)[0] ?? EMPTY_SIGNALS;

export interface ResourceRow {
	tool: string;
	pss_mb: number | null;
	seconds_to_input_ready_med: number | null;
}
interface ResourcePayload {
	results: ResourceRow[];
}
const resourceFiles = import.meta.glob<ResourcePayload>("../../../web/app/data/results-{1,10}.json", {
	eager: true,
	import: "default",
});
const pick = (suffix: string) =>
	Object.entries(resourceFiles).find(([k]) => k.endsWith(suffix))?.[1].results ?? [];
export const oneSession = pick("results-1.json");
export const tenSessions = pick("results-10.json");

export interface ToolTokenRow {
	label: string;
	verified: boolean;
	hasRetrieval: boolean;
	source: string;
	totalTokens: number;
}
const tokenFile = import.meta.glob<{ tools: ToolTokenRow[]; fixtures: string[] }>(
	"../../../web/app/data/tool-token-benchmark.json",
	{ eager: true, import: "default" },
);
export const toolTokens = Object.values(tokenFile)[0] ?? { tools: [], fixtures: [] };

export interface LocalPerformanceResult {
	name: string;
	layer: "provider" | "backend" | "frontend" | "end_to_end";
	unit: "ms";
	samples: number;
	distribution: {
		min: number;
		p50: number;
		p75: number;
		p95: number;
		max: number;
	};
	work: Record<string, string | number>;
}

export interface LocalPerformanceReport {
	schemaVersion: 1;
	generatedAt: string;
	environment: {
		node: string;
		platform: string;
		arch: string;
		iterations: number;
		warmup: number;
		networkCalls: number;
	};
	results: LocalPerformanceResult[];
}

export const localPerformanceFiles = sorted(
	import.meta.glob<LocalPerformanceReport>(
		"../../../web/app/data/performance/*.json",
		{
			eager: true,
			import: "default",
		},
	),
);
