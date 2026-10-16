---
name: drupal-dev-planes
description: Four-plane discipline for Drupal development agents — versioned knowledge, live site state, verified writes, guarded write tools. Use when building or changing a Drupal site with an agent that has the drupal-dev-planes MCP server configured.
---

# The four planes

Every question in Drupal development belongs to one of four planes. Name the
plane before acting; the tool responses carry a `plane` field to keep you
honest.

| Plane | Question | Tools |
|---|---|---|
| knowledge | What is true in this Drupal version? | `get_index_status`, `search_drupal`, `get_drupal_document` |
| state | What is true on this site right now? | `get_site_status`, `get_site_config`, `list_site_modules`, `list_views`, `list_menus`, `list_roles`, `get_watchdog`, `check_route`, `drush_dispatch` (gated) |
| verification | Did the write actually take effect? | `verify_config`, `verify_page` (with `expected`), `verify_entity` |
| writes | What may be written, and how is it reverted? | `create_content`, `create_content_type`, `add_field`, `delete_content` — catalog-checked, gated, paired with their verification recipes |

Cross-plane: `list_failure_modes` (the catalog of how Drupal fails silently),
`check_claim_support` (does cited evidence actually support the claims?).

## The writes plane

`create_content` is the guarded write, not a convenience: it refuses
catalog-known-bad moves before touching the site, and every successful call
returns a `revert` declaration (`delete_content` with the target uuid). Never
work around a refusal with `drush_dispatch` — the refusal is the catalog
doing its job. After a create: `verify_entity` (verdict-first read-back),
then `verify_page` on the entity's URL.

## The four rules

1. **Never write from memory.** Ground API facts in the knowledge plane —
   `search_drupal` for the fact and its change records, `get_drupal_document`
   to verify the citation text. Query knowledge at the version `get_site_status`
   reports for *this* site: read the running version first, then ground the
   API fact at that version. Your training data is not a Drupal version.

2. **Never assume state.** Read it: `get_site_config` for the current value,
   `list_site_modules` for what is actually enabled, `get_site_status` for the
   running version. What you wrote earlier in this session is not what is on
   the site.

3. **Never trust the commit.** An exit code of 0 is not evidence of a working
   site. After every write — a guarded write tool *or* `drush_dispatch` — run
   the paired verification before claiming success:
   - `verify_config` — read back the config object and diff against what you
     intended. Verdict first.
   - `verify_entity` — read back a created/changed entity and diff.
   - `verify_page` — probe an affected URL. Only `alive` means delivered;
     `server_error`/`error_page`/`http_error`/`suspicious_short`/`content_missing`
     all mean it did not.
   - The write tool's `notes` name the exact follow-up. Cite the verification
     results, not the commit.

4. **Never route around a refusal.** A `refused` result is the catalog
   preventing a known site-breaking move. Fix the cause (populate the field,
   resolve the reference, enable the dependency) — do not retry the same call
   or fall back to `drush_dispatch` to force it.

## Routing table

| Task | Sequence |
|---|---|
| Add/change a config key | `search_drupal` (what it means, at the site's version) → `get_site_config` (current value) → write via `drush_dispatch` (no guarded config-write tool yet) → `verify_config` → `verify_page` |
| Install/enable a module | `install_module` — it scans dependencies and service references first and **refuses** the install-crash class; on success read back with `list_site_modules`. Do not enable via raw `drush_dispatch` |
| Create a content type / field | `create_content_type` (refuses duplicates) → `get_bundle_fields` read-back; `add_field` (refuses missing bundle / duplicate field) → `get_bundle_fields` read-back |
| Grant/revoke a permission | `list_roles` (does the role exist?) → `set_permissions` (refuses unknown role/permission) → `list_roles` read-back |
| Place a block / set a formatter | `place_block` (refuses bad theme/region/id) → `verify_page` with `expected`; `configure_display` performs its own read-back |
| Diagnose "change didn't take" | `list_failure_modes` → run the matching detection recipe (usually `verify_page` + `get_site_config`); `get_watchdog` for new error-class entries since the write |
| Create content | `find_content` (does it already exist? idempotency is a read) → `get_bundle_fields` (required fields — you must populate them) → `create_content` → `verify_entity` → `verify_page`. `create_content` refuses unpopulated required fields; the refusal includes each field's type — resolve entity_reference targets with `find_term`. If `find_term` finds no term, the field is unsatisfiable on this site: do NOT retry, surface it to the user |
| "Where does X live / how does X work?" | `search_drupal` — knowledge plane, no writes |
| Unfamiliar API/hook/service | `search_drupal` + `get_drupal_document`; check version compatibility and deprecations before writing any code |

## Token discipline

Read surfaces are normalized summaries, not raw dumps. Don't re-fetch what a
previous call already returned; carry `ent_…`/document URIs forward. When a
response includes `notes`, act on them before claiming completion — they are
the verification contract, not decoration.

## Gates

- `drush_dispatch` is unavailable unless the server env sets
  `DRUPAL_AGENT_ALLOW_EXEC=true`. If unavailable, surface that to the user
  rather than attempting a workaround.
- Planes degrade independently: no knowledge server configured → state and
  verification still work, and vice versa. Report degraded status honestly in
  your answers.