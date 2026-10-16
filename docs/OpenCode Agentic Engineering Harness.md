# OpenCode Agentic Engineering Harness

Oct 15, 2026 · @Ed Nark

## Goal and design principles

The harness puts Karpathy's agentic engineering into practice in OpenCode: you orchestrate and oversee agents, and the code is held to an engineering bar by specs, tests and review. It is shaped by the critiques of orchestrator-subagent setups, so delegation is used where it isolates noisy work, not by default.

1. **Simplest loop first.** One capable agent does most work. Delegation is the exception, used to keep noisy exploration or bulk output out of the main context.
2. **State lives in files, not in chat.** Specs, plans, the task ledger and progress notes sit in the repo. Any agent can read them; the conversation is never the only record.
3. **Tests are the executable spec.** Acceptance criteria become tests before implementation. Tests are protected so no agent can weaken them to pass.
4. **Verify evidence, not claims.** Trust test output and diffs, never an agent's summary that it finished.
5. **Cognitive locality.** Work that shares a mental model stays in one agent. Split only along clean boundaries.
6. **Spec size matches risk.** A one-line fix needs no spec; a new feature needs a short, living spec that is revised as you learn.
7. **Humans on the loop.** You approve direction at a few gates (spec, final review, merge), not every intermediate step.

## Architecture overview

One primary agent, `lead`, does most of the work and is the only agent you talk to. It delegates separable tasks to narrow subagents, and every agent, plus the optional Ralph loop, coordinates through files in the repo rather than through each other's context.

&#91;embedded content: harness architecture · 1 lead, 4 subagents, shared files, optional loop\]

The lead owns the ledger; subagents and loop passes read shared files and write only their own results, which avoids write conflicts and keeps raw output out of the lead's context.

## Repository layout

Everything the harness needs lives in the repo, so any agent (or a fresh Ralph iteration) can rebuild its picture from disk. Agents and commands use OpenCode V2's documented locations.

```
AGENTS.md                     # standing rules, kept short; loaded every session
opencode.jsonc                # global permissions, default_agent, model choices
.opencode/
  agents/
    lead.md                   # primary: plans, implements small work, delegates
    test-writer.md            # subagent: writes failing acceptance tests
    coder.md                  # subagent: implements one task, cannot touch tests
    reviewer.md               # subagent: read-only, runs tests, checks diff vs spec
                                  # exploration uses OpenCode's built-in explore
  commands/
    spec.md  tests.md  build.md  verify.md  review.md  ralph-plan.md
docs/
  specs/<feature>.md          # living spec per feature, versioned in git
  decisions/NNNN-<slug>.md    # short ADRs for choices worth remembering
.agent/
  plan.md                     # current task list, ordered, one line each
  ledger.md                   # task status table; ONLY the lead writes it
  progress.md                 # append-only learnings and gotchas
  briefs/task-NN.md           # brief handed to a subagent
  results/task-NN.md          # return contract written by that subagent
scripts/
  ralph.sh                    # optional loop runner
```

Keep AGENTS.md operational: build and test commands, conventions, where state lives, and the hard rules. Progress notes go in `.agent/progress.md`, not AGENTS.md, because AGENTS.md is loaded every session and bloat costs context.

## Agent roster

Four custom agents plus OpenCode's built-in `explore`. Only the lead talks to you; subagents get fresh context and their own permissions, so every boundary below is set explicitly in each file.

| Agent | Mode | Job | Can edit | Shell | Can launch |
| --- | --- | --- | --- | --- | --- |
| `lead` | primary (default) | Holds the spec and plan, does small coherent work itself, writes briefs, reconciles results, owns the ledger | All except `tests/**` once approved | Ask for push, deploy, destructive | `test-writer`, `coder`, `reviewer`, `explore` |
| `test-writer` | subagent | Turns spec acceptance criteria into failing tests | `tests/**`, `.agent/results/**` | Test runner only | None |
| `coder` | subagent | Implements one task from a brief until its tests pass | `src/**`, `.agent/results/**`; deny `tests/**` | Build, test, lint | None |
| `reviewer` | subagent | Runs tests, reads the diff, checks it against the spec, reports findings | `.agent/results/**` only | Test runner, `git diff` | None |
| `explore` (built-in) | subagent | Read-only search of code and docs, returns a short summary | None | None | None |

Pairing matters more than count: the agent that writes code never judges it, and the agent that writes tests never implements against them. Put the strongest model on `lead` and `reviewer`; a cheaper model is usually fine for `explore` and routine `coder` tasks. Check context-window sizes when mixing models, since a handoff into a smaller window can fail.

