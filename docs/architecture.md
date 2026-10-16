# Architecture: drupal-dev-planes

Four planes for Drupal development agents, composed as one MCP interface:
three planes of *evidence* (knowledge, state, verification) and one guarded
*action* surface (writes).

## Why these planes

An agent doing Drupal work conflates different kinds of truth, each with
different freshness, authority, and failure characteristics:

| Plane | Question | Truth lives in | Failure mode when conflated |
|---|---|---|---|
| **knowledge** | What is true in Drupal 11.4? | Versioned, cited, measured corpus (drupal-dev-mcp index) | Guessing APIs from stale training data ("Drupal 7-shaped hooks") |
| **state** | What is true on *this site* right now? | The running site: config, modules, entities, routes | Editing YAML blind, assuming state |
| **verification** | Did the write actually take effect? | The delivered result, not the commit response | Trusting a 0 exit code / HTTP 200 |
| **writes** | What may be committed, and how is it undone? | Guarded tools that check preconditions, apply, and name their verification | Raw writes that skip the catalog and leave half-committed state |

Writes is an *action* surface rather than a fourth kind of truth: it is the
only plane with side effects, it is gated, and every tool pairs its apply with
a verification recipe (returned as a note, or performed in-tool for
`configure_display`). The design principle, adapted from mosaic-headless (an
earlier Drupal harness): **never trust the commit**. A successful write is not
evidence of a working site. Every mutation must be followed by a read-back
through the verification plane, and the verification plane must know Drupal's
silent failure modes explicitly.

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
├─ packages/state      → state plane: drush-backed normalized reads + the
│                         shared php:eval transport
├─ packages/verify     → verification plane: page probes, config/entity diffs,
│                         claim support, the failure-mode catalog loader
├─ packages/writes     → writes plane: guarded content/type/field/permission/
│                         module/block/display ops (precondition → apply → verify)
├─ packages/server     → one stdio MCP server: shared.ts (envelope + transport)
│                         + tools/<plane>.ts, one registration module per plane
└─ data/failure-modes.json → the measured-vs-claimed failure-mode catalog
```

## Tool map

The full, current tool table lives in the [README](../README.md#tools) — one
place, so it cannot drift from the registered tools. The plane → package
mapping is what this document owns:

| Plane | Package | Server module | Side effects |
|---|---|---|---|
| knowledge | `packages/knowledge` | `tools/knowledge.ts` | none (proxied reads) |
| state | `packages/state` | `tools/state.ts` | none, except the gated `drush_dispatch` escape hatch |
| verification | `packages/verify` | `tools/verification.ts` | none |
| writes | `packages/writes` | `tools/writes.ts` | **yes** — gated by `DRUPAL_AGENT_ALLOW_EXEC` |
| cross-plane | (joins) | `tools/cross_plane.ts` | none |

## Response envelope

Every tool returns:

```json
{
  "plane": "verification",
  "status": "ok | refused | state_unavailable | knowledge_unavailable | unavailable | error",
  "data": { "verdict": "...", "...": "..." },
  "notes": ["pointers to failure modes and next verification steps"],
  "provenance": { "source": "...", "siteRoot": "..." }
}
```

`status` semantics: `ok` (the call ran; for verification, `data.verdict`
carries the actual result — a `verify_page` can be `status: ok` with
`verdict: server_error`); `refused` (a write precondition failed, the site was
not touched); `state_unavailable` / `knowledge_unavailable` (that plane cannot
be reached — each carries a recovery hint in `notes`); `unavailable` (the tool
is gated off); `error` (the call ran and failed). Verdict-first where a verdict
exists; provenance always; graceful degradation per plane (a missing
drupal-dev-mcp or drush never removes the other planes).

## Honest status: claimed vs measured

Following the same discipline as the predecessor harness, `data/failure-modes.json` carries
every row's `evidenceStatus` — `claimed` until graduated to `measured`.
Graduation is enforced, not asserted: the sweep gate (`npm run sweep:gate`)
requires a committed record in `sweep/records/` showing that a live sweep
(1) reproduced the failure, (2) proved the detection recipe catches it,
before a row may say `measured`. Normalizers in `packages/state` and
`packages/writes` are written defensively against Drush output shapes and
graduate through the same sweep discipline.

## Roadmap

(Executed per [docs/site-builder-implementation-plan.md](site-builder-implementation-plan.md).)

1. **Sweep the catalog.** Scratch Drupal site; reproduce each failure mode;
   verify the detection recipe; graduate rows to `measured`.
2. **Sweep the normalizers** against Drush 12 output (status, pm:list,
   config:get in both key and full-object shapes).
3. **Publish the token price** of each tool against the alternative (reading
   api.drupal.org, editing YAML blind) — the pricing-table instrument,
   adapted from the predecessor harness.
4. **Grow the state plane** (content entities, routes, roles/permissions,
   applied recipes) once the read surface is measured.
5. **Guarded write path**: checkout → check (refuse what the catalog says
   breaks) → commit → verify, with the catalog as the check's rule set.
6. **Design / UI / UX layers**: planned placement in
   [docs/design-layers-plan.md](design-layers-plan.md) — design-aware plane
   extensions plus a sibling design pack; gated behind this ladder.
7. **Multi-harness distribution**: this SKILL.md is the seed for Cursor rules
   and Codex/Copilot rule files, as the predecessor harness did — same
   discipline,
   two transports. First transport exists: `kits/opencode/` (harness
   Phases 1–2, per `docs/OpenCode Agentic Engineering Harness.md`).