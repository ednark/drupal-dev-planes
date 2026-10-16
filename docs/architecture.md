# Architecture: drupal-agent-planes

Three planes of truth for Drupal development agents, composed as one MCP
interface.

## Why three planes

An agent doing Drupal work conflates three different kinds of truth, each with
different freshness, authority, and failure characteristics:

| Plane | Question | Truth lives in | Failure mode when conflated |
|---|---|---|---|
| **knowledge** | What is true in Drupal 11.4? | Versioned, cited, measured corpus (drupal-dev-mcp index) | Guessing APIs from stale training data ("Drupal 7-shaped hooks") |
| **state** | What is true on *this site* right now? | The running site: config, modules, entities, routes | Editing YAML blind, assuming state |
| **verification** | Did the write actually take effect? | The delivered result, not the commit response | Trusting a 0 exit code / HTTP 200 |

The design principle, borrowed from mosaic-headless: **never trust the
commit**. A successful write is not evidence of a working site. Every mutation
must be followed by a read-back through the verification plane, and the
verification plane must know Drupal's silent failure modes explicitly.

## Composition, not reimplementation

The knowledge plane is **drupal-dev-mcp, unchanged**. This repo runs it as a
child MCP server (stdio) and proxies a minimal subset of its tools with a
`knowledge` plane label. drupal-dev-mcp keeps its trust boundary (read-only
evidence, closed world); this repo owns composition and cross-plane joins.

```
┌─ agent loop (reasoning, budgets, approvals — see drupal-dev-mcp
│  docs/integration-agent-loops.md for the loop-side contract)
│
├─ packages/knowledge  → knowledge plane: MCP client of drupal-dev-mcp
├─ packages/state      → state plane: drush-backed normalized reads
├─ packages/verify     → verification plane: read-back diffs + page probes
├─ packages/server     → one stdio MCP server exposing all three planes
└─ data/failure-modes.json → the measured-vs-claimed failure-mode catalog
```

## Tool map (0.1)

| Tool | Plane | Annotations | What it does |
|---|---|---|---|
| `get_index_status` | knowledge | read-only | Proxy: drupal-dev-mcp build readiness |
| `search_drupal` | knowledge | read-only | Proxy: cited evidence search |
| `get_drupal_document` | knowledge | read-only | Proxy: exact indexed text for citation checks |
| `get_site_status` | state | read-only | Normalized `drush status` |
| `get_site_config` | state | read-only | Normalized, secret-masked `drush config:get` |
| `list_site_modules` | state | read-only | Normalized `drush pm:list` |
| `drush_dispatch` | state | **destructive, gated** | Explicit drush invocation; unavailable unless `DRUPAL_AGENT_ALLOW_EXEC=true` |
| `verify_config` | verification | read-only | Read back a config object, diff against expected, verdict first |
| `verify_page` | verification | read-only | Probe a delivered URL: 5xx = dead, critical-error marker = dead, <64-byte 200 = suspicious |
| `explain_config` | cross-plane | read-only, open-world | Join: live state value + knowledge evidence for one config key |
| `list_failure_modes` | cross-plane | read-only | The failure-mode catalog with evidence status per row |

## Response envelope

Every tool returns:

```json
{
  "plane": "verification",
  "status": "ok | state_unavailable | knowledge_unavailable | unavailable | error",
  "data": { "verdict": "...", "...": "..." },
  "notes": ["pointers to failure modes and next verification steps"],
  "provenance": { "source": "...", "siteRoot": "..." }
}
```

Verdict-first where a verdict exists; provenance always; graceful degradation
per plane (a missing drupal-dev-mcp or drush never removes the other planes).

## Honest status: claimed vs measured

Following the mosaic-headless discipline, `data/failure-modes.json` ships every
row with `evidenceStatus: "claimed"`. Nothing is measured yet. Graduating a row
requires a sweep against a live Drupal install that (1) reproduces the failure,
(2) proves the detection recipe catches it, (3) records the result beside the
row. Normalizers in `packages/state` are written defensively against Drush 12
output shapes and must be swept the same way.

## Roadmap

(Executed per [docs/site-builder-implementation-plan.md](site-builder-implementation-plan.md).)

1. **Sweep the catalog.** Scratch Drupal site; reproduce each failure mode;
   verify the detection recipe; graduate rows to `measured`.
2. **Sweep the normalizers** against Drush 12 output (status, pm:list,
   config:get in both key and full-object shapes).
3. **Publish the token price** of each tool against the alternative (reading
   api.drupal.org, editing YAML blind) — the mosaic-headless pricing table,
   adapted.
4. **Grow the state plane** (content entities, routes, roles/permissions,
   applied recipes) once the read surface is measured.
5. **Guarded write path**: checkout → check (refuse what the catalog says
   breaks) → commit → verify, with the catalog as the check's rule set.
6. **Design / UI / UX layers**: planned placement in
   [docs/design-layers-plan.md](design-layers-plan.md) — design-aware plane
   extensions plus a sibling design pack; gated behind this ladder.
7. **Multi-harness distribution**: this SKILL.md is the seed for Cursor rules
   and Codex/Copilot rule files, mosaic-headless style — same discipline,
   two transports. First transport exists: `kits/opencode/` (harness
   Phases 1–2, per `docs/OpenCode Agentic Engineering Harness.md`).