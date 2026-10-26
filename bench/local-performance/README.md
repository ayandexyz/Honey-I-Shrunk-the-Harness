# Local performance harness

Deterministic, network-free measurements for FreeCode's local hot paths:

- backend cold start and first `session.start`;
- prompt-to-first-visible-text, split into provider wait, backend event work,
  frontend render work, and end-to-end time;
- fixed 16 KiB Markdown streams under 128-byte and 1,024-byte chunk schedules;
- small and large session resume;
- repeated large-history loads, unchanged and after mutation;
- cold shadow-Git checkpoint capture in small and large repositories.

Run it from the repository root:

```sh
pnpm bench:local
pnpm bench:local --iterations 15 --warmup 3 --json-out /tmp/freecode-perf.json
pnpm bench:local --compare /tmp/freecode-perf-before.json
pnpm bench:local:publish
```

Every row reports p50, p75, and p95 latency plus work counts. Layer names are
intentional: provider timing is never combined with backend or frontend timing.
The startup row says whether it measured compiled core output or the slower TSX
source fallback. Build core first when comparing release-like startup latency.

The fixtures isolate `HOME`, configuration, sessions, snapshots, and project
files under temporary directories. No model, MCP server, or external endpoint is
called. JSON reports include `networkCalls: 0` so saved artifacts retain that
constraint.

`pnpm bench:local:publish` refreshes
`apps/web/app/data/performance/local.json`, which is rendered dynamically by
the Astro page at `apps/web2/src/pages/performance.astro`.
