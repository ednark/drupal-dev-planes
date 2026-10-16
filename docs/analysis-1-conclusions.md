# Analysis 1 — Conclusions from the usagov-2021 bring-up

**Date:** 2026-09-26
**Scope:** Standing up the public `usagov/usagov-2021` Drupal 10.6 codebase under
ddev from `site:install --existing-config` (no upstream DB dump available), then
rebuilding 5 live usa.gov pages through the drupal-dev-planes MCP server.
**Related artifacts:** `docs/usagov-2021-upstream-proposals.patch`,
`data/failure-modes.json` (5 rows graduated to `measured`).

## What was run

- usagov-2021 stood up: ddev (mariadb), composer install, module enable in
  dependency-safe order, full `config:import` of their 1,421-file sync, DB
  updates, cache rebuild. End state: site serves at `https://usagov2021.ddev.site`.
- Rebuild driver (`scripts/rebuild-usagov.mjs`) rebuilt 5 live pages
  (/about-the-us, /passport, /voting, /travel, /scams-and-frauds) as
  `basic_page` nodes: knowledge grounding → state reads → gated write →
  verification. Final verdict: all 5 `alive`, HTTP 200, titles rendered; front
  page set and verified via `verify_config` → `match`.

## How the three planes behaved

The headline finding: **the planes worked as guardrails, not as the source of
intelligence.** Every diagnosis and fix came from model knowledge plus reading
the local codebase. What the planes changed is what could be trusted, and when
the agent had to stop and check.

Evidence — three waves of "everything reported success" that were actually dead:

| Moment | Reported | Caught by |
|---|---|---|
| After full config import | `config:import` success | `verify_page` → HTTP 500 (library CSS category assertion) |
| After 5-node write | commit ok, nodes in DB | `verify_page` → all 5 pages HTTP 500 (unpopulated-field fatal) |
| After first null-deref fix | fix applied, cache rebuilt | still 500 — byte-size delta (2229 vs 2090) identified a second bug instance |

## What is measurably good

1. **The verification plane.** Drupal's dominant failure class is silent
   partial success. We hit five such failures in one session; `verify_page`
   caught each before success was claimed. Verdict-first output (alive /
   server_error + byte counts) made the debug loop cheap — no HTML dumps.
2. **The failure-mode catalog compounds.** One messy bring-up became 5 dated,
   cited `measured` rows (see `data/failure-modes.json`). Neither session
   context (which resets) nor base training data holds this.
3. **Gated writes with captured stderr.** The one write tool
   (`drush_dispatch`, `destructiveHint: true`) captured the PHP bug
   (`cache.tagsinvalidator`) as data, not as lost terminal scroll.
4. **Graceful per-plane degradation.** The knowledge plane was down for the
   first half (Node version mismatch); state + verification kept working.
5. **The tool improved by being used.** `verify_config`'s false `diff` on
   `page.front` (full-subtree compare failing on extra `403`/`404` siblings)
   was found only by verifying a real config — now fixed to subset semantics
   with regression tests.

## Gaps — bad at what it should be good at

1. **The knowledge plane answered zero questions we actually had.** Every hard
   problem (ModuleInstaller per-module rebuild cadence, `file.repository` on
   minimal, config UUID import semantics, library CSS categories) was answered
   from local files or baked-in knowledge. `ModuleInstaller.php` *is* in the
   corpus (`core_module_code`) but reading the local file was cheaper. The
   knowledge plane earns its tokens only when you cannot read the source.
2. **No sweep instrument.** mosaic-headless's `sweep_*` tools *produce* the
   tables mechanically (commit → render → assert → write the row). Our
   "measured" rows were hand-graduated from session memory by the model —
   better than `claimed`, but still model-authored. A sweep harness that
   reproduces, asserts, and writes rows mechanically is the missing artifact.
3. **State plane too thin.** Node listing, watchdog reads, and kernel-request
   debugging all went through raw `ddev drush php:eval`, bypassing the planes.
   When the sanctioned surface is too narrow, agents route around it and the
   gate stops gating.
4. **verify_page cannot assert content through the plane.** Title-marker
   checks ran driver-side with raw fetch. An `expected` substring parameter
   would make delivery verification first-class.
5. **`explain_config` was a demo.** The join returned `state=true
   knowledge=true` and influenced nothing. Useful version: live value + change
   records touching that key for the installed version + associated failure
   modes.

## Attribution — what needed no MCP server

ddev setup for a repo without `.ddev`, `settings.local.php` wiring, config
import fixes (site/language UUIDs, taxonomy cleanup), the null-safe patches,
the libraries.yml fix, watchdog/kernel debugging, the PDO repair script: all
baked-in model knowledge plus local repo reads. Even the deepest insight
(ModuleInstaller rebuild cadence) came from reading local core source after a
hypothesis. The `search_drupal` hits (Entity API, clean `drupal://` citations)
were performative grounding — correct answer already in the model's head.

## Recommendations (prioritized)

| # | Recommendation | Why |
|---|---|---|
| P0 | **Sweep harness**: machine-authored catalog rows (reproduce → assert → graduate) | Hand-graduated rows are one hallucinated citation away from dishonesty |
| P1 | **Widen state plane**: content-entity reads, log reads, route checks | Agents route around a thin sanctioned surface; the gate must be the easy path |
| P1 | **verify_page `expected` substring** | Content assertions belong in the plane, not the driver |
| P2 | **Re-scope `explain_config`** to value + version-relevant change records + associated failure modes | The current join is composition without consequence |
| P2 | **Knowledge plane: accept the narrow niche** (API facts + citations outside the repo) or index *behavioral* questions against core source | Inside the repo it is redundant; behavioral pipeline questions are the unowned corpus |
| P3 | Token-price table per tool | mosaic-headless's most persuasive artifact; makes the niche legible |

## Contribute-back summary

The session also produced candidate fixes for `usagov/usagov-2021` itself —
five runtime robustness bugs and one config-graph fix that fire only when the
codebase is exercised via `site:install`/`pm:enable` rather than the GSA
DB-import pipeline. See `docs/usagov-2021-upstream-proposals.patch`.