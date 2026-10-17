# Local performance harness

`pnpm bench:local` measures local FreeCode latency without a model call or
network request. It covers backend startup, first session creation, first
visible streamed text, Markdown streaming, session resume, repeated history
loads, and checkpoint capture.

```bash
# Human-readable report
pnpm bench:local

# Save a machine-readable baseline
pnpm bench:local --iterations 15 --warmup 3 \
  --json-out /tmp/freecode-perf-before.json

# Refresh the report rendered at /performance in apps/web2
pnpm bench:local:publish

# Show p95 changes against that baseline
pnpm bench:local --iterations 15 --warmup 3 \
  --compare /tmp/freecode-perf-before.json \
  --json-out /tmp/freecode-perf-after.json
```

Run before and after measurements on the same machine, with the same Node
version and no unrelated heavy workload. Build core first when release-like
startup matters; otherwise the report labels startup as the slower `tsx-source`
fallback. JSON output records the runtime, platform, sample counts, and the
network-free constraint.

The publish command writes the same report schema to
`apps/web/app/data/performance/local.json`. Web2 discovers performance reports
from that directory at build time, matching the existing benchmark data flow.

Each row identifies its layer:

- `provider` is only the controlled local delay in the first-visible fixture;
- `backend` is process, IPC/event, persistence, or Git work;
- `frontend` is the real TUI Markdown component;
- `end_to_end` combines the controlled phases for that fixture.

Do not add those rows together: an `end_to_end` row already contains its
component layers. Work counts explain what each timing processed—bytes,
entries, chunks, renders, or files—so a faster result cannot hide less work.

The harness is a measurement tool, not a noisy millisecond CI gate. Its stable
logic is checked with `pnpm test:local-bench`; optimization decisions should use
paired reports and preserve correctness with the subsystem's normal tests.

Implementation and fixture details live in
[`bench/local-performance/README.md`](bench/local-performance/README.md).
