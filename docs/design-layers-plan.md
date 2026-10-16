# Design / UI / UX layers — where they sit

**Date:** 2026-10-16
**Gated on the ladder in `site-builder-implementation-plan.md` (Stage E).**
Complements `docs/sweep-harness-plan.md` (the harness this design reuses)
and `docs/architecture.md` (the three planes this extends).

## 1. The thesis

The design layers are the **same three-plane problem with different evidence
types** — not a new architecture. A design agent conflates exactly the same
three truths an implementation agent does:

| Plane | Implementation framing (built) | Design framing (missing) |
|---|---|---|
| knowledge | "What is true in Drupal 11.4?" | "What components/tokens/templates exist in *this theme at this version*, and what are their contracts?" |
| state | "What is true on this site right now?" | "Which theme is active, what does the theme registry actually resolve, which libraries are attached, how are fields formatted?" |
| verification | "Did the write take effect?" | "Is the right markup actually delivered, does it pass WCAG/508, and does it look the same as before?" |

The failure class is also the same — **silent partial success**. The
catalog's one design-adjacent measured row proves it:
`library-css-category-assertion` (config import reported success; every page
500'd on a bare `css:` entry). The design layer's dominant failure is the
quieter sibling: library attached but never loaded, template in the registry
but stale, component schema violated so the fallback renders, asset build
stale — all "the write took effect, the design did not."

## 2. The two-part placement decision

### Part A — make the existing planes design-aware (small, near-term)

Do not fork the planes. Extend them minimally so the design layer shares the
same envelope, provenance, and gates:

- **State plane additions** (typed reads, no `php:eval`):
  - `get_theme_registry` — resolved twig candidates for a template hook
    (which file actually wins, and what is stale);
  - `list_sdc_components` — discovered components per theme, with their
    `.component.yml` contract versions;
  - `get_libraries_attached` — libraries attached to a route/page/theme;
  - `get_display_settings` — view modes / formatters for a bundle.
- **Verification plane additions**:
  - `verify_page` gains an `expected` substring parameter (already P1) and
    structural markers (expected/absent class hooks — enough for "the USWDS
    component classes actually rendered");
  - `verify_markup` — read back the delivered DOM subtree for a selector and
    diff against an expected shape (predecessor to full visual regression).
- **Write path**: when the guarded write path lands (roadmap #5), its
  catalog pairing includes the design rows — a `attach_library`-class write
  auto-probes the affected page; a theme-setting write auto-verifies config
  *and* rendered output.

### Part B — a sibling design pack, not a fourth plane (heavy evidence)

Visual and accessibility evidence needs heavy dependencies (headless browser,
axe engine, image diffing) that must not bloat the core server's footprint
(harness-doc rule: lean tool sets; compaction cannot free tool schemas).
So: a sibling server — working name **drupal-design-planes** — with the same
response envelope and provenance discipline, composing against the same
fixture site:

```
drupal-design-planes/
  knowledge  → SDC contracts, design tokens, theme docs, USWDS registry
  state      → theme/registry/library/display reads (Part A tools, shared)
  verify     → verify_axe (WCAG 2.1 AA / Section 508), verify_visual
               (screenshot + pixel diff per breakpoint), verify_component
               (rendered props vs .component.yml schema)
  writes     → guarded: create_sdc_component, attach_library,
               place_block, set_theme_setting, configure_display
  data/design-failure-modes.json → same claimed→measured discipline
```

The knowledge plane here is deliberately **small and high-value**, unlike the
core corpus debate: SDC `.component.yml` files are machine-readable contracts
(JSON-schema props/slots) — indexing them per theme/version is cheap and
answers questions no training data holds ("does this theme's card component
take a media slot?"). The USWDS angle rides the existing `uswds-registry`
skill (component registry, Drupal-USWDS mapping, Section 508 conformance);
converting it into the pack's knowledge surface is a natural first corpus.

### What the pack does NOT do

- **Taste, brand, layout judgment.** Design approval stays human. The
  harness gains a fourth gate — a `/preview` step that attaches screenshots
  to the human review — alongside spec, tests, and merge.
- **No generative design.** The pack verifies and places; it does not invent
  visual identity. That keeps it inside the verification discipline ("never
  trust the commit" — a screenshot nobody reviewed is a claim, not
  evidence).

## 3. Design failure-mode catalog (seed rows, all `claimed`)

| Row | Reproduce | Detect |
|---|---|---|
| `theme-registry-stale` | drop a new twig template, no `cr` | `get_theme_registry` shows old candidate |
| `sdc-schema-violation` | pass wrong prop type to a component | `verify_component` vs `.component.yml` schema |
| `library-attached-not-loaded` | attach library, break category silently (the measured row's quiet cousin) | `get_libraries_attached` + rendered `<link>/<script>` probe |
| `asset-build-stale` | change Sass, skip build | byte/hash delta on delivered CSS |
| `display-formatter-mismatch` | set formatter that drops markup | `verify_markup` structural diff |
| `block-region-missing` | place block into removed region | state read + page probe |
| `axe-violation-class` | remove alt/label in fixture | `verify_axe` on affected page |
| `breakpoint-overflow` | wide fixed-width component | `verify_visual` diff at 360px |

These graduate through the same sweep harness (Family A), on the same
fixture — the design pack adds no new sweep machinery, only instruments.

## 4. Sequencing (explicitly after the implementation ladder)

The design pack is gated on the implementation ladder from the roadmap
discussion: sweep harness → state-plane widening → content-level
verification → guarded writes. Rationale: the design layer reuses all four;
building it first would mean building verification and write-pairing
machinery twice.

| Phase | Deliverable | Exit criterion |
|---|---|---|
| D0 | Part A plane extensions (`expected` param, registry/library reads) | a page with a known library failure is caught by plane tools alone |
| D1 | SDC/USWDS contract corpus + `list_sdc_components`/`get_theme_registry` | "does theme X's component Y take slot Z" answerable with citation |
| D2 | `verify_axe` + `verify_markup` | a seeded 508 violation and a seeded markup drift are caught mechanically |
| D3 | design pack server + design-failure-mode sweeps | ≥3 design rows graduated to `measured` |
| D4 | guarded design writes + `/preview` gate + `verify_visual` | a block-placement write refuses a known-bad region and verifies the good one |

## 5. Ecosystem alignment

- **SDC + recipes + Canvas** are where Drupal CMS site-building is heading
  (22 AI agents, SDC-driven page building at DrupalCon 2026); the design
  pack's component-contract corpus is the agent-facing counterpart.
- **UI Suite Drupal / UI Patterns** pattern is the community's
  design-system-driven build; the contract corpus should index their
  component shapes too, not just USWDS.
- **Section 508 / WCAG** is a standing conformance requirement for
  government Drupal work, not a nice-to-have — `verify_axe` makes it a
  measured property instead of a claim.
- **Interop deferral holds**: no pairing with the drupal/mcp module or the
  AI agents framework until their conventions harden (sweep non-goal #2);
  the design pack inherits that decision.

## 6. What this plan deliberately does not decide

- Whether `verify_visual` runs per-write, per-feature, or nightly
  (suggest: per-feature via `/preview`, nightly sweep for drift).
- Screenshot baseline storage and review UX (belongs to the `/preview`
  command design).
- Whether the design knowledge corpus federates with the Drupal AI
  initiative's contrib corpus or stays theme-scoped (open until the corpus
  sweep measures what earns tokens).
