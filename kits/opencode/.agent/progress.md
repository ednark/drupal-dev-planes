# Progress

Append-only learnings and gotchas, one line each, written through the lead
(from subagent results' Learnings lines, preflight discrepancies, and
cap/step tuning decisions).

## Signals to track (harness doc §Rollout phases)

- Share of tasks needing a second attempt or a human fix after the reviewer
  passed them.
- Delegated tasks blocked for missing context (briefs too thin or tasks too
  coupled).
- Any test removed or weakened in a diff (target: zero without approval).
- Lead context resets per feature (frequent resets suggest too much raw
  output reaching it).

<!--
Model choice notes: strongest model on lead and reviewer; cheaper model
usually fine for test-writer, coder, explore. Record model changes here.
-->