Example subagent file, using V2 fields (`description`, `mode`, `model`, `permissions`; last matching rule wins):

```markdown
---
description: Implements one task from a brief in .agent/briefs; never edits tests
mode: subagent
model: anthropic/claude-sonnet-4-5#high
permissions:
  - { action: "*", resource: "*", effect: deny }
  - { action: read, resource: "**", effect: allow }
  - { action: glob, resource: "**", effect: allow }
  - { action: grep, resource: "**", effect: allow }
  - { action: edit, resource: "src/**", effect: allow }
  - { action: edit, resource: ".agent/results/**", effect: allow }
  - { action: edit, resource: "tests/**", effect: deny }
  - { action: shell, resource: "npm test*", effect: allow }
  - { action: shell, resource: "npm run lint*", effect: allow }
---

Read the brief you were given and the spec section it cites. Implement only that task.
Run the tests until they pass. Never edit, skip or delete a test; if a test looks wrong,
stop and say so in your result. Write your result to .agent/results/task-NN.md using
the return contract in AGENTS.md, then reply with its path and a one-line status.
```

Swap the `npm` commands for your stack (for Drupal work, `ddev exec phpunit` and `phpcs`, for example).

## Shared state and handoff contracts

Context loss at handoffs is the main critique of subagents, so every crossing is written down: a brief going in, a result coming back, and a ledger only the lead updates. Subagents read whatever they need from `.agent/` and `docs/`; they write only to their own result file.

**Brief** (`.agent/briefs/task-NN.md`, written by the lead):

```markdown
# Task NN: <one line>
Goal: <what changes for the user or system>
Spec: docs/specs/<feature>.md#<section>
Done when: <test names or command that must pass>
Files in scope: <paths>
Out of scope: <what not to touch>
Decisions already made: <choice + one-line why>
Decision rights: <decisions this subagent may make; everything else returns to the lead>
Tried and failed: <approaches already ruled out, with the reason>
Assumed, not verified: <claims this brief relies on that nobody has checked>
Known gotchas: <from progress.md, if any>
```

**Return contract** (`.agent/results/task-NN.md`, written by the subagent):

```markdown
# Result NN: done | blocked | partial
Changed: <file list>
Tests: <exact command run + pass/fail counts, pasted output tail>
Decisions made: <choice + why>
Open questions: <anything the lead must decide>
Verify: <what the lead or reviewer should check by hand>
Preflight: passed | discrepancies listed below (see Revalidation)
Tried and failed: <dead ends this run, with the reason>
Assumed, not verified: <claims still unchecked; the lead must verify or record them as open>
Learnings: <one line worth adding to progress.md, or none>
```

**Ledger** (`.agent/ledger.md`, lead only): one row per task with status, brief, result, and verification outcome. The lead updates it after checking evidence, never on the subagent's word alone.

**Rules:**

- Single writer per file. Subagents never edit the plan, ledger, spec or AGENTS.md; they propose changes in their result.
- Status checks read the result file, not the subagent's full transcript, so raw output never floods the lead's context.
- Learnings go to `progress.md` through the lead, append-only, one line each, so the next agent inherits them.
- If a brief needs more than about a page to explain, the task is too coupled to delegate; the lead does it itself.

## Workflow

Each feature runs spec, tests, build, verify and review, and you approve at three points: the spec, the tests, and the merge. Red tests loop back to build, and review findings loop back to build, so nothing reaches you that hasn't passed the suite and a spec check.

&#91;embedded content: feature workflow · 5 steps, 2 loops, 3 human gates\]

Small changes skip the spec and go straight to build with a regression test. Each step is a slash command in `.opencode/commands/`:

| Command | Runs as | Does |
| --- | --- | --- |
| `/spec <feature>` | `lead` | Drafts or updates `docs/specs/<feature>.md` with acceptance criteria and edge cases, then stops for your approval |
| `/tests <feature>` | `test-writer` | Writes failing tests from the criteria; you review the test diff |
| `/build <feature>` | `lead` | Breaks the spec into tasks in `plan.md`, does coupled work itself, delegates separable tasks to `coder` with briefs |
| `/verify` | `lead` | Runs the full suite and confirms `tests/` is unchanged since you approved it |
| `/review` | `reviewer` | Reads the diff against the spec and returns findings in severity order |
| `/ralph-plan <feature>` | `lead` | Writes `plan.md` as one-line tasks for loop mode |

Example command file, `.opencode/commands/verify.md` (shell blocks run before the prompt, outside agent permissions, so keep them read-only):

