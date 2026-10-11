// View models for the landing page. The publishers own the numbers
// (sources.ts), the derive functions own the arithmetic, this module only
// shapes them into rows the chart components draw.
import { deriveView } from "./agent-bench";
import { deriveOptView } from "./jcode-bench";
import {
	matchupFiles,
	oneSession,
	optTaskFiles,
	signals,
	tenSessions,
	toolTokens,
	type ResourceRow,
} from "./sources";

export { signals };

/** The product shipped as `freecode`; on this site it is Histh. */
export const US = "freecode";
export const displayName = (id: string) =>
	id === US ? "histh" : id.replaceAll("_", " ").replace(/-/g, " ");

export interface BarRow {
	label: string;
	value: number;
	display: string;
	featured?: boolean;
	note?: string;
	color?: string;
}

const mb = (v: number) =>
	`${v.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} MB`;
const sec = (v: number) => `${v.toFixed(2)} s`;

function resourceRows(
	rows: ResourceRow[],
	metric: "pss_mb" | "seconds_to_input_ready_med",
	format: (v: number) => string,
	[worse, better]: [string, string],
): BarRow[] {
	const present = rows
		.map((r) => ({ tool: r.tool, value: r[metric] }))
		.filter((r): r is { tool: string; value: number } => r.value != null)
		.sort((a, b) => a.value - b.value);
	const base = present.find((r) => r.tool === US)?.value;
	return present.map((r) => ({
		label: displayName(r.tool),
		value: r.value,
		display: format(r.value),
		featured: r.tool === US,
		note:
			r.tool === US
				? "baseline"
				: base
					? r.value >= base
						? `${(r.value / base).toFixed(1)}× ${worse}`
						: `${(base / r.value).toFixed(1)}× ${better}`
					: undefined,
	}));
}

export const memoryOne = resourceRows(oneSession, "pss_mb", mb, ["more RAM", "less RAM"]);
export const timeToReady = resourceRows(oneSession, "seconds_to_input_ready_med", sec, ["slower", "faster"]);
export const memoryTen = resourceRows(tenSessions, "pss_mb", mb, ["more RAM", "less RAM"]);
/** Tools that never became input-ready, named rather than silently dropped. */
export const neverReady = oneSession
	.filter((r) => r.seconds_to_input_ready_med == null)
	.map((r) => displayName(r.tool));

const tokenBest = Math.min(...toolTokens.tools.map((t) => t.totalTokens));
export const tokenRows: BarRow[] = toolTokens.tools.map((t) => {
	const ours = t.label.startsWith(US);
	const label = ours ? t.label.replace(/^freecode \((new)\)/, "histh").replace(/^freecode \((old)\)/, "histh · old") : t.label;
	const delta = t.totalTokens === tokenBest ? "best" : `+${Math.round(((t.totalTokens - tokenBest) / tokenBest) * 100)}%`;
	return {
		label: t.verified ? label : `${label} *`,
		value: t.totalTokens,
		display: t.totalTokens.toLocaleString("en-US"),
		featured: t.label === "freecode (new)",
		note: `${delta} · ${t.hasRetrieval ? "retrieval" : "re-run"}`,
	};
});
export const tokenFixtures = toolTokens.fixtures;
const tokenRival = Math.min(...toolTokens.tools.filter((t) => !t.label.startsWith(US)).map((t) => t.totalTokens));
export const tokenSaving = tokenRival > 0 ? Math.round((1 - tokenBest / tokenRival) * 100) : null;

export const matchups = matchupFiles
	.map(deriveView)
	.filter((v) => v.agents.length >= 2);

export const opt = deriveOptView(optTaskFiles);

const pct = (n: number | null) => (n === null ? "—" : `${Math.round(n * 100)}%`);

export const evidence = [
	{ id: "resource-efficiency", title: "Resource efficiency", metric: memoryOne.find((r) => r.featured)?.display ?? "—", label: "one session" },
	{ id: "agent-comparison", title: "Agent comparison", metric: String(matchups.length), label: "published matchups" },
	{ id: "optimization-task", title: "Optimization task", metric: String(opt.runCount), label: "published runs" },
	{ id: "confidence-stepping", title: "Confidence stepping", metric: String(signals.confidence.n), label: "trajectories" },
	{ id: "hill-climbable-goals", title: "Hill-climbable goals", metric: signals.hillClimb.mean?.toFixed(1) ?? "—", label: "mean score" },
	{ id: "auto-poke", title: "Auto-poke", metric: pct(signals.autoPoke.productiveRate), label: "productive pokes" },
];

export const summaryStats = [
	{ value: "198+", label: "API providers" },
	{ value: signals.sessionsScanned.toLocaleString("en-US"), label: "sessions measured" },
	{ value: `${(tokenBest / 1000).toFixed(1)}k`, label: "modeled tool tokens" },
];
