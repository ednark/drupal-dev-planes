# Sweep harness — Stage A (Phases 1–2 implemented)

Implements `docs/sweep-harness-plan.md`: records are the source of truth, the
verdict enum is closed (`pass | fail | skipped | inconclusive`), sweeps go
through the planes, mutations are declared and reversible.

## Commands

```
npm run sweep:all       # Phase-1 failure-mode targets + corpus placeholder
npm run sweep:fm -- unpopulated-field-fatal   # one target
npm run sweep:gate      # G1–G5: claims must cite records
npm run sweep:report    # pass rates, skipped/inconclusive listed separately
```

## Records

One file per target per run in `sweep/records/`:
`<date>-<family>-<target>.json`. Schema and closed-enum validation live in
`lib/record.mjs`; the gate refuses claims without records (G1) and refuses
to write an invalid record at all.

## Phase-1 targets

| Target | Row status | Reproduce | Detect |
|---|---|---|---|
| `unpopulated-field-fatal` | measured | raw `create_content` op **below** the guarded surface (omits required field) → sitewide 500 | `verify_page` on `/node/<nid>` → `server_error` |
| `library-css-category-assertion` | measured | `git apply` of `sweep/bad-patches/usagov-carousel-css-category.patch` + `cr` → front page 500 | `verify_page` → `server_error`/`error_page` |
| `critical-error-page` | claimed | controlled dead page (`SWEEP_DEAD_URL`) or an induced 500 from the patch target | threshold re-measurement: 5xx=dead, marker=dead, <64B=suspicious |

Reproduction uses the raw primitives deliberately: the guarded write surface
exists to protect agents, not to stop the sweep from proving failures are
real. Detection always runs through the plane tools.

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `SWEEP_FIXTURE_URL` | `https://usagov2021.ddev.site` | fixture base URL |
| `SWEEP_FIXTURE_SITE` | `usagov2021` | site name in records |
| `SWEEP_FIXTURE_DRUPAL` | `10.6` | fixture Drupal version in records |
| `SWEEP_HEALTH_URL` | fixture URL | health-check target (refuses to sweep when dead) |
| `SWEEP_SITE_SOURCE_DIR` | — | host checkout for bad-patch targets |
| `SWEEP_DEAD_URL` | — | controlled dead page for `critical-error-page` |
| `SWEEP_FM_BUNDLE` | `basic_page` | bundle for the unpopulated-field reproduction |
| `SWEEP_CORPUS_LEDGER` | — | enables gate rules G3/G4 (drupal-dev-mcp `data/corpus-issues.json`) |
| `DRUSH_BIN` / `DRUPAL_SITE_ROOT` | `drush` / — | fixture drush access (raw reproduce ops) |
| `DRUPAL_AGENT_ALLOW_EXEC` | `false` | required `true` for gated targets — records `skipped` otherwise |

## Phase-1 exit criteria (sweep plan §8)

✓ `sweep:fm <target>` writes valid records; gate G1/G2 pass; teardown leaves
the fixture healthy; the 5 hand-measured rows re-graduate via records.

## Answerability matrix (Family B2 — Phase 3, implemented)

`npm run sweep:b2` runs each fixture through drupal-dev-mcp's
`ask_a_drupal_expert` (ask mode by default; `SWEEP_B2_DEPTH=research` on
demand — research is ~4× slower on 8B models) for each model in
`SWEEP_B2_MODELS` (default `llama31-8b-16k`), then scores the answer
mechanically: shared pass/fail markers, deterministic claim-support
(`check_claim_support` semantics), version-transposition flags, and
grounding density (<0.5 flagged). Records carry the FULL answer text.
Model rows skip honestly with `model-server-unavailable` when Ollama is
down or the model tag is absent.

`npm run sweep:regression` replays recorded answers through
`check_claim_support` against freshly resolved documents — recorded
answers are standing claim-support fixtures: a corpus fix must flip
previously-unsupported rows to supported, and drift in the other direction
fails the run.

## Corpus retrieval checks (Family B1 — Phase 2, implemented)

`sweep/corpus-questions.json` declares the fixtures (the 8-question eval set,
with sdc+recipes as the concept-bridge pair). `sweep:corpus` runs the
deterministic retrieval check — no model: each fixture is queried twice
(curated `kq` + raw question) at its Drupal version, expected docs must
surface in top-k, forbidden docs are recorded per `forbiddenPolicy`
(`record-only`, `must-not-appear`, `must-not-outrank`). Corpus records add
`queries`, `retrieval`, `locatedDocIds`, and `ledgerProposals`.

Ledger discipline (§5 B3): proposals live IN the records — `locatedDocIds`
updates and observations for tracked issues, `new-issue` proposals for
untracked gaps. Nothing is written to drupal-dev-mcp's
`data/corpus-issues.json` by sweeps; set `SWEEP_CORPUS_LEDGER` to enable
gate rules G3/G4, and a human applies transitions.

## Not implemented yet (later phases)

- Phase 4: A2 scratch-project sweeps (the 3 unbacked measured rows), gate
  `--apply`, token-price table
