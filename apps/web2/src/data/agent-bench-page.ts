// /benchmark's view model. Every matchup file `pnpm bench:agents` publishes is
// a run here: a new pairing or model appears by existing, nobody edits a list.
import { deriveView, type BenchView, type MatrixCell } from "./agent-bench";
import { matchupFiles } from "./sources";

/** Display names; anything unlisted shows its id. */
export const agentName = (id: string) =>
	({ freecode: "Histh", "claude-code": "Claude Code", opencode: "OpenCode" })[id] ?? id;

/** Per-agent roll-up of one instance's trials, for the matrix row. */
export interface InstanceCell {
	agent: string;
	wins: number;
	trials: number;
	meanTokens: number | null;
	meanUsd: number | null;
	/** Some trial of this cell ran outside the container. */
	open: boolean;
	/** The trials themselves, for the per-trial chips. */
	runs: MatrixCell[];
}

export interface InstanceRow {
	id: string;
	title: string | undefined;
	shared: boolean;
	cells: InstanceCell[];
	/** Histh against the best rival on this bug, price then tokens. */
	edges: Edge[];
}

export interface Edge {
	text: string;
	tone: "good" | "bad" | "even";
}

/**
 * Histh's number against the best rival's, as a percentage: "40% cheaper",
 * "12% more tokens". Within 5% is called even rather than inventing a winner
 * out of rounding; a missing number on either side yields nothing, never 0%.
 */
export function compareEdge(
	mine: number | null | undefined,
	theirs: (number | null | undefined)[],
	[win, lose, noun]: [string, string, string],
): Edge | null {
	const priced = theirs.filter((t): t is number => typeof t === "number" && t > 0);
	if (typeof mine !== "number" || mine <= 0 || priced.length === 0) return null;
	const pct = Math.round((1 - mine / Math.min(...priced)) * 100);
	if (Math.abs(pct) < 5) return { text: `even ${noun}`, tone: "even" };
	return pct > 0 ? { text: `${pct}% ${win}`, tone: "good" } : { text: `${-pct}% ${lose}`, tone: "bad" };
}

export const PRICE: [string, string, string] = ["cheaper", "costlier", "price"];
export const TOKENS: [string, string, string] = ["fewer tokens", "more tokens", "tokens"];

/** Price and token edges for one row of per-agent numbers. */
export function edgesFor(perAgent: { id: string; usd: number | null; tokens: number | null }[]): Edge[] {
	const free = perAgent.find((p) => p.id === "freecode");
	const rivals = perAgent.filter((p) => p.id !== "freecode");
	return [
		compareEdge(free?.usd, rivals.map((p) => p.usd), PRICE),
		compareEdge(free?.tokens, rivals.map((p) => p.tokens), TOKENS),
	].filter((e): e is Edge => e !== null);
}

export interface BenchRun {
	/**
	 * Unique per run. The slug alone is not: the same pairing is published once
	 * per pinned model (freecode-vs-claude-code on MiniMax, Haiku and Sonnet).
	 */
	key: string;
	view: BenchView;
	instances: InstanceRow[];
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

function rollUp(agent: string, cells: MatrixCell[]): InstanceCell {
	const mine = cells.filter((c) => c.agent === agent);
	return {
		agent,
		wins: mine.filter((c) => c.ok).length,
		trials: mine.length,
		meanTokens: avg(mine.flatMap((c) => (c.tokens === undefined ? [] : [c.tokens]))),
		meanUsd: avg(mine.flatMap((c) => (typeof c.usd === "number" ? [c.usd] : []))),
		open: mine.some((c) => c.isolation !== "container"),
		runs: mine,
	};
}

export const runs: BenchRun[] = matchupFiles
	.map(deriveView)
	// A solo run is a pipeline check, not a matchup.
	.filter((v) => v.agents.length >= 2)
	// Widest matchup first: most agents, then most instances.
	.sort(
		(a, b) =>
			b.agents.length - a.agents.length ||
			b.sharedInstances.length - a.sharedInstances.length ||
			a.slug.localeCompare(b.slug),
	)
	.map((view) => ({
		key: `${view.slug.replace(/\..*$/, "")}--${view.model.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
		view,
		instances: view.matrix.map((row) => {
			const cells = view.agents.map((a) => rollUp(a.id, row.cells));
			return {
				id: row.instanceId,
				title: view.taskSet.titles?.[row.instanceId],
				shared: view.sharedInstances.includes(row.instanceId),
				cells,
				edges: edgesFor(cells.map((c) => ({ id: c.agent, usd: c.meanUsd, tokens: c.meanTokens }))),
			};
		}),
	}));

/**
 * One benchmark is one pinned model: the picker groups runs by it, because
 * numbers measured on different models never share a table. Container runs
 * lead, so the page opens on headline evidence rather than a provisional run.
 */
export const models = [...new Set(runs.map((r) => r.view.model))].sort((a, b) => {
	const iso = (m: string) => (runs.some((r) => r.view.model === m && r.view.isolation === "container") ? 0 : 1);
	return iso(a) - iso(b) || a.localeCompare(b);
});

export const totals = {
	matchups: runs.length,
	trials: runs.reduce((n, r) => n + r.view.agents.reduce((m, a) => m + a.trials, 0), 0),
	models: models.length,
};
