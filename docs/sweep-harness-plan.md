# Sweep Harness — Implementation Plan

**Status:** planned (this document)
**Date:** 2026-09-26
**Related:** `docs/architecture.md` (three planes), `docs/analysis-1-conclusions.md`
(assessment + recommendations), `data/failure-modes.json` (11 rows, 5 hand-measured),
`drupal-dev-mcp/data/corpus-issues.json` (3 ledger entries),
`scripts/*-eval.mjs` (ad-hoc evals this plan formalizes).

## 1. Problem

Everything this project claims about Drupal behavior or corpus quality is
currently hand-graduated: the model reproduces a failure, writes a catalog row
by hand, and cites the session. That is one hallucinated citation away from
the dishonesty the catalog exists to prevent (analysis-1, P0). Mosaic-headless
solved the same problem with instruments: `sweep_*.py` / `probe_*.py` produce
the tables mechanically — commit → render → assert → record — and a release
gate refuses claims whose records do not exist.

We need the same, for two target families:

1. **Failure-mode sweeps** — reproduce a Drupal failure mode on a live
   fixture site, prove the detection recipe catches it, graduate the catalog
   row mechanically.
2. **Corpus sweeps** — for question fixtures, measure whether the corpus
   retrieves the right evidence and whether synthesis answers correctly;
   drive the corpus-issues ledger (locate, confirm, fix) mechanically.

## 2. Principles (non-negotiable)

1. **Records are the source of truth.** A catalog row may say
   `evidenceStatus: "measured"` only if a dated sweep record exists for it.
   The gate enforces this; nothing else does.
2. **The verdict enum is closed**: `pass | fail | skipped | inconclusive`.
   `skipped` and `inconclusive` are recorded beside the row and **never
   folded into pass rates**. A sweep that scores its own blind spots as
   successes is the thing this harness argues against.
3. **Sweeps go through the planes.** Reproduction writes use the gated
   `drush_dispatch`; detection runs the real tools (`verify_page`,
   `verify_config`, `check_claim_support`). A sweep that bypasses the planes
   tests nothing about them.
4. **Fixture mutations are reversible and declared.** Every sweep that breaks
   the fixture site (edit a file, write config, create nodes) must declare
   its mutation set up front and restore state in teardown (git for file
   edits, drush for config/content).
5. **Deterministic where possible; models only where measured.** Detection
   recipes are mechanical. Model-in-the-loop steps (corpus answerability)
   run per configured model and are labeled with the model identity.

## 3. Architecture

```
sweep/
  runner.mjs              # orchestration: pick family + targets, write records
  gate.mjs                # validate catalog/ledger claims against records
  lib/
    record.mjs            # record schema, writer, verdict enums
    fixture.mjs           # fixture connection (ddev shim, base URL), mutation helpers
    planes.mjs            # MCP client to drupal-agent-planes (reuse smoke.mjs pattern)
  instruments/
    failure-mode.mjs      # family A: reproduce → detect → assert
    corpus.mjs            # family B: retrieval check + answerability check
  records/                # append-only run records (committed)
    2026-09-26-fm-unpopulated-field-fatal.json
    2026-09-27-cs-phpfloor.json
```

### Record schema (one file per target per run)

```json
{
  "sweepId": "fm-unpopulated-field-fatal",
  "family": "failure-mode",
  "target": "unpopulated-field-fatal",
  "startedAt": "2026-09-27T10:00:00Z",
  "fixture": { "site": "usagov2021", "url": "https://usagov2021.ddev.site", "drupal": "10.6.17" },
  "mutations": [
    { "kind": "node-create", "detail": "basic_page without field_page_type", "reverted": true }
  ],
  "reproduce": { "verdict": "pass", "detail": "HTTP 500 sitewide after node create" },
  "detect":     { "verdict": "pass", "tool": "verify_page", "detail": "verdict=server_error, http=500" },
  "verdict": "pass",
  "notes": [],
  "model": null
}
```

Corpus records add: `query`, `retrieval` (expected doc surfaced? top-k rank),
`answerability` (per model: expert status, pass/fail markers, claim-support
verdict, grounding density), `locatedDocIds`.

### Gate rules (`sweep/gate.mjs` → `npm run sweep:gate`)

- G1: every catalog row with `evidenceStatus: "measured"` has ≥1 record with
  matching `target`, `verdict: "pass"` on both `reproduce` and `detect`.
- G2: every record's verdicts are in the closed enum; `skipped`/`inconclusive`
  records must carry a reason.
- G3: every corpus-ledger entry with status `confirmed` or `fixed` cites a
  corpus record; `fixed` additionally requires a passing record dated after
  the issue's `firstObserved`.
- G4: `locatedDocIds` in ledger entries resolve via `get_drupal_document`.
- G5: catalog/ledger files parse and validate against their schemas.