```markdown
---
description: Run the suite and check tests were not changed
agent: lead
---

Test diff since approval:
!`git diff --stat approved-tests -- tests/`

Run the full test suite. Report pass/fail counts with the output tail.
If the diff above is not empty, stop and list every changed test file.
```

Tag the approved test commit as `approved-tests` at the end of `/tests` so `/verify` has something to diff against.

## Ralph loop mode

For long, mechanical work with a clear spec and reliable tests, run the lead headless in a loop instead of delegating inside one session. Each pass starts with fresh context, picks one unchecked task from `.agent/plan.md`, implements it, runs the tests, commits, and exits; state carries over only through files and git.

Use it when the plan has many small independent tasks (migrations, porting, test backfill). Avoid it for design work or anything where the spec is still moving.

```bash
#!/usr/bin/env bash
# scripts/ralph.sh: one task per pass, fresh context each time
set -euo pipefail
MAX=${1:-20}
for i in $(seq 1 "$MAX"); do
  grep -q '^- \[ \]' .agent/plan.md || { echo "plan complete"; exit 0; }
  echo "=== pass $i ==="
  opencode run --agent lead "$(cat .agent/ralph-prompt.md)" || true
  if ! npm test; then
    echo "tests red after pass $i; stopping for review"; exit 1
  fi
done
echo "hit max passes ($MAX); review progress.md"
```

The prompt file tells the lead: read AGENTS.md, the plan and progress.md; run the preflight in the Revalidation section and stop on any discrepancy; take the first unchecked task; do only that task; run tests; on green, tick it, append one learning, commit; on repeated failure, mark it blocked with the reason and exit. Check the exact non-interactive flags in `opencode run --help` for your version before relying on this script.

Guardrails for loop mode:

- Run it in a sandbox or container with no production credentials and no push rights.
- Work on a dedicated branch; you merge after review, never the loop.
- Hard stop conditions: plan empty, tests red after a pass, max passes, or a task blocked twice.
- Protect tests (next section) and review the test diff before trusting a green run, since agents under pressure have deleted assertions to pass.

## Guardrails and permissions

Permissions enforce the boundaries so the prompts don't have to. In OpenCode V2, global `permissions` apply first, agent rules append, and the last matching rule wins, so broad denies come before narrow allows.

Project-wide baseline in `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "default_agent": "lead",
  "permissions": [
    { "action": "shell", "resource": "*", "effect": "ask" },
    { "action": "shell", "resource": "git status", "effect": "allow" },
    { "action": "shell", "resource": "git diff*", "effect": "allow" },
    { "action": "shell", "resource": "git push*", "effect": "deny" },
    { "action": "shell", "resource": "rm -rf*", "effect": "deny" },
    { "action": "read", "resource": "**/.env*", "effect": "deny" },
    { "action": "edit", "resource": "AGENTS.md", "effect": "ask" },
    { "action": "edit", "resource": "docs/specs/**", "effect": "ask" }
  ],
  "agents": {
    "lead": {
      "permissions": [
        { "action": "subagent", "resource": "*", "effect": "deny" },
        { "action": "subagent", "resource": "test-writer", "effect": "allow" },
        { "action": "subagent", "resource": "coder", "effect": "allow" },
        { "action": "subagent", "resource": "reviewer", "effect": "allow" },
        { "action": "subagent", "resource": "explore", "effect": "allow" },
        { "action": "edit", "resource": "tests/**", "effect": "ask" }
      ]
    }
  }
}
```

What each guardrail protects:

| Risk | Guardrail |
| --- | --- |
| Agent weakens or deletes tests to go green | `coder` denied `tests/**`; `lead` must ask; reviewer diffs `tests/` separately on every run |
| Spec quietly drifts | Spec and AGENTS.md edits require approval; changes land as a reviewed diff |
| Irreversible actions | `git push` denied in-agent; you push after review; `rm -rf` denied |
| Secret exposure | `.env` reads denied; Ralph runs in a sandbox with no production credentials |
| Runaway loops | `steps` cap on subagents; Ralph max passes and red-test stop |
| Unvetted command templates | Shell blocks in commands run outside the permission flow, so keep them to read-only commands like `git diff` |

Subagents do not inherit the lead's restrictions; each agent file must state its own rules, starting from a deny-all.

## Rollout phases and success measures

Build the harness in four phases, each proven on a real feature before adding the next layer, so complexity only arrives once the simpler setup has shown where it falls short.

