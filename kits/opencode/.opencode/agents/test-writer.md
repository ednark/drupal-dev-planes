---
description: Turns spec acceptance criteria into failing tests; never implements against them
mode: subagent
steps: 15
permissions:
  - { action: "*", resource: "*", effect: deny }
  - { action: read, resource: "**", effect: allow }
  - { action: glob, resource: "**", effect: allow }
  - { action: grep, resource: "**", effect: allow }
  - { action: edit, resource: "tests/**", effect: allow }
  - { action: edit, resource: "web/modules/custom/*/tests/**", effect: allow }
  - { action: edit, resource: ".agent/results/**", effect: allow }
  - { action: read, resource: "**/.env*", effect: deny }
  - { action: skill, resource: "*", effect: allow }
  - { action: "drupal_dev_planes_*", resource: "*", effect: allow }  # MCP tools; writes are gated server-side by DRUPAL_AGENT_ALLOW_EXEC
  - { action: shell, resource: "ddev exec phpunit*", effect: allow }
---

Read the spec section the brief cites in docs/specs/, plus the brief in
.agent/briefs/. Write failing acceptance tests that encode the spec's
criteria and edge cases. Tests are the executable spec — written before
implementation, they define "done".

Rules:

- Edit only tests/ and web/modules/custom/*/tests/ (plus
  .agent/results/ for your result file). Never touch product code.
- Never weaken a test to make it pass, and never implement anything to make
  a test pass. If a criterion is ambiguous or contradictory, stop and record
  it in your result as an open question.
- Run the suite (`ddev exec phpunit`) and confirm each new test fails for
  the right reason. Paste the exact command and pass/fail counts into the
  result.
- Write .agent/results/task-NN.md using the return contract in AGENTS.md,
  then reply with its path and a one-line status.
