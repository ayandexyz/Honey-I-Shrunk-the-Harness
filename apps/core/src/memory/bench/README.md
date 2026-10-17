# Memory benchmarks: recall and injection

Spec: `docs/specs/2026-08-23-memory-consolidation.md` D14.

```bash
pnpm bench:recall              # metrics table
pnpm bench:recall -- --verbose # + per-query breakdown
pnpm bench:recall -- --json    # raw numbers, for diffing two runs
```

Loads `corpus/` into a throwaway `MemoryStore`, runs every query through the
**production** `MemoryGraphService.retrieve()`, and scores the ranked ids. It
calls the real service on purpose: a benchmark of a reimplementation measures
the reimplementation.

## Injection bench — `pnpm bench:inject`

Spec: `docs/specs/2026-09-25-memory-efficiency-and-graph-explorer.md` §4.

```bash
pnpm bench:inject                    # judge off, + lifecycle scenarios
pnpm bench:inject -- --judge=oracle  # perfect-reader ceiling
pnpm bench:inject -- --verbose       # + per-query rows
pnpm bench:inject -- --json          # raw numbers
```

`bench:recall` scores what `retrieve()` ranks; the model never sees that
list. This bench runs each corpus query through `prepareMemories()` in its own
session, drains the prefetch, renders the block with the production renderer,
and scores **what the request carries**. It then runs twelve lifecycle
scenarios (`scenarios.ts`) over the same production service. A failing
scenario is printed, not thrown: it is a finding to fix, and each fix also gets
a regression test next to the code it changes. Zero model calls; `oracle` is a
labelled ceiling, never a real model.

`bytes on non-gold` is the number that answers "what does the block cost us
for nothing": bytes on memories that were not relevant, resent on every
request of the turn. `headers + footer` is the fixed framing.

### Results — 2026-09-25 (fused mode)

| metric | judge off | oracle judge |
| --- | ---: | ---: |
| candidate recall | 84.1% | 84.1% |
| **rendered recall** | 84.1% | 84.1% |
| full-body recall | 84.1% | 84.1% |
| rendered precision | 16.1% | 100.0% |
| abstention accuracy | 0.0% | 100.0% |
| mean block / request | 1962 B (~490 tok) | 597 B (~149 tok) |
| bytes on gold | 9.9% | 32.5% |
| **bytes on non-gold** | **62.5%** | 0.0% |
| headers + footer | 27.6% | 67.5% |
| gold dropped by budget | 0 | 0 |
| prepare p50 / max | 134 / 155 ms → **6 / 9 ms** after the padding fix | 112 / 161 ms |
| cold misses | 0 | 0 |

- **The budget is not what loses recall.** Rendered recall equals candidate
  recall: every gold memory retrieval found reached the block. The 16% miss is
  retrieval's.
- **With the judge off, the block is mostly waste.** It fills the 2 KB cap on
  nearly every request, and 62.5% of those bytes are memories that did not
  apply. A perfect filter cuts the block by 70% (1962 → 597 B), and then the
  fixed header + footer is two thirds of what is left.
- **The cold wait overran its budget: fixed.** `COLD_BUDGET_MS` is 60, but
  the first `prepareMemories` blocked 110–160 ms: fastembed padded every input
  to 512 tokens and ran synchronously. With padding off (same vectors), p50 is
  now **6 ms** (max 9), and this whole bench runs in 1.4 s instead of 14.6 s.

Lifecycle scenarios, **12/12 pass** after the 2026-09-25 fixes (7/12 before):

| scenario | before | after | fix |
| --- | --- | --- | --- |
| first message, fast retrieval | pass | pass | |
| judge slower than the cold budget (was: retrieval slower) | pass | pass | first request now carries unjudged candidates (§6.1) |
| same-topic follow-up (1 judge call) | pass | pass | |
| abrupt topic switch | pass | pass | |
| repeated identical prompt (1 judge call) | pass | pass | |
| memory edited mid-session | FAIL | pass | store changes patch session stashes (`invalidateSessions`) |
| memory deleted mid-session | FAIL | pass | same |
| memory superseded | FAIL | pass | `graph/supersession.ts` before judging |
| memories competing for budget | FAIL | pass | scenario re-pointed at the renderer contract; ranking of similar memories is a recorded decision (`docs/DECISIONS.md`) |
| judge outage | pass | pass | |
| malformed verdict | pass | pass | |
| secret file written outside the writers | FAIL | pass | `modelSafe` filter on the prefetch and stash patch |

The corpus metrics above are unchanged by the fixes (they are about ranking and
the judge, not staleness), apart from prepare latency.

## Recall bench: reading the output

The `mode` column says which retrieval path produced the numbers. `fastembed`
is an optional dependency, so a machine without it benchmarks the **lexical
path alone** and prints a warning — those numbers are not comparable with a
`fused` run. Run `pnpm install` at the repo root before trusting a baseline.