1. **Single agent with backpressure.** Write AGENTS.md, the `.agent/` files and the baseline permissions. Use only `lead` plus built-in `explore`. Exit when one feature ships with tests written first and no test edits by the implementer.
2. **Spec and gates.** Add `docs/specs/`, `/spec`, `/tests` and `/verify`. Exit when a spec, its tests and the code land as separate reviewable commits.
3. **Selective delegation.** Add `test-writer`, `coder` and `reviewer` with briefs, results and the ledger. Exit when a delegated task completes from its brief alone, with no follow-up clarification.
4. **Loop mode.** Add `scripts/ralph.sh` in a sandbox for one batch of mechanical tasks. Exit when a run stops cleanly on its own conditions and the merged diff passes review.

Track a few signals in `.agent/progress.md` as you go:

- Share of tasks needing a second attempt or a human fix after the reviewer passed them.
- Delegated tasks that came back blocked for missing context (a sign briefs are too thin or tasks too coupled).
- Any test removed or weakened in a diff (target: zero without your approval).
- Lead context resets per feature (frequent resets suggest too much raw output reaching it).

## Token budget and OpenCode mitigations

Planning estimate: a feature through the full pipeline costs roughly 100k to 300k tokens, about 2 to 3 times a single-agent run. The mitigations below map each cost driver to a documented OpenCode setting. The values are starting points, not tuned numbers.

| Cost driver | Mitigation | OpenCode setting |
| --- | --- | --- |
| Fixed prompt on every turn | Keep AGENTS.md under about 1,500 tokens; keep agent descriptions to one line, since the lead sees them | `description` on each agent; avoid `system` unless needed, because it replaces the provider's base prompt |
| Runaway subagent loops | Cap model steps per agent; on the last step OpenCode removes tools and asks for a text summary | `steps`: coder 25, test-writer 15, reviewer 12, explore 10 (adjust after the first feature) |
| Long lead sessions | Automatic compaction, with more recent detail kept during build | `compaction``  (global): auto true, keep.tokens 24000 ` |
| Prompt cache expiry during approval pauses | Optional keep-alive while you review a spec or test diff | `warming` is off by default; enable only for review pauses, with a longer `interval` |
| Test output bloat | Capture failures and summary lines only | Shell commands in `/verify` and the Ralph script pipe through `tail` |
| Per-pass cost in Ralph | Hard pass cap and red-test stop | Script `MAX`; each pass is a fresh process, so no compaction is needed |
| Large diffs in review | Review smaller commits; reviewer reads stat first | `/review` runs `git diff --stat` before full diffs |

**Setting notes:**

- **Compaction is lossy.** The summary is the only thing the model keeps from older turns, so the plan, ledger and progress file must stay on disk. Treat the summary as a convenience, not a record.
- **Compaction cannot free fixed cost.** OpenCode's docs note it cannot create room when a request is mostly instructions and tool schemas. Keep each agent's tool set lean, and check the token breakdown after the first feature.
- **Warming costs requests.** Each warming call is a real model request, and the defaults allow up to seven in a 30-minute window. Measure whether the cache hit rate justifies it before enabling it globally.
- **Native provider compaction** is available only for OpenAI Responses models, with the same provider and model required for the checkpoint to work. Use it only if the lead runs on that provider, and note the portability limit.
- **Shell blocks bypass the permission flow** and their output enters the prompt. Keep them to narrow, read-only commands such as `git diff --stat`.

**Measure before scaling.** Log input, output and cache-read tokens per task and per feature, and compare the first two features against a single-agent run of similar size. Check the cost table at the end of Phase 1 before adding delegation in Phase 3.

**Verify before relying on:** the `steps` values, whether subagent sessions are compacted independently of the lead, and the exact behaviour of `warming` with your provider's cache.

## Pending config changes

Two changes to make before Phase 1 starts. The first is a correction: compaction is a global setting in OpenCode, not a per-agent one, so the `keep.tokens` value applies to every session, including subagents. Set it once in `opencode.jsonc`.

