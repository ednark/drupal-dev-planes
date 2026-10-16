# drupal-dev-planes

Drupal-aware tools for AI coding assistants. One MCP server that lets an
agent **inspect a running Drupal site, make selected changes, and check the
results** — organized into four planes and built around one rule:

> **Never trust the commit.** An exit code of 0 is not evidence of a working
> site.

This is a tool server, **not** an AI model, an autonomous agent, or a
security sandbox. The agent brings the intelligence; these tools give it
trustworthy reads, guarded writes, and honest verdicts about a live site.

- **knowledge** — what is true in a given Drupal version. Composed from
  [drupal-dev-mcp](https://github.com/ednark/drupal-dev-mcp), unchanged: a
  versioned, cited, closed-world evidence index. This repo runs it as a child
  MCP server and proxies **three** of its retrieval tools (`get_index_status`,
  `search_drupal`, `get_drupal_document`) — it is not a full pass-through to
  the sibling server, and the proxy exposes the version targets this repo
  pins (10.6 / 11.4 / all), not drupal-dev-mcp's full set.
- **state** — what is true on *this site* right now. Drush-backed, typed,
  secret-masked reads: config, modules, views, menus, roles, watchdog,
  routes, field definitions, content.
- **verification** — did the write actually take effect? Read-back diffs,
  page probes with content assertions, and entity diffs. Verdict first: a
  page only returns `alive` when it is actually delivered (4xx, 5xx, the
  critical-error screen, an empty body, or missing expected content each get
  their own non-`alive` verdict).
- **writes** — the side-effecting plane, gated and precondition-checked:
  semantic tools (`create_content`, `create_content_type`, `add_field`,
  `set_permissions`, `install_module`, `place_block`) that refuse known-bad
  moves before applying, then **return the paired verification recipe as a
  note for the agent to run**. Writes are guarded, not transactional: the
  server recommends and (for `configure_display`) performs the read-back,
  but it does not force the follow-up verification or roll back on its own.

Plus `data/failure-modes.json`: a Drupal silent-failure catalog where every
row is honest about its evidence (`claimed` until a **sweep** — a
measurement run that reproduces the failure on a live fixture, proves the
detection recipe catches it, and records the result), and `sweep/`: the
instrument that makes those claims mechanical.

> The "never trust the commit" rule and the sweep/claim discipline are
> adapted from mosaic-headless, an earlier Drupal harness; see
> [docs/analysis-2-community-research.md](docs/analysis-2-community-research.md)
> for the broader harness-engineering context.

## Why

An agent doing Drupal work fails by conflating different kinds of truth: it
edits YAML blind (guessing state from stale training data), and trusts a
successful commit. The measured case in point — `pm:enable` of a module with
an undeclared dependency **fatals at container compile and still writes the
module into `core.extension`**; the next cache rebuild is what dies. A
failed command is not the dangerous artifact; the state it leaves behind is.

This server keeps the planes separate, labels every response with its plane
and provenance, degrades gracefully per plane, refuses writes the catalog
says break, and pairs every write with its verification recipe.
See [docs/architecture.md](docs/architecture.md).

## Quick start

```bash
npm install
npm run build
npm test
npm run mcp:start
```

The server runs on stdio. Every plane works standalone: knowledge activates
when drupal-dev-mcp is configured, state when drush (and a ddev project, if
you use the shim) is configured, writes when the exec gate is on.

## MCP client configuration

Generic MCP-client shape (`mcpServers` — Claude Desktop, Cursor, and others):

```json
{
  "mcpServers": {
    "drupal-dev-planes": {
      "command": "node",
      "args": ["/absolute/path/to/drupal-dev-planes/packages/server/dist/index.js"],
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

OpenCode V2 uses a different shape — `mcp.servers.<name>` with `type` and a
`command` **array** (see the [OpenCode MCP docs](https://opencode.ai/v2/docs/mcp-servers)):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "drupal-dev-planes": {
        "type": "local",
        "command": ["node", "/absolute/path/to/drupal-dev-planes/packages/server/dist/index.js"],
        "environment": {
          "DRUPAL_DEV_MCP_COMMAND": "node",
          "DRUPAL_DEV_MCP_ARGS": "/absolute/path/to/drupal-dev-mcp/packages/server/dist/index.js",
          "DRUPAL_MCP_INDEX_ROOT": "/absolute/path/to/drupal-dev-mcp/data/index",
          "DRUSH_BIN": "drush",
          "DRUPAL_AGENT_ALLOW_EXEC": "false"
        }
      }
    }
  }
}
```

Notes:

- `DRUPAL_DEV_MCP_ARGS` is comma- or space-separated (quote-free).
- **ddev**: if `DRUSH_BIN` points at a ddev shim (see `bin/ddev-drush`),
  set `DDEV_PROJECT` in the env to select the project, and keep
  `DRUPAL_SITE_ROOT` unset — the container knows its own root.
- **`DRUSH_SHELL_JOINED`**: ddev shims re-join drush arguments through a
  container bash. When detected (any `ddev` in `DRUSH_BIN`), the plane tools
  quote-encode their eval snippets so payloads survive the container shell;
  override with `DRUSH_SHELL_JOINED=false|true`.
- **`DRUSH_TIMEOUT_MS`**: per-command timeout (default 20s; sweeps and
  installs need more via the `timeout_ms` tool argument, capped at 120s).
- Keep `DRUPAL_AGENT_ALLOW_EXEC=false` in unattended clients — it gates the
  entire writes plane.

## Tools

Every response carries `plane`, `status`, `data` (verdict-first where a
verdict exists), `notes` (pointers to failure modes and next verification
steps — the verification contract, not decoration), and `provenance`.

### knowledge (proxied from drupal-dev-mcp)

| Tool | Side effects | Does |
|---|---|---|
| `get_index_status` | none | index build readiness; cite `builtAt` when freshness matters |
| `search_drupal` | none | cited evidence search across the versioned index |
| `get_drupal_document` | none | exact indexed text — verify a citation without re-searching |

### state

| Tool | Side effects | Does |
|---|---|---|
| `get_site_status` | none | normalized `drush status` (versions, root, bootstrap) |
| `get_site_config` | none | `drush config:get`, secrets masked |
| `list_site_modules` | none | normalized `drush pm:list` |
| `list_views` / `list_menus` | none | every view / menu, typed |
| `list_roles` | none | every role with its permission list; optional permission filter |
| `get_watchdog` | none | 50 newest watchdog entries, severity-filterable — the post-write check for silent fatals |
| `check_route` | none | does a route exist for a path pattern / name, and what does it require |
| `get_bundle_fields` | none | field definitions for a bundle: type, required, cardinality |
| `find_content` / `find_term` | none | locate content nodes / taxonomy terms — the reads that make writes idempotent and resolve entity_reference targets |
| `drush_dispatch` | **yes, gated** | explicit drush invocation; the escape hatch — never route around a refusal with it |

### verification

| Tool | Side effects | Does |
|---|---|---|
| `verify_config` | none | read back a config object, subset-diff against expected, **verdict first** |
| `verify_page` | none | probe a delivered URL and return a delivery verdict: `server_error` (5xx), `error_page` (critical-error marker), `http_error` (4xx), `suspicious_short` (empty/tiny body), `content_missing` (delivered but `expected` text absent); only a fully delivered page is `alive` |
| `verify_entity` | none | read back an entity and diff against what you intended; scalar shorthand against field deltas |

### writes (gated)

| Tool | Side effects | Refuses (precondition) | Paired verification |
|---|---|---|---|
| `create_content` | yes | unpopulated required fields (`unpopulated-field-fatal`, measured) | `verify_entity` read-back + `verify_page`; returns declared `revert` |
| `create_content_type` | yes | duplicate type | `get_bundle_fields` read-back |
| `add_field` | yes | missing bundle, duplicate field | `get_bundle_fields` read-back |
| `set_permissions` | yes | missing role, unknown permission | `list_roles` read-back |
| `install_module` | yes | missing dependencies, missing service references, already enabled — the measured install-crash class | `list_site_modules` read-back; half-commit reported with the repair hint |
| `place_block` | yes | theme/region/id | `verify_page` with `expected` |
| `configure_display` | yes | formatter required unless hidden | read-back performed in-tool |
| `delete_content` | yes | no explicit target | `verify_entity` expecting `not_found` |

## The routing discipline

The matching agent skill (`SKILL.md`) encodes the rules:

1. **Never write config from memory.** Consult the knowledge plane before
   the state plane. Your training data is not a Drupal version.
2. **Never assume state.** Read it; don't infer it from what you wrote
   earlier in the session.
3. **Never trust the commit.** After any write, run its paired verification
   before claiming success — and treat "config imported" as unverified
   delivery.
4. **Never route around a refusal.** A precondition refusal is the catalog
   doing its job; fix the cause, don't reach for `drush_dispatch`.

## The failure-mode catalog and the sweep harness

`data/failure-modes.json` records how Drupal fails silently — with per-row
`evidenceStatus`. Graduation is enforced, not asserted: `sweep/` contains
the instrument that reproduces each failure on a live fixture, proves the
detection recipe catches it, and writes a dated record. The gate
(`npm run sweep:gate`) refuses catalog claims whose records don't exist —
`skipped` and `inconclusive` verdicts never fold into pass rates.

```bash
npm run sweep:all        # failure-mode + corpus targets (fixture required)
npm run sweep:scratch    # A2 install-crash sweeps on a dedicated ddev project
npm run sweep:answerability         # answerability matrix (model-server required)
npm run sweep:regression # recorded answers as claim-support fixtures
npm run sweep:gate       # the claims-vs-records check
npm run sweep:report     # pass rates + token-price table
```

Run adjacent: see [sweep/README.md](sweep/README.md) for
the environment matrix. Findings from the live runs are consolidated in
[docs/analysis-3-sweep-findings.md](docs/analysis-3-sweep-findings.md).

## Harness kit

`kits/opencode/` ships an installable OpenCode V2 agentic-engineering
harness — `lead` agent, protected-test subagents, slash commands, baseline
permissions, and `.agent/` state files — whose agents bind to the routing
discipline above. Install into a site project with
`kits/opencode/install.sh <project-dir>`.
See [docs/OpenCode Agentic Engineering Harness.md](docs/OpenCode%20Agentic%20Engineering%20Harness.md).

## The vocabulary (reference)

| Term | Meaning |
|---|---|
| **plane** | One of four truth domains — knowledge (what Drupal is), state (what this site is), verification (what actually happened), writes (what may be committed). Every tool response names its plane. |
| **catalog** | `data/failure-modes.json` — how Drupal fails silently, one row per failure mode, each with an `evidenceStatus`. |
| **claimed / measured** | A row's evidence status: `claimed` = model-authored from a session; `measured` = a sweep reproduced the failure AND proved the detection recipe catches it. |
| **sweep** | A measurement run: pick a catalog row (or a corpus question fixture), reproduce the failure on a live fixture, run the row's detection recipe through the plane tools, record the verdict — including `skipped` and `inconclusive`, which never fold into pass rates. |
| **record** | One dated, committed JSON file per sweep target in `sweep/records/` — the evidence a `measured` claim must cite. |
| **gate** | `npm run sweep:gate` — validates every `measured` claim against its records and refuses catalog claims without them. The enforcement layer; the README asserts no status. |
| **bad patch** | A fixture mutation stored in `sweep/bad-patches/` that deliberately induces a catalog failure mode (a library.yml with a broken CSS category, a module with an undeclared service) — applied, measured, reverted in teardown. |
| **fixture** | The live Drupal install a sweep runs against: the usagov2021 ddev project, or the dedicated `usagov-sweep-scratch` project for destructive install-order tests. |

## Repository layout

```
packages/
  knowledge/   knowledge plane: MCP client of drupal-dev-mcp (thin proxy)
  server/      the MCP server: shared.ts (envelope + transport) + tools/<plane>.ts
  state/       state plane: drush-backed reads + the shared php:eval transport
  verify/      verification plane: page probes, config/entity diffs, claim support
  writes/      writes plane: guarded content/type/field/permission/module/block ops
sweep/         the measurement harness (records, gate, instruments)
kits/opencode/ installable OpenCode harness (agents, commands, permissions)
data/          the failure-mode catalog (read by the server + the gate)
bin/           ddev drush shim
docs/          plans, architecture, dated analyses
tests/         unit tests, one file per plane or instrument
```

## Documentation

| Doc | What it is |
|---|---|
| [docs/architecture.md](docs/architecture.md) | the four-plane design, response envelope, honest status mechanism |
| [docs/site-builder-implementation-plan.md](docs/site-builder-implementation-plan.md) | the seven-layer plan from here to a site-builder |
| [docs/sweep-harness-plan.md](docs/sweep-harness-plan.md) | the sweep families, gate rules, phases |
| [docs/analysis-1-conclusions.md](docs/analysis-1-conclusions.md) | the first live bring-up: what the planes caught, what they missed |
| [docs/analysis-2-community-research.md](docs/analysis-2-community-research.md) | the community landscape (harness engineering, self-correction literature) around this design |
| [docs/analysis-3-sweep-findings.md](docs/analysis-3-sweep-findings.md) | consolidated findings from the live sweep runs |
| [docs/analysis-4-proxy-frictions.md](docs/analysis-4-proxy-frictions.md) | integration frictions between the knowledge-plane proxy and drupal-dev-mcp |
| [docs/design-layers-plan.md](docs/design-layers-plan.md) | where Design/UI/UX verification will sit |
| [docs/OpenCode Agentic Engineering Harness.md](docs/OpenCode%20Agentic%20Engineering%20Harness.md) | the harness methodology the kit implements |

## Status

Status is not asserted here. The enforcement layer tracks it:

- `npm run sweep:gate` — every `measured` catalog claim must be backed by a
  committed record; violations exit 1.
- `sweep/records/` — the dated, machine-generated evidence.
- drupal-dev-mcp's `data/corpus-issues.json` — corpus findings; sweeps write
  proposals, humans promote.

## License

MIT. See [LICENSE](LICENSE).
