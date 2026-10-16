# Implementation plan — the seven missing layers to a site-builder

**Date:** 2026-10-16
**Status:** not tracked here — the sweep gate, the committed records in
`sweep/records/`, and the roadmap in `docs/architecture.md` carry it. This
document is the plan: the seven layers, their dependency shape, and the
acceptance criteria per stage.
**Related:** `docs/sweep-harness-plan.md` (detailed plan for Stage A),
`docs/design-layers-plan.md` (detailed plan for Stage E),
`docs/analysis-1-conclusions.md` (findings this plan answers),
`docs/architecture.md` (roadmap), `kits/opencode/` (harness Phases 1–2, done)

## 0. The seven items, by current status

| # | Item | Spec |
|---|---|---|
| 1 | Sweep harness — mechanical, gated truth (failure-mode + corpus families) | detailed in `sweep-harness-plan.md` |
| 2 | State plane widening — typed reads of the content model | reads land with the slices that need them (see Stage B) |
| 3 | Content-level verification — assertions at building granularity | `verify_page` assertions, entity read-back (see Stage B) |
| 4 | Guarded write path — semantic, catalog-checked, verification-paired writes | replaces `drush_dispatch`-as-escape-hatch (see Stage C slices) |
| 5 | Knowledge for the building niche — module selection, recipes, freshness | corpus sweeps (item 1) decide what earns tokens |
| 6 | Reversibility — declared mutations, checkpoints, snapshots, scratch sites | a *principle* in the sweep plan, productized in Stage C |
| 7 | Design / UI / UX layers | detailed in `design-layers-plan.md`, gated behind this ladder |

Dependency shape:

```
1 sweep harness ──► everything (truth for all claims)
2 state reads ──► 3 content verification ──► 4 guarded writes
2,4 ──► 6 reversibility (checkpoint/snapshot pair with writes)
1 (corpus family) ──► 5 knowledge niche
2,4 ──► 7 design layers (D0–D4 per design-layers-plan.md)
```

Rule inherited from sweep-harness principle #3: every stage's work goes
through the planes. A sweep or feature that bypasses them tests nothing.

## Stage A — Make claims honest (item 1)

Scope: implement `sweep-harness-plan.md` Phases 1–2 (and Phase 4's report
skeleton), reusing its detailed spec — this stage does not restate it.

Deliverables:

- `sweep/runner.mjs`, `sweep/gate.mjs`, `sweep/lib/{record,fixture,planes}.mjs`,
  `sweep/instruments/{failure-mode,corpus}.mjs`, `sweep/records/` (committed)
- `npm run sweep:fm|sweep:corpus|sweep:gate|sweep:report`
- Family A Phase-1 targets: `unpopulated-field-fatal`,
  `library-css-category-assertion`, `critical-error-page` (re-graduates the
  5 hand-measured rows mechanically)
- Family B1 retrieval check over the 11 corpus fixtures
- `sweep:report` v1: pass rates with skipped/inconclusive listed separately
  (never folded in), plus the token-price table stub (analysis-1 P3) —
  cost per question per model vs the alternatives, filled as B2 lands

Acceptance criteria:

- ✓ `sweep:gate` enforces G1–G5; a deliberately fabricated `measured` row
  without a record fails the gate (the harness proves its own point)
- ✓ fixture health-checked before/after every sweep; teardown reverts
- ✓ corpus retrieval ranks recorded for all 11 fixtures; forbidden-doc hits
  propose ledger entries for human review

Size: M (the plan is already written; this is execution).
Later, not in Stage A: B2 answerability matrix, A2 expensive sweeps
(scratch-project installs), gate `--apply`.

## Stage B — Read the site like a builder (items 2 + 3)

Deliverables in `packages/state` (typed, secret-masked, normalizer-per-shape):

- `get_content_types` / `get_bundle_fields` — bundles, field definitions,
  cardinality, required flags
- `list_views` — machine names, base tables, displays
- `list_menus` (+ `get_menu_tree`), `list_roles` (+ `get_role_permissions`)
- `get_watchdog` — filtered recent entries (severity, channel)
- `check_route` — route exists + access for a role (cheap kernel check)

Deliverables in `packages/verify`:

- `verify_page` gains `expected` (substring) — the analysis-1 P1 item
- `verify_entity` — read back an entity's field values vs expected
  (id/uuid, bundle, field deltas), verdict first
- `verify_page` learns `expectNoCriticalLog` (pairs with `get_watchdog`)

Normalizer discipline: every new read is written defensively against Drush
12 output shapes **and swept via Stage A** (sweep-harness Phase 2 target —
this closes architecture roadmap item "sweep the normalizers").

Acceptance criteria:

- ✓ the `scripts/rebuild-usagov.mjs` driver is rewritten to use **only**
  plane tools — zero `drush php:eval` bypasses (analysis-1 gap #3's
  falsifiable exit: the gate is now the easy path)
- ✓ a deliberately mis-typed field value is caught by `verify_entity`,
  not by the model
- ✓ each new normalizer has a passing sweep record

Size: M–L (normalizers dominate).

## Stage C — Write like a builder, refuse like a catalog (items 4 + 6)

New `packages/writes`. `drush_dispatch` stays, unchanged, as the gated
escape hatch. Semantic tools on top, each with a fixed three-beat contract:

```
declare mutation → check catalog preconditions (refuse known-bad)
→ apply → run the paired verification recipe → verdict-first result
```

