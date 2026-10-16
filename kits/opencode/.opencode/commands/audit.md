---
description: Reconcile completed tasks with the current code
agent: reviewer
---

Recent commits:

!`git log --oneline -50`

Run before a major feature, and after a stretch of manual changes outside
the harness. For each completed row in .agent/ledger.md, check the current
code against its acceptance criteria in docs/specs. Report match, drift,
duplicate or gap, with file references. Do not edit anything.

Findings only. The lead turns them into new tasks, and a second reviewer
run verifies the audit before anything is marked changed.
