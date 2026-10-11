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
}

export interface InstanceRow {
	id: string;
	title: string | undefined;
	shared: boolean;
	cells: InstanceCell[];
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
		instances: view.matrix.map((row) => ({
			id: row.instanceId,
			title: view.taskSet.titles?.[row.instanceId],
			shared: view.sharedInstances.includes(row.instanceId),
			cells: view.agents.map((a) => rollUp(a.id, row.cells)),
		})),
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
