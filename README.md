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

## Honest status

- The failure-mode catalog is **seeded, not swept**: every row is
  `evidenceStatus: "claimed"`. A row graduates only after a live-site sweep
  reproduces the failure and proves the detection recipe catches it.
- The drush normalizers are written defensively against Drush 12 output shapes
  and are not yet swept. `verify_page`'s thresholds (64-byte floor, marker
  string) are adapted from mosaic-headless's measured practice and should be
  re-measured against Drupal's actual critical-error screen.

## License

MIT. See [LICENSE](LICENSE).