<!-- Harness kit: AGENTS.snippet.md — append to the project's AGENTS.md
     (or use as the starting AGENTS.md on a fresh project). Keep it short:
     it is loaded every session. Living learnings go to .agent/progress.md,
     not here. -->

## Harness

Agents coordinate through files, not through each other's context. Any agent
can rebuild its picture from disk.

- `docs/specs/<feature>.md` — living spec per feature, versioned in git
- `docs/decisions/NNNN-<slug>.md` — short ADRs for choices worth remembering
- `.agent/plan.md` — current task list, ordered, one line each
- `.agent/ledger.md` — task status table; ONLY the lead writes it
- `.agent/progress.md` — append-only learnings and gotchas
- `.agent/briefs/task-NN.md` — brief handed to a subagent
- `.agent/results/task-NN.md` — return contract written by that subagent

Hard rules:

- The drupal-dev-planes skill is the standing Drupal discipline: never
  write config from memory, never assume state, never trust the commit.
  After any write, verify_config / verify_page before claiming success.
- Tests are the executable spec. Never edit, skip, or delete a test to make
  it pass; if a test looks wrong, stop and say so.
- Verify evidence, not claims. A task is done only when backed by command
  output or named tests — never by the subagent's own statement.
- Single writer per file. Subagents never edit the plan, ledger, spec or
  AGENTS.md; they propose changes in their result.
- Every task starts with a preflight: commits since the brief was written,
  test baseline, clean tree, permissions/conditions the brief depends on.
  On discrepancy, stop and report — do not adapt silently.

## Brief template (lead → subagent)

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

If a brief needs more than about a page, the task is too coupled to
delegate; the lead does it itself.

## Return contract (subagent → lead)

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

## Commands

- `/spec <feature>` — draft or update the spec; stop for human approval
- `/tests <feature>` — failing acceptance tests; human reviews the diff,
  then the lead tags the approved commit `approved-tests`
- `/build <feature>` — plan + implement; coupled work by the lead,
  separable work delegated with briefs
- `/verify` — full suite + confirm tests/ unchanged since `approved-tests`
- `/review` — reviewer reads the diff against the spec
- `/audit` — reviewer reconciles completed ledger rows with current code
- `/ralph-plan <feature>` — one-line tasks for loop mode (Phase 4)
