# kits/opencode — Agentic Engineering Harness (Phases 1–2)

Installable OpenCode V2 harness implementing the plan in
`docs/OpenCode Agentic Engineering Harness.md`, composed with this repo's
`SKILL.md` (the three-plane Drupal discipline).

## What is in the kit

| Path | Layer | Phase |
|---|---|---|
| `.opencode/agents/lead.md` | primary agent: plans, implements, owns the ledger | 1 |
| `.opencode/agents/test-writer.md` | subagent: failing tests from spec criteria | 2 |
| `.opencode/agents/coder.md` | subagent: implements one task, tests protected | 2 |
| `.opencode/agents/reviewer.md` | subagent: runs tests, reviews diff vs spec | 2 |
| `.opencode/commands/*.md` | `/spec /tests /build /verify /review /audit /ralph-plan` | 2 |
| `opencode.jsonc` | baseline permissions, compaction | 1 |
| `AGENTS.snippet.md` | standing rules to append to the project's `AGENTS.md` | 1 |
| `.agent/` | plan, ledger, progress, briefs, results, ralph-prompt | 1 |
| `scripts/ralph.sh` | loop mode (Phase 4 — included, not required yet) | 4 |
| `install.sh` | copies the above into a site project | — |

Exploration uses OpenCode's built-in `explore` subagent — no file needed.

## Install

```sh
cd kits/opencode
./install.sh /path/to/drupal-site
```

The script refuses to overwrite an existing `.agent/`. Then by hand:

1. **Merge `opencode.jsonc`** into the project's `opencode.jsonc`
   (global `permissions`, `compaction`, `default_agent`, and the `lead`
   agent entry).
2. **Append `AGENTS.snippet.md`** to the project's `AGENTS.md` — or, on a
   fresh project, use it as the starting `AGENTS.md`.
3. **Adjust the two per-project knobs** (see "Adapt to the site" below).
4. Configure the `drupal-dev-planes` MCP server for the project
   (see the repo README's client configuration). The harness agents assume
   it; without it, agents still work but write-side verification degrades
   to manual checks.

## Adapt to the site

- **Edit globs.** `coder` may edit `src/**` and `web/modules/custom/**`.
  Extend (e.g. `web/modules/contrib-patches/**`, custom themes) or tighten
  in the agent frontmatter.
- **Test command.** The kit uses `ddev exec phpunit` as the suite command
  and `ddev exec phpcs` for lint. Replace with the site's actual invocations
  (phpunit `-c` path, profile/group filters) everywhere: agent
  permissions, `/verify`, `AGENTS.snippet.md`, `scripts/ralph.sh`.
- **Secrets.** The baseline denies `read **/.env*`. If secrets live in
  `web/sites/default/settings*.php`, add
  `{ action: "read", resource: "**/settings*.php", effect: "deny" }` to the
  global permissions — but note this also blocks legitimate settings wiring
  tasks; scope it per agent instead if bring-up work is planned.

## Phase gates

**Phase 1 — single agent with backpressure.** Use only `lead` and the
built-in `explore`; do not delegate. Exit when one feature ships with tests
written first and no test edits by the implementer.

**Phase 2 — spec, gates, and selective delegation.** Start using `/spec`,
`/tests`, `/verify` and the `test-writer` / `coder` / `reviewer` subagents
with briefs and results. Exit when a delegated task completes from its brief
alone, with no follow-up clarification, and a spec + its tests + the code
land as separate reviewable commits.

Track these signals in `.agent/progress.md` (harness doc §"Rollout phases"):

- share of tasks needing a second attempt or human fix after reviewer pass;
- delegated tasks blocked for missing context (briefs too thin / too coupled);
- any test removed or weakened in a diff (target: zero without approval);
- lead context resets per feature.

A `verify-gate` plugin (mechanical write→verify pairing via
`tool.execute.after`) is deliberately **not** in this kit — Phase 3,
triggered only if the signals above show agents skipping verification.

## Model choices

Harness doc rule: strongest model on `lead` and `reviewer`; a cheaper model
is fine for `test-writer`, `coder`, and `explore`. The kit's agent files
deliberately omit `model` so they inherit the session's — set per project in
`opencode.jsonc` `agents` entries or per agent in frontmatter
(`provider/model#variant`). Check context-window compatibility for handoffs
into smaller-window subagents.

## Verify before relying on (from the harness doc's open questions)

- `compaction.keep.tokens` / `buffer` field shapes against the installed
  OpenCode version; `steps` caps were confirmed against the V2 agents docs
  (frontmatter `steps` is valid; `maxSteps` is legacy — do not use both).
- `opencode run` non-interactive flags before trusting `scripts/ralph.sh`
  (Phase 4).
- Whether path-scoped `edit` denies also block shell writes (`sed -i` on a
  denied path); if not, the `coder`'s shell allowlist must stay narrow —
  it does by default.

## Sources

- `docs/OpenCode Agentic Engineering Harness.md` (the plan this kit
  implements)
- `SKILL.md` (the three-plane discipline the agents bind to)
- OpenCode V2 docs: `/v2/docs/agents/`, `/v2/docs/commands/`,
  `/v2/docs/build/plugins/` (plugins are Phase 3+)