Exit 1 with a list of violations otherwise. This is the sweep-harness
equivalent of mosaic's `check-release.mjs`.

## 4. Family A — failure-mode sweeps

Target inventory against `data/failure-modes.json` (11 rows). Classification
by fixture cost:

### A1. Cheap (minutes; current ddev fixture, no reinstall)

| Target | Reproduce | Detect | Notes |
|---|---|---|---|
| `unpopulated-field-fatal` | create `basic_page` without `field_page_type` via `drush_dispatch`; `verify_page` expects `server_error` | `verify_page` on the new URL | already hand-measured; sweep re-proves + reverts |
| `critical-error-page` | probe an induced 500 (see A2's CSS break) | `verify_page` verdict `server_error` / marker / short-body | thresholds re-measured here |
| `library-css-category-assertion` | apply a stored bad-patch to `usagov.libraries.yml` (bare `css:` entry), `cr`, probe | `verify_page` → 500; assert marker text | fixture mutation = git-applied patch, reverted in teardown |
| `config-import-without-rebuild` | `drush cset` a visible setting (site slogan) *without* `cr`, `verify_page` marker absence | `verify_page` before/after `cr` | the one row that measures cache-rebuild semantics |
| `missing-cache-tag` | create a node, verify listing view URL lacks the marker pre-`cr` | `verify_page` on listing | needs a listing view on the fixture; usagov has views |
| `di-runtime-fatal` | patch a fixture module service with a bogus interface (stored bad-patch), `cr`, probe affected route | `verify_page` → `error_page` marker | heavier: fixture code mutation |
| `hook-update-noop` | add a stub `hook_update_N` that early-returns (stored patch), run `updb`, assert intended state unchanged | state-plane read (`get_site_config`/node count) | writes fixture code; reverted |
| `plugin-never-discovered` | drop a mis-annotated plugin class (stored patch), assert absence from discovery + no error | state-plane probe + `verify_page` | fixture code mutation |

### A2. Expensive (require clean reinstall or scratch DB)

| Target | Cost driver |
|---|---|
| `install-order-subscriber-crash` | `sql:drop` + full `site:install --existing-config` (~5–10 min); requires the guards be absent (patch revert) or a pre-patch fixture tag |
| `half-install-state` | induce a failing `pm:enable` on the fixture, brick it, verify repair script unbricks; needs an isolated DB copy |
| `undeclared-service-dependency` | fresh minimal DB without `file`, attempt `pm:enable usagov_benefit_finder_api` |

**A2 policy:** run on demand (not per-run), against a **scratch ddev project**
(`ddev config --project-name usagov-sweep-scratch`), never the working
fixture. Record `fixture: {scratch: true}`. These sweeps may take 15+ minutes
and are excluded from the default `sweep:all` run; the gate accepts their
records as long as they exist and are dated.

**Stored bad-patches:** live in `sweep/bad-patches/` as unified diffs with a
manifest (`patch → target row → apply → assert → revert`). This is the
"checkout → check → commit" pattern applied to the fixture itself.

### Family A flow per target

```
declare mutations → apply → reproduce (assert the failure IS present)
→ detect (run the catalog row's detection recipe through the planes)
→ assert detection caught it → teardown (revert mutations, re-verify site healthy)
→ write record
```

A row graduates only when `reproduce` AND `detect` both pass: the failure
must exist *and* the recipe must catch it. If the failure no longer
reproduces (Drupal changed), record `verdict: "inconclusive"` with reason —
never silently pass.

## 5. Family B — corpus sweeps

Target: `sweep/corpus-questions.json` fixtures. Initial set = the 8 eval
questions (from `scripts/eval-questions.mjs`) + the 2 concept-bridge
questions + `phpfloor`. Each fixture declares:

```json
{
  "id": "phpfloor",
  "question": "What is the minimum PHP version Drupal 11 requires?",
  "drupalVersion": "11.4",
  "kq": "Drupal 11 requirements PHP 8.3 composer.json",
  "groundTruth": { "assert": "8.3", "forbid": "8.2-as-minimum", "source": "https://www.drupal.org/about/core/blog/drupal-110-will-require-php-83-and-mysql-80" },
  "expectedDocs": { "anyOf": ["SystemRequirements.php", "composer.json (core)"] },
  "forbiddenDocs": { "captcha composer.json (>=8.2)" }
}
```

### B1. Retrieval check (deterministic, no model)

For each fixture: run `search_drupal` with (a) the curated `kq` and (b) the
raw question, at the fixture's version. Assert expected docs surface in top-k
(record rank); assert forbidden docs' presence/absence is recorded. Writes:
per-question retrieval pass/fail + the top-k titles. This mechanically
measures **corpus completeness and ranking per question** — the instrument
finding #2 asked for.

### B2. Answerability check (model-labeled)

For each fixture × configured model (llama31-8b-16k, gemma-4-E4B, …): run
`ask_a_drupal_expert` (ask mode), then mechanically:
- score pass/fail markers (shared `eval-questions.mjs`),
- `check_claim_support` on the answer (unsupported → fail),
- version-assertion flags (version transposition → fail),
- grounding density (record; threshold gate at < 0.5 → flag).

Records include the full answer text (unlike the eval scripts, which kept
only 280-char heads — a lesson learned). Feeding recorded answers back as
**claim-support regression fixtures** closes the loop: a corpus fix (e.g.,
ranking core docs above contrib) must flip previously-unsupported recorded
answers to supported.

### B3. Ledger integration

Corpus sweep runs propose ledger transitions:
- new located doc ids → update `locatedDocIds`,
- retrieval+answerability pass → propose status `fixed` (gate G3 requires the
  passing record),
- new forbidden-doc hits → propose a new issue (status `open`, human review
  before it counts).

Transitions are written as **proposals** in the record; a human (or the gate
with an explicit `--apply` flag) applies them to `corpus-issues.json`. The
ledger is not silently rewritten by sweeps.

## 6. Runner CLI

```
npm run sweep:all                  # A1 + B1 + B2 (default models) — no reinstall
npm run sweep:fm -- unpopulated-field-fatal
npm run sweep:corpus -- phpfloor
npm run sweep:scratch              # A2 expensive sweeps (isolated project)
npm run sweep:gate                 # gate rules G1–G5
npm run sweep:report               # human summary: pass rates (pass/total-attempted),
                                   # skipped+inconclusive listed separately, ledger deltas
```

Runner contract: one MCP client connection per run (reuse the smoke.mjs
pattern), fail-fast per target but continue the batch, every target ends in a
record — including `skipped` with a reason when the fixture is unavailable.

## 7. Fixture strategy

- **Primary fixture:** the existing `usagov2021` ddev project (Drupal 10.6.17,
  full config, 5 rebuilt pages). Sweeps assume it healthy; `fixture.mjs`
  health-checks (`verify_page` on a known URL) before and after every sweep,
  and refuses to run against an unhealthy fixture.
- **Mutation registry:** each instrument declares mutations up front; teardown
  reverts and re-verify. A crashed sweep leaves a `records/*-aborted.json`
  marker listing un-reverted mutations so the next run can clean or refuse.
- **Scratch fixture (A2):** separate ddev project name; provisioned from the
  same repo; torn down after the sweep (or reused with `--keep`).

## 8. Phases and acceptance criteria

**Phase 1 — harness skeleton + 3 failure-mode sweeps** (the cheap, highest-
confidence rows: `unpopulated-field-fatal`, `library-css-category-assertion`,
`critical-error-page`).
✓ `sweep:fm <target>` writes valid records; gate G1/G2 pass; teardown leaves
the fixture healthy; the 5 hand-measured rows re-graduate via records.

**Phase 2 — corpus sweep B1** (retrieval check only, deterministic).
✓ `sweep:corpus` runs 11 fixtures; records retrieval ranks; locates
`>=8.2`-class docs mechanically; ledger proposals written for review.
✓ This closes "corpus completeness per question is now measurable."

**Phase 3 — answerability B2 + claim-support regression.**
✓ model matrix runs; recorded answers become claim-support fixtures;
phpfloor regression test retires its hand-written form.
✓ finding #1's expert-ask gains a standing before/after instrument.

**Phase 4 — A2 expensive sweeps + gate `--apply` + report.**
✓ scratch-project sweeps; gate applies ledger proposals with an explicit
flag; `sweep:report` produces the token-price table (cost per question per
model vs the alternatives — analysis-1 P3).

## 9. Open questions

1. Should corpus sweep B2 run against `ask` only, or also `research` mode?
   (research is 4× slower on 8B models; propose: ask by default, research
   weekly or on demand.)
2. Where do model servers come from in CI/local runs — required up, or
   B2 skips with `skipped: model-server-unavailable`? (Propose: skip with
   reason; the verdict enum already carries it honestly.)
3. Does the failure-mode catalog move into the sweep package, or stay in
   `data/`? (Propose: stays; the gate reads it.)
4. Token accounting: measure from MCP responses (usage fields) or estimate?
   (Propose: record usage when the model server reports it; estimate otherwise
   and label the record.)

## 10. Non-goals

- No auto-fixing of Drupal or corpus defects inside sweeps — sweeps propose;
  fixes are separate commits.
- No sweeping of third-party MCP servers (drupal/mcp module) — out of scope
  until the pairing recipe exists.
- No performance/load sweeps — the failure modes are correctness, not speed.