# Analysis 3 — Measured findings from the live sweep runs

**Date:** 2026-10-16
**Scope:** What the Phase 1–4 sweep runs measured, where each finding lives,
and what changed because of them. The three storage layers and their roles:

| Layer | Path | Role |
|---|---|---|
| **Evidence** | `sweep/records/*.json` (committed) | Dated, machine-generated records; the gate's source of truth. Full outputs, mutation logs, answer texts. |
| **Catalog** | `data/failure-modes.json` | The machine-checked claim layer. A row says `measured` only when G1 finds a passing record. Citations name the record files. |
| **Corpus ledger** | drupal-dev-mcp `data/corpus-issues.json` | Corpus findings (retrieval/answerability gaps). Sweeps write PROPOSALS into records; `sweep:gate --apply` writes them to the ledger for human promotion. |
| **Narrative** | `docs/analysis-*.md` | This layer: what the measurements mean, cross-linked to the layers above. |

## 1. Drupal behavior findings (now in the catalog, record-backed)

All three A2 rows were re-measured mechanically on the scratch project; their
catalog citations now cite the committed records.

- **`install-order-subscriber-crash`** — fresh `site:install --existing-config`
  crashes at container compile: `usagov_benefit_finder_api`'s
  `LifeEventController` depends on `file.repository`, which does not exist at
  that install stage. Record:
  `2026-10-16-fm-install-order-subscriber-crash.json`.
- **`half-install-state`** — `pm:enable` of a module with an undeclared
  service dependency bricks the site (this part reproduced). The *recovery*
  recipe, however, did **not** verify on the 2026-10-16 scratch run: the
  repair script exited 1 and the follow-up `cr` exited 1, so the site was
  never provably unbricked. The first record claimed `pass` on that failed
  recovery — a false positive caught in the release-hardening review. The
  record was removed, the row **downgraded `measured` → `claimed`**, and the
  instrument fixed to require repair exit 0 AND cr exit 0 AND
  `get_site_status` ok AND `list_site_modules` ok, emitting machine-readable
  `outcomes` the gate now checks (a `pass` detect contradicted by a failed
  required outcome is rejected). Re-measurement is pending a corrected
  scratch run. Two repair facts still stand from the run: the recipe must go
  through **`ddev exec php`** (PDO-direct), not `drush php:script` (drush
  cannot bootstrap the bricked site it is asked to repair); and recovery must
  be checked **deeply** (`get_site_status` AND `list_site_modules`).
- **`undeclared-service-dependency`** — the important new behavior:
  **the failed enable half-commits.** `pm:enable` fatals at container compile
  AND the module remains in `core.extension`; the next `drush cr` fatals
  naming the missing service. The dangerous artifact of a failed write is
  not the error — it is the state the error leaves behind. Record:
  `2026-10-16-fm-undeclared-service-dependency.json`.
- **`unpopulated-field-fatal`** — re-proven via unpatch mode; fixture drift
  recorded (field now required, content_moderation drafts fresh nodes, so
  the reproduction trigger is render-path-shaped). Record:
  `2026-10-16-fm-unpopulated-field-fatal.json`.
- **`critical-error-page`** — thresholds re-measured against an induced
  500 (500/2527B observed; marker + short-body rules hold). Graduated
  claimed→measured. Record: `2026-10-16-fm-critical-error-page.json`.

## 2. Corpus findings (ledger, via `gate --apply`)

- **concept-bridge (sdc, recipes)** — mechanically confirmed on the current
  index: curated keyword queries rank the right docs #1; plain-language
  questions return Symfony/AI noise. The corpus is complete; the
  question-to-term bridge is missing. Ledger:
  `concept-bridge-recent-era-systems`.
- **phpfloor** — the 2026-09-26 ranking problem (`captcha` ≥8.2 composer
  outranking core docs) did NOT reproduce on the Oct 15 index; the ledger
  observation records the changed behavior. The B2 half remains: the 8B
  expert's answer cites docs that don't state the floor (unsupported).
- **NEW proposed issues** (status `proposed`, awaiting human promotion):
  `message` (raw "show a status message" question retrieves
  event-subscribe guides) and `currentuser` (no current-user service doc in
  top-5 from either query).

## 3. Synthesis-layer findings (B2 records, standing fixtures)

- Grounding density ≈ 0–0.6 across the 8B matrix: the synthesis loop often
  answers from weights, not from retrieved evidence — even when retrieval
  passed (`route`: right docs ranked, `hook_menu` leaked anyway, zero
  citations).
- Run-to-run variance is a measured property: identical prompts flip
  between supported / unsupported / honest-refusal across runs. The
  recorded answers are standing claim-support fixtures (`sweep:regression`)
  precisely so a corpus change must flip them deterministically or fail.

## 4. Harness/transport lessons (folded into tooling)

- ddev shims re-join drush args through a container bash → `shellJoined`
  flag + base64-wrapped `php:eval` (packages/writes).