Initial tool set (smallest useful builder surface):

| Tool | Catalog pairing (precondition → recipe) |
|---|---|
| `install_module` | refuse undeclared dependencies (`undeclared-service-dependency`, measured) → `list_site_modules` read-back + `verify_page` |
| `create_content_type` / `add_field` | required-field rules → `get_bundle_fields` read-back + `verify_entity` |
| `create_content` | unpopulated-required-field refusal (`unpopulated-field-fatal`, measured) → `verify_entity` + `verify_page` |
| `set_permissions` | refuse roleless/empty grants → `get_role_permissions` read-back + probe as affected role |
| `place_block` / `configure_display` | region/display existence → state read-back + `verify_page` with `expected` |

Reversibility (item 6), the sweep plan's mutation-registry pattern
productized:

- `checkpoint_config` — export the touched config objects' prior values to
  a scratch dir before mutation; `restore_config` reverts them
- `snapshot_db` / `restore_db` — ddev snapshot wrappers, declared per write
  batch; heavy writes (updb, installs) require one
- every write result carries `revert: <how>` — the agent never has to invent
  an undo

Acceptance criteria:

- ✓ a scripted build ("content type + field + node + role + listing view +
  menu link") completes end-to-end through plane tools only, every write
  verified, whole task reversible
- ✓ the refusal path is demonstrated: an `install_module` with an undeclared
  dependency is refused by catalog precondition, not by luck
- ✓ a crashed mid-build leaves a resumable checkpoint (abort-marker pattern
  from `sweep/lib/fixture.mjs`)

Size: L.

## Stage D — Fill the building niche in knowledge (item 5)

Gated on Stage A's corpus results — the sweeps decide what earns tokens.

- Mine Family-B results for question classes the core corpus answers badly
  or not at all (expected: module selection, recipes, freshness/maintenance
  status)
- **Compose, don't duplicate**: contact the Drupal AI initiative re:
  Marcus Johansson's contrib-module corpus (~10,300 modules) — if its
  quality sweeps pass, federate it as a source rather than indexing contrib
  ourselves
- Add `guidance` rows (source type already exists) for the
  site-building failure modes graduated in Stage C
- Retire hand-written evals the mechanical sweeps replace (phpfloor
  regression per sweep-harness Phase 3)

Acceptance criteria:

- ✓ "for X in Drupal 11.4, which maintained module" is answerable with
  citations + maintenance status, measured by a corpus fixture
- ✓ knowledge-plane usage during a Stage-C build is nonzero *and*
  justified by the token-price table (analysis-1's zero-questions finding
  becomes a measured exception, not a habit)

Size: S–M, mostly coordination.

## Stage E — Design layers (item 7)

Execute `design-layers-plan.md` D0–D4 as written. Dependencies only:

- D0 (`expected` param, registry/library reads) — needs Stage B
- D2 (`verify_axe`, `verify_markup`) — needs Stage A instruments pattern
- D4 (guarded design writes, `/preview` gate, `verify_visual`) — needs
  Stage C's write contract; the design write tools are instances of it

No new sweep machinery — design failure rows (8 seeded in the design plan)
graduate through Family A on the same fixture.

Size: L overall; each D-phase independently shippable.

## Milestone ladder

| Exit | You can honestly say |
|---|---|
| A | "Every claim in the catalog is mechanically reproducible, and the gate refuses claims without records" |
| A+B | "An agent can read the whole content model and verify content delivery through the planes — nothing needs the bypass" |
| A+B+C | "An agent can build a site increment through planes only: refuse known-bad, write typed, verify paired, revert anything" — **the site-builder milestone** |
| +D | "It picks modules and recipes with cited, fresh knowledge" |
| +E | "It builds and verifies the presentation layer, with 508 conformance measured and design approval human-gated" |

## Non-goals (unchanged)

- No verify-gate plugin until harness signals show rule-skipping
- No pairing with the drupal/mcp module / AI agents framework until their
  conventions harden
- No generative design; taste stays at the human `/preview` gate
- No auto-fixing inside sweeps; sweeps propose, fixes are commits

## Open questions

1. **Resolved (2026-10-16): writes-first.** Stage C proceeds as vertical
   slices — each slice is one write tool *plus* the minimum reads and
   verification it needs, not a Stage-then-B order:
   - Slice 1: `create_content` + `get_bundle_fields` + `verify_entity` +
     `delete_content` (revert) — the `unpopulated-field-fatal` row is
     already measured, so its precondition is catalog-backed on day one.
   - Slice 2: `create_content_type` / `add_field` + display read-back.
   - Slice 3: `set_permissions` + `list_roles` / `get_role_permissions`.
   - Slice 4: `install_module` + the refusal path (precondition on the
     measured `undeclared-service-dependency` row).
   - Slice 5: `place_block` / `configure_display`.
   Stage B's remaining reads land with the slices that need them; the sweep
   harness (Stage A) catches up on normalizer graduation in parallel.
2. Does `verify_entity` support revisions from day one, or revisions later?
   Propose: latest-only first; revision-aware read-back when migrations
   arrive.
3. Stage D: does the contrib federation require embedding-provider alignment
   with drupal-dev-mcp's optional LanceDB, or lexical-only composition?
   Propose: decide after reading Johansson's evals.
4. Token accounting method for the Stage A report: MCP usage fields when
   reported, labeled estimates otherwise (per sweep-harness open question 4).