`abstention accuracy` is the fraction of queries with no relevant memory that
correctly returned nothing. It is the number defect 3 shows up as.

## Results — 2026-08-23

22 scored queries, 5 abstention queries, 0 model calls in every column.

| metric | baseline | + BM25/RRF | + judge (oracle) |
| --- | ---: | ---: | ---: |
| recall@5 | 77.3% | 81.8% | 86.4% |
| recall@10 | 86.4% | 86.4% | 86.4% |
| precision@5 | 22.7% | 24.5% | 26.4% |
| MRR | 87.1% | 81.7% | 100.0% |
| nDCG@10 | 80.5% | 76.9% | 89.4% |
| **abstention accuracy** | **0.0%** | **0.0%** | **100.0%** |

**baseline** — retrieval as shipped: vector seeds with a keyword fallback
whenever the vector store returned nothing, plus a terminal fallback in
`retrieve()`. Good on real queries, total failure on abstention: all five
off-topic queries, including `what is 2 + 2` and `what is the capital of
Portugal`, returned the full 10 memories.

**+ BM25/RRF** — spec D1. Better coverage (recall@5, precision@5 up), worse
ordering (MRR, nDCG down): fusion puts more of the gold set in the top 5 but
ranks the single best hit lower. For a block the model reads whole that is the
right trade. Abstention is untouched, which is the finding below.

**+ judge (oracle)** — spec D15, with a perfect reader (`--judge=oracle`), so
this is a **ceiling, not a claim about any real model**. Note recall@10 does not
move: the judge only filters, so retrieval's recall ceiling is whatever it
already was. Everything else improves because dropping irrelevant candidates
promotes the relevant ones.

`precision@5` is low in absolute terms because most queries have one or two gold
documents and the metric divides by k. Read it as a relative measure between
runs, not as an absolute quality score.

## Results — 2026-09-06 (stopword tokenizer + whole-name bonus)

Same machine, fused mode, before/after the BM25 stopword filter and the
whole-name `EXACT_NAME_BONUS` fix:

| metric | before | after |
| --- | ---: | ---: |
| recall@5 | 81.8% | 81.8% |
| recall@10 | 86.4% | 86.4% |
| precision@5 | 24.5% | 24.5% |
| MRR | 81.7% | **84.1%** |
| nDCG@10 | 76.9% | **79.0%** |
| abstention accuracy | 0.0% | 0.0% |

Coverage unchanged, ordering improved. Abstention does not move in fused mode —
that is the cosine-floor property documented below, and the judge remains the
abstention mechanism; the stopword filter fixes abstention only on the
lexical-only path, where trivial "the"/"and" overlap used to score positive.

## Why there is a model call in the read path at all

D1 originally claimed a local scorer could decide "is anything here relevant"
for free. **The benchmark refuted that.** Three local signals were measured on
this corpus; none separates on-topic from off-topic:

| signal | on-topic range | abstention range | overlap |
| --- | --- | --- | --- |
| top cosine | 0.674 – 0.932 | 0.588 – 0.719 | "can I add a column to the users table" (0.674, real) scores below "what is 2 + 2" (0.719) |
| top BM25 | 3.10 – 23.10 | 0.00 – 6.36 | "compare the two approaches" (3.10, real) below "quicksort partitioning" (6.36) |
| within-query z-score | 1.91 – 4.06 | 1.60 – 2.97 | "write a haiku about the sea" (2.97) beats 13 of the 22 real queries |

This is a property of the embedding model, not a tuning failure: bi-encoder
cosine similarity between short texts has a high, corpus-dependent floor, so an
absolute threshold does not transfer. Term-coverage fails for a different
reason — a real query like "compare the two approaches for me" shares no content
words with the memory that answers it.

`probe.ts` reproduces the table. Run it before proposing any new local floor.

## Corpus

`corpus/memories.json` — 40 memories over the four types, including three
near-duplicate pairs and two superseded records, which exist for the Phase 5
consolidation tests.

`corpus/queries.json` — 27 queries. Five have `relevant: []`; those are the
abstention cases and are scored separately, because recall and nDCG are
undefined when nothing is relevant.

Both files are hand-written and committed. Adding a query means adding its gold
labels; `validateCorpus()` fails the run if a gold id names a memory that does
not exist, since that silently caps recall and reads as a retrieval bug.

**Bias warning:** this corpus was written by the same people who wrote the
retriever. It catches regressions well and proves little about absolute quality.
LongMemEval-S (spec D14) is the external reference: `pnpm bench:longmemeval
run|judge` drives `apps/core/src/eval/longmemeval-adapter.ts` (an adapted subset,
not the official protocol).
