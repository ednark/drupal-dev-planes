# Analysis 4: knowledge-plane proxy frictions (planes ↔ drupal-dev-mcp)

**Date:** 2026-10-16
**Scope:** the composition between this repo and
[drupal-dev-mcp](https://github.com/ednark/drupal-dev-mcp) — specifically the
thin proxy in `packages/knowledge` + `packages/server/src/tools/knowledge.ts`
that runs drupal-dev-mcp as a child stdio MCP server and exposes 3 of its 7
tools.

**Evidence status: `claimed` (informal smoke test).** Findings below come from
a live smoke run on 2026-10-16 (spawning
`packages/server/dist/index.js` with the real `.env` wiring and driving it as
an MCP client), not from a committed sweep record. They are observations, not
graduated catalog claims. A `sweep/` family for proxy-contract drift would be
the way to graduate them.

## What was verified working

- `get_index_status` through the proxy: ~290 ms round trip, envelope intact,
  upstream `structuredContent` passed through under `data`, provenance stamped
  `source: drupal-dev-mcp`.
- `search_drupal` through the proxy: ~1.4 s, results with `drupal://`
  citations, `appliedFilters` echoed in the response.
- Degradation: with `DRUPAL_DEV_MCP_COMMAND` unset, knowledge tools return
  `status: unavailable` with a recovery hint while state/verification keep
  working — the per-plane independence documented in
  [architecture.md](architecture.md) holds in practice.
- Connect-failure retry: `shared.ts` resets the lazy knowledge client after a
  failed connect, so a crashed child is not a permanently wedged plane.
- State plane independence: `get_site_status` worked through the ddev shim
  against the live usagov2021 site (Drupal 10.6.17) in the same session.

## Frictions found

### 1. The `ent_` dead-end (highest impact)

`search_drupal` returns both `document` and `entity` result rows. Observed:

```text
resultTypes: entity:ent_b1RYx1bN, document:doc_x9xVmUC0, document:doc_0ok0UStt
```

The proxy exposes only `get_index_status`, `search_drupal`,
`get_drupal_document`. Upstream's `get_drupal_entity`,
`get_drupal_entities`, and `explore_drupal_relationships` are **not**
proxied, so an agent that receives an `ent_…` id from a proxied search
cannot resolve it through this server — the call returns
`MCP error -32602: Tool get_drupal_entity not found`.

Consequences:

- `SKILL.md`'s token-discipline line "carry `ent_…`/document URIs forward" is
  half-dangling: `doc_` URIs resolve via `get_drupal_document`; `ent_` URIs
  dead-end.
- Upstream's relationship traversal (API genealogy: extends/implements/
  subscribes_to/…) is unreachable through this composition, even though it is
  one of the knowledge plane's better features for "unfamiliar
  API/hook/service" tasks from the routing table.

**Fix options:** proxy `get_drupal_entity` + `get_drupal_entities`
(smallest change that closes the dead-end), or filter entity rows out of
proxied search results so agents never receive unresolvable ids. Proxying
`explore_drupal_relationships` is a separate, optional decision.

### 2. Version enum narrower than upstream, with a silent 11.4 default

Planes pins `drupal_version: "10.6" | "11.4" | "all"`; upstream accepts
`"10.6" | "11.4" | "12.0" | "all"`. Two behaviors observed:

- A `12.0` query fails with a raw zod validation error
  (`Invalid enum value. Expected '10.6' | '11.4' | 'all', received '12.0'`)
  rather than a plane-styled refusal. The README's "not drupal-dev-mcp's full
  set" note acknowledges the pin, but the failure shape is unhelpful.
- Omitting `drupal_version` passes nothing upstream, which **silently
  defaults to 11.4** — while the paired test site runs **10.6**. An agent
  following SKILL.md rule 1 (query at the version `get_site_status` reports)
  avoids this, but a careless call gets 11.4 evidence for a 10.6 site with
  only the echoed `appliedFilters.drupalVersion` as a tell.

**Fix options:** require `drupal_version` in the proxy schema (no silent
default), and/or return a plane-styled `refused`/`error` envelope with a
recovery note when the enum rejects a value instead of surfacing the raw zod
error.

### 3. Per-call token weight

Every proxied `search_drupal` response embeds the full upstream index-status
block (counts, verification, warnings, build path) — the same payload
`get_index_status` already returns on demand. For a plane whose skill doc
preaches token discipline, this is per-call overhead the proxy could trim
(keep `runId`/`builtAt`/`degradedMode`; drop counts + verification unless the
agent asks).

### 4. No contract test for the one distributed plane

`tests/` covers state reads, verification, writes, normalizers, and
answerability — but nothing pins the upstream tool schemas the proxy depends
on. drupal-dev-mcp is a separate repo evolving on its own; upstream gaining a
required parameter or changing `structuredContent` shape would break the
knowledge plane at runtime, not in CI.

**Fix option:** a contract smoke test that spawns the upstream server (when
available) and asserts the three proxied tools' advertised schemas match what
`tools/knowledge.ts` forwards. Skipped (not failed) when drupal-dev-mcp is
not built — skipped never folds into pass rates, same rule as the sweep gate.

### 5. `DRUPAL_DEV_MCP_ARGS` splitting breaks on paths with spaces

`packages/server/src/config.ts` splits the value on `[\s,]+`. A
drupal-dev-mcp checkout living under a path containing a space yields a
wrong argv. The README documents comma/space separation but never warns
about spaces *inside* a path.

**Fix options:** document the constraint prominently, or support a
JSON-array form (`DRUPAL_DEV_MCP_ARGS='["/path with space/…", …]'`).

## Summary table

| # | Friction | Impact | Effort |
|---|---|---|---|
| 1 | `ent_` ids unresolvable through the proxy | agents hit a dead-end on entity results | small |
| 2 | narrower version enum + silent 11.4 default | version-mismatch evidence for the site's version | small |
| 3 | index-status block embedded in every search | per-call token overhead | small |
| 4 | no upstream contract test | proxy drift breaks only at runtime | medium |
| 5 | ARGS splitting vs paths with spaces | broken argv, rare but total | trivial |

## Related

- [architecture.md](architecture.md) — the composition-not-reimplementation
  decision this analysis evaluates.
- [analysis-3-sweep-findings.md](analysis-3-sweep-findings.md) — findings from
  the live sweep runs (state/verify/write planes).
- drupal-dev-mcp `docs/tools-spec.md` — the upstream wire contract the proxy
  depends on.
