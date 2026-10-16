# drupal-agent-planes

A unified three-plane MCP interface for Drupal development agents:

- **knowledge** — what is true in a given Drupal version. Composed from
  [drupal-dev-mcp](https://github.com/ednark/drupal-dev-mcp), unchanged: a
  versioned, cited, closed-world evidence index. This repo runs it as a child
  MCP server and proxies a minimal subset of its tools.
- **state** — what is true on *this site* right now. Drush-backed, normalized,
  secret-masked reads of the running site's config and modules.
- **verification** — did the write actually take effect? Read-back diffs and
  page probes built around one rule borrowed from mosaic-headless:
  **never trust the commit**. An exit code of 0 is not evidence of a working
  site.

Plus `data/failure-modes.json`: a Drupal failure-mode catalog where every row
is honest about its evidence status (`claimed` until swept against a live
install and graduated to `measured`).

## Why

An agent doing Drupal work fails by conflating three kinds of truth: it edits
YAML blind (guessing state from stale training data), and trusts a successful
commit. This server keeps the planes separate, labels every response with its
plane and provenance, degrades gracefully per plane, and pairs every write
with a verification recipe. See [docs/architecture.md](docs/architecture.md).

## Quick start

```bash
npm install
npm run build
npm test
npm run mcp:start
```

The server runs on stdio. Every tool works standalone; the knowledge plane
activates when drupal-dev-mcp is configured, the state plane when drush and a
site root are configured.

## MCP client configuration

```json
{
  "mcpServers": {
    "drupal-agent-planes": {
      "command": "node",
      "args": ["/absolute/path/to/drupal-agent-planes/packages/server/dist/index.js"],
      "env": {
        "DRUPAL_DEV_MCP_COMMAND": "node",
        "DRUPAL_DEV_MCP_ARGS": "/absolute/path/to/drupal-dev-mcp/packages/server/dist/index.js",
        "DRUPAL_MCP_INDEX_ROOT": "/absolute/path/to/drupal-dev-mcp/data/index",
        "DRUPAL_SITE_ROOT": "/absolute/path/to/drupal-site",
        "DRUSH_BIN": "drush",
        "DRUPAL_AGENT_ALLOW_EXEC": "false"
      }
    }
  }
}
```

`DRUPAL_DEV_MCP_ARGS` is comma- or space-separated (quote-free).

## Tools

| Tool | Plane | Side effects | Does |
|---|---|---|---|
| `get_index_status` | knowledge | none | drupal-dev-mcp build readiness; cite `builtAt` when freshness matters |
| `search_drupal` | knowledge | none | Cited evidence search across the versioned index |
| `get_drupal_document` | knowledge | none | Exact indexed text, for verifying citations without re-searching |
| `get_site_status` | state | none | Normalized `drush status` (versions, root, bootstrap) |
| `get_site_config` | state | none | Normalized `drush config:get`, secrets masked |
| `list_site_modules` | state | none | Normalized `drush pm:list` |
| `drush_dispatch` | state | **yes, gated** | Explicit drush invocation; unavailable unless `DRUPAL_AGENT_ALLOW_EXEC=true` |
| `verify_config` | verification | none | Read back a config object, diff against expected, **verdict first** |
| `verify_page` | verification | none | Probe a delivered URL: 5xx = dead, critical-error marker = dead, <64-byte 200 = suspicious |
| `list_views` / `list_menus` / `list_roles` | state | none | Typed reads: views, menus, roles (+permission filter for roles) |
| `get_watchdog` | state | none | 50 most recent watchdog entries — the post-write check for silent fatals |
| `check_route` | state | none | Does a route exist for a path pattern / name, and what does it require? |
| `get_bundle_fields` | state | none | Field definitions for a bundle: name, type, required, cardinality |
| `create_content` | writes | **yes, gated** | Catalog-checked entity create: refuses unpopulated required fields (`unpopulated-field-fatal`, measured), returns the paired verification contract + declared revert |
| `verify_entity` | verification | none | Read back an entity and diff against what you intended; **verdict first** |
| `create_content_type` | writes | **yes, gated** | Create a node type; refuses duplicates; paired verification: `get_bundle_fields` read-back |
| `add_field` | writes | **yes, gated** | Add storage + instance to a bundle; refuses missing bundle / duplicate field; paired verification: read-back |
| `delete_content` | writes | **yes, gated** | Delete by id/uuid — the declared revert path for `create_content` |
| `explain_config` | cross-plane | none | Join: live state value + knowledge evidence for one config key |
| `list_failure_modes` | cross-plane | none | The failure-mode catalog, with evidence status per row |

Every response carries `plane`, `status`, `data` (verdict-first where a
verdict exists), `notes` (pointers to failure modes and next verification
steps), and `provenance`.

## The routing discipline

The matching agent skill (this repo's `SKILL.md`) encodes three rules:

1. **Never write config from memory.** Consult the knowledge plane before the
   state plane.
2. **Never assume state.** Read it (`get_site_config`, `list_site_modules`),
   don't infer it from what you wrote earlier.
3. **Never trust the commit.** After any write through `drush_dispatch`,
   verify through `verify_config` and/or `verify_page` before claiming
   success — and treat a plain "config imported" as unverified delivery.

## Harness kit

The execution plan for the remaining layers (sweep harness, state widening,
content verification, guarded writes, knowledge niche, reversibility, design
layers) is [docs/site-builder-implementation-plan.md](docs/site-builder-implementation-plan.md).

`kits/opencode/` ships the agentic engineering harness (Phases 1–2) from
[docs/OpenCode Agentic Engineering Harness.md](docs/OpenCode%20Agentic%20Engineering%20Harness.md)
as an installable OpenCode V2 kit — `lead` agent, protected-test subagents,
slash commands, baseline permissions, and `.agent/` state files. Its agents
bind to the three rules above. Install into a site project with
`kits/opencode/install.sh <project-dir>`.

## Honest status

- **Sweep harness: Phases 1–4 COMPLETE and gate green (2026-10-16).** All 11
  measured failure-mode rows are backed by committed sweep records: three
  verified against the live usagov2021 fixture (including a fresh
  install-crash reproduction of the undeclared `file.repository` dependency
  on the dedicated `usagov-sweep-scratch` scratch project), and the corpus
  rows measured across B1 retrieval (8 fixtures) and B2 answerability
  (llama31-8b-16k, with claim-support regression fixtures). `gate --apply`
  writes ledger proposals for human review; `sweep:report` emits the
  token-price table. Five cheap A1 rows remain `claimed` until their
  instruments are added. See `sweep/records/`. Findings consolidated in
  [docs/analysis-3-sweep-findings.md](docs/analysis-3-sweep-findings.md).
- **Stage D loop closed (2026-10-16):** the B1 concept-bridge remedy (new
  curated `drupal-concept-bridge-guidance` corpus in drupal-dev-mcp)
  flipped corpus retrieval from 4 fails to **8/8 pass**, including rank-1
  hits on the raw plain-language questions. B2 measures the remaining gap
  honestly: synthesis grounding at 8B stays variance-dominated even with
  retrieval fixed.
- The **writes plane (Slice 1)** is implemented and unit-tested
- The **writes plane (Slice 1)** is implemented and unit-tested
  (`create_content`, `get_bundle_fields`, `verify_entity`, `delete_content`):
  the required-field precondition is catalog-backed (`unpopulated-field-fatal`
  is measured), but the new eval-based normalizers are **not yet swept**
  against a live install — see
  [docs/site-builder-implementation-plan.md](docs/site-builder-implementation-plan.md).
- The failure-mode catalog is **seeded, not swept**: every row is
  `evidenceStatus: "claimed"`. A row graduates only after a live-site sweep
  reproduces the failure and proves the detection recipe catches it.
- The drush normalizers are written defensively against Drush 12 output shapes
  and are not yet swept. `verify_page`'s thresholds (64-byte floor, marker
  string) are adapted from mosaic-headless's measured practice and should be
  re-measured against Drupal's actual critical-error screen.

## License

MIT. See [LICENSE](LICENSE).