- `runDrush` no longer hides spawn errors behind empty stderr (`""` is not
  nullish — the ENOENT that broke every drush call in the first sweep run).
- A repo-local `bin/drush` (docker-compose wrapper) shadows vendor drush in
  the container until composer install runs — provisioners must install
  composer deps before any drush step.
- `timeout_ms` tool schemas cap at 120s — sweep calls were silently
  rejected with `-32602` until the envelopes were surfaced verbatim.
- Stale ddev volumes prompt "DROP all tables" on reinstall — fresh
  provisioning must `ddev remove` by project name before cloning.
- MCP tool envelopes that fail parsing were silently eaten; `planes.call`
  now returns the raw text and `envelopeDiag` puts it into records.

## 5. B2 grounding diagnosis (agent-side, investigated not fixed)

Reading drupal-dev-mcp's `packages/agent/src/agent.ts` ask path explains the
uncited answers without exonerating them:

- The pipeline is correct-by-design: one evidence round (LLM-derived keyword
  query, retry on empty), then generation under `GROUNDING_RULES` ("Cite
  every substantive claim with the evidence item's citation_uri"). When
  answers come back uncited, the 8B model is not complying with the rules,
  not missing evidence.
- **Lever 1 — the guidance round is gated**: `isPlacementQuestion()` decides
  whether the curated guidance corpus is pulled into evidence. The
  concept-bridge docs are type `guidance`, so non-placement-shaped questions
  never see them unless the main search already ranked them. Widening the
  gate (or always including a guidance round) is a one-line upstream change.
- **Lever 2 — rule mass**: `GROUNDING_RULES` + `DESIGN_DOC_RULES` are a long
  system prompt; small models demonstrably drop the citation discipline
  under it (density varies 0 → 0.6 run-to-run on identical prompts). A
  small-model rule variant (shorter, citation-first) is the next upstream
  experiment.
- **Verification lever (ours)**: `sweep:answerability` + `sweep:regression` already
  measure both levers deterministically — any upstream change must flip the
  recorded uncited/unsupported answers or it didn't work.

## 6. Stage D — the closed loop, measured

The B1 findings drove a corpus intervention in drupal-dev-mcp (2026-10-16),
and the sweep instruments measured the result:

- **Remedy applied**: new curated source `drupal-concept-bridge-guidance`
  (4 documents: status messages → Messenger service; current user →
  `current_user` service; reusable front-end components → SDC; default
  config+content → recipes). Each doc deliberately contains the
  plain-language trigger phrases AND the system name — the two halves of
  the bridge the ledger identified. Registered as
  `drupal_concept_bridge` (guidance, authority 90); index rebuilt (~1 min,
  embeddings cached; note: the rebuild is lexical-only — the vector index
  was not rebuilt, which matches the mode every sweep has measured in).
- **B1 re-measured: 4 fails → 8/8 pass.** The concept-bridge pair (sdc,
  recipes) now ranks the guidance doc **#1 on the raw plain-language
  questions** — the bridge is closed at retrieval. Fixture matchers
  updated to recognize the guidance docs (the first re-run failed only on
  matcher calibration — a lesson in separating retrieval failure from
  assertion failure).
- **B2 re-measured (honest)**: synthesis improved on the bridge pair —
  sdc and recipes answers now NAME the systems (pass markers went 0→1,
  previously the model couldn't produce the names at all) — but grounding
  density remains variance-dominated (all answers uncited in this run,
  vs. 7 citations in the previous run's phpfloor answer). Retrieval is
  fixed; 8B synthesis grounding is not yet reliable, and the variance
  across identical prompts is itself the measured argument for
  deterministic verdicts over model judgment.
- **Scoring rule refined**: the `message` fixture flipped to fail on
  `drupal_set_message` — a FALSE POSITIVE: the answer correctly taught
  that the function is deprecated. The marker regex now requires
  recommend-usage context (a deprecation cue on the same line suppresses
  the hit).
- **Ledger updated via `gate --apply`**: observations recording the B1
  flip appended to `php-floor-drupal-11-contrib-proximity` and
  `concept-bridge-recent-era-systems`; locatedDocIds merged. The proposed
  issues stay `proposed` — per §5 B3, `fixed` requires retrieval AND
  answerability to pass, and answerability is not yet green.

## 7. What retired

The six 2026-09-26 ad-hoc eval result files (`data/expert-eval-*.json`,
`data/small-model-eval-*.json`) are removed from tracking — superseded by
`sweep/records/`, which carry the full answer texts, model identity, claim
verdicts, and token/latency data the old 280-char-head files kept only
partially. Git history preserves them; the findings they carried are
captured in the corpus ledger's `observed` fields and in this document.
The legacy scripts (`scripts/expert-local-eval.mjs`,
`scripts/small-model-eval.mjs`) remain for ad-hoc runs but are no longer
the standing instruments — the sweep's phpfloor fixture (B1 retrieval +
B2 answerability + `sweep:regression`) replaces them. Note: running the
legacy scripts recreates their result files as untracked files in `data/`.
