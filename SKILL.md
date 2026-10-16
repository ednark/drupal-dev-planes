---
name: drupal-agent-planes
description: Three-plane discipline for Drupal development agents — versioned knowledge, live site state, verified writes. Use when building or changing a Drupal site with an agent that has the drupal-agent-planes MCP server configured.
---

# The three planes

Every question in Drupal development belongs to one of three planes. Name the
plane before acting; the tool responses carry a `plane` field to keep you
honest.

| Plane | Question | Tools |
|---|---|---|
| knowledge | What is true in this Drupal version? | `get_index_status`, `search_drupal`, `get_drupal_document` |
| state | What is true on this site right now? | `get_site_status`, `get_site_config`, `list_site_modules`, `drush_dispatch` (gated) |
| verification | Did the write actually take effect? | `verify_config`, `verify_page`, `verify_entity` |
| writes | What may be written, and how is it reverted? | `create_content`, `delete_content` — catalog-checked, gated, paired with their verification recipes |

Cross-plane: `explain_config` (state + knowledge join), `list_failure_modes`
(the catalog of how Drupal fails silently).

## The writes plane

`create_content` is the guarded write, not a convenience: it refuses
catalog-known-bad moves before touching the site, and every successful call
returns a `revert` declaration (`delete_content` with the target uuid). Never
work around a refusal with `drush_dispatch` — the refusal is the catalog
doing its job. After a create: `verify_entity` (verdict-first read-back),
then `verify_page` on the entity's URL.

## The three rules

1. **Never write config from memory.** Before writing a config key, a service
   reference, or a hook implementation, ground it in the knowledge plane —
   `search_drupal` for the API fact and its change records, `get_drupal_document`
   to verify the citation text. Your training data is not a Drupal version.

2. **Never assume state.** Read it: `get_site_config` for the current value,
   `list_site_modules` for what is actually enabled, `get_site_status` for the
   running version. What you wrote earlier in this session is not what is on
   the site.

3. **Never trust the commit.** An exit code of 0 is not evidence of a working
   site. After every write through `drush_dispatch`:
   - `verify_config` — read back the config object and diff against what you
     intended. Verdict first.
   - `verify_page` — probe an affected URL. 5xx means dead, the
     critical-error marker means dead, a 200 under 64 bytes means suspicious.
   - Only then claim success, citing the verification results.

## Routing table

| Task | Sequence |
|---|---|
| Add/change a config key | `search_drupal` (what it means, which version) → `get_site_config` (current value) → write via `drush_dispatch` → `verify_config` → `verify_page` |
| Install/enable a module | `list_site_modules` (already enabled?) → `drush_dispatch` → `list_site_modules` (read-back) |
| Diagnose "change didn't take" | `list_failure_modes` → run the matching detection recipe (usually `verify_page` + `get_site_config`) |
| Create content | `get_bundle_fields` (required fields — you must populate them) → `create_content` → `verify_entity` → `verify_page`. `create_content` refuses unpopulated required fields; the refusal is the catalog protecting the site, fix the values and retry |
| "Where does X live / how does X work?" | `explain_config` or `search_drupal` — knowledge plane, no writes |
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