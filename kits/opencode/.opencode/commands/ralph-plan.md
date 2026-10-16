---
description: Write the plan as one-line tasks for loop mode (Phase 4)
agent: lead
---

Write .agent/plan.md as an ordered list of one-line unchecked tasks
(`- [ ] ...`) for the feature named in this request. Each task must be
small, independent, and verifiable by the test suite. Loop mode is for
mechanical work only — migrations, porting, test backfill. Design work and
anything with a moving spec stays out.

Confirm .agent/ralph-prompt.md matches the current hard rules in AGENTS.md
(update it if rules changed), and that scripts/ralph.sh's test command
matches the site's suite invocation.

Stop and present the plan for human approval before any loop is run. Loop
mode runs in a sandbox or container with no production credentials and no
push rights, on a dedicated branch — the human merges after review.
