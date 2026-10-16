---
description: Break the approved spec into tasks and build; delegate separable work
agent: lead
---

Working-tree state:

!`git status --short`

Break the approved spec (the feature named in this request) into one-line
tasks in .agent/plan.md, ordered. Then implement:

- Do coupled work yourself — anything whose brief would exceed about a page
  or shares a mental model with another task (cognitive locality).
- Delegate separable tasks to `coder` with briefs in .agent/briefs/ using
  the template in AGENTS.md. Test backfill goes to `test-writer`.
- Run the preflight before your own edits and before each delegation.
- Update .agent/ledger.md only after checking evidence in each result file,
  never on the subagent's word alone.
- Red tests or review findings loop back to implementation. Nothing reaches
  the human without a green suite and a spec check.
- Record one learning per completed task in .agent/progress.md.