**1. Add `steps` caps and compaction to the configuration.** Subagent caps go in the agent files (or in `opencode.jsonc` if you prefer a single file). Starting values:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "compaction": {
    "auto": true,
    "keep": { "tokens": 24000 },
    "buffer": 16000
  },
  "agents": {
    "test-writer": { "steps": 15 },
    "coder": { "steps": 25 },
    "reviewer": { "steps": 12 },
    "explore": { "steps": 10 }
  }
}
```

The `explore` entry overrides the built-in agent by using its ID. The `lead` agent gets no cap, since it is the one agent that must run a full feature. Also add `steps: 25` to the example `coder.md` frontmatter so the file and the config agree; if both are set, confirm which one OpenCode applies before relying on it.

**2. Tune the caps after the first feature.** Read the step counts from the Phase 1 run. Raise a cap only when a task hit it and the output was still on track; lower it when a task finished well under half the cap. Record the new values in `.agent/progress.md` with one line on why each changed, so the next person can see the reasoning.

A cap that fires is a signal, not only a failure: OpenCode removes tools on the last step and asks for a summary, so a stopped coder leaves a result file the lead can read. Check that the lead handles a `blocked` result before trusting the cap as a safety net.

## Revalidation and failed-attempt records

Added after comparing this plan with the StateDock discussion. A task marked ready is not the same as a task whose conditions still hold, so every task starts with a preflight the agent runs itself, and results separate what was verified from what was assumed.

**Preflight (every task and every Ralph pass).** Before any edit, the agent:

1. Lists commits since the brief or plan was last updated, and reads any that touch its files. Changes made outside the harness are reported in the result.
2. Runs the test suite and records the baseline. A red baseline stops the task unless the brief is to fix it.
3. Confirms the branch and working tree are clean and that the brief's dependencies still exist.
4. Rechecks any permission or environment condition the brief depends on, such as a deploy target or a required key.
5. If a check fails, or the spec section the brief cites has changed, the agent stops, writes a blocked result with the discrepancy, and returns to the lead. It does not adapt silently.

Preflight results go in the result file under Preflight: passed, or the list of discrepancies.

**Assumed versus verified.** Briefs and results keep these apart. Assumed items are unchecked claims; the lead verifies them or records them as open questions. A task counts as done only when its verified items are backed by command output or named tests, not by the subagent's own statement.

**Failed attempts.** Each result lists approaches tried and abandoned, with the reason, so later agents don't repeat them. Failed attempts that reveal a gotcha also go to `progress.md`.

**Decision rights.** Each brief names the decisions the subagent may make, such as local naming or which existing helper to use. Anything touching the spec, public interfaces, dependencies, permissions or tests returns to the lead.

**/audit command.** A periodic reconciliation, run before a major feature and after a stretch of manual changes outside the harness. A `reviewer` run:

- Reads the spec, the completed ledger rows and `progress.md`.
- Compares the current code against each completed task's acceptance criteria, and reports match, drift, duplicates and gaps.
- Returns findings only. The lead turns them into new tasks, and a second agent verifies the audit before anything is marked changed.

Command file, `.opencode/commands/audit.md`:

```markdown
---
description: Reconcile completed tasks with the current code
agent: reviewer
---

Recent commits:
!`git log --oneline -50`

For each completed row in .agent/ledger.md, check the current code against its acceptance criteria in docs/specs. Report match, drift, duplicate or gap, with file references. Do not edit anything.
```

**Later, not in Phases 1 to 4:** the ledger could move to a shared, MCP-backed task store, as StateDock does, if several projects need one view. The single-writer rule would still apply.

## Open questions and sources

- [ ] Confirm the `opencode run` flags for headless use and how it selects an agent, before relying on `ralph.sh`.
- [ ] Decide which models go on `lead`, `reviewer` and `coder`, and check their context windows are compatible for handoffs.
- [ ] Confirm whether path-scoped `edit` denies also block shell writes (for example `sed -i tests/...`); if not, restrict the coder's shell to named commands only, as above.
- [ ] Pick the sandbox for loop mode (devcontainer, DDEV or a throwaway VM).
- [ ] Decide whether specs follow a framework (Spec Kit, SPARC) or a lightweight in-house template.

Sources:

- [OpenCode V2 docs: Agents](https://opencode.ai/v2/docs/agents/)
- [OpenCode V2 docs: Commands](https://opencode.ai/v2/docs/commands/)
- [The New Stack: Karpathy on agentic engineering](https://thenewstack.io/vibe-coding-is-passe/)
- [Anthropic: Building effective agents](https://www.anthropic.com/research/building-effective-agents)
- [Martin Fowler: The Orchestrator's Tax](https://martinfowler.com/articles/orchestrator-tax.html)
- [Confucius Code Agent (arXiv 2512.10398)](https://arxiv.org/pdf/2512.10398)
- [agentpatterns.ai: Over-Orchestrated Agent Architecture](https://agentpatterns.ai/patterns/anti-patterns/prefer-simplest-agent-architecture/)
- [FutureAGI: The Ralph Loop](https://futureagi.com/blog/loop-engineering/ralph-loop/)
- [Marc Brooker: Spec Driven Development isn't Waterfall](https://brooker.co.za/blog/2026/04/09/waterfall-vs-spec)
- [Allstacks: Specs for AI agents, TDD and skills](https://allstacks.com/blog/how-to-write-specs-for-ai-agents-tdd-skills-and-what-comes-next)
