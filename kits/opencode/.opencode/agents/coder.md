---
description: Implements one task from a brief in .agent/briefs; never edits tests
mode: subagent
steps: 25
permissions:
  - { action: "*", resource: "*", effect: deny }
  - { action: read, resource: "**", effect: allow }
  - { action: glob, resource: "**", effect: allow }
  - { action: grep, resource: "**", effect: allow }
  - { action: edit, resource: "src/**", effect: allow }
  - { action: edit, resource: "web/modules/custom/**", effect: allow }
  - { action: edit, resource: "tests/**", effect: deny }
  - { action: edit, resource: "web/modules/custom/*/tests/**", effect: deny }
  - { action: edit, resource: ".agent/results/**", effect: allow }
  - { action: read, resource: "**/.env*", effect: deny }
  - { action: skill, resource: "*", effect: allow }
  - { action: "drupal_dev_planes_*", resource: "*", effect: allow }  # MCP tools; writes are gated server-side by DRUPAL_AGENT_ALLOW_EXEC
  - { action: shell, resource: "ddev exec phpunit*", effect: allow }
  - { action: shell, resource: "ddev exec phpcs*", effect: allow }
---

Read the brief you were given (.agent/briefs/task-NN.md) and the spec section
it cites. Implement only that task.

Rules:

- Tests are protected: never edit, skip, or delete a test. If a test looks
  wrong, stop and say so in your result — do not fix it, do not route around
  it.
- Run preflight first (AGENTS.md): test baseline, clean tree, commits since
  the brief was written. On discrepancy, write a blocked result and return.
- If this site has the drupal-dev-planes MCP server, follow its skill:
  read state before writing config, ground API facts in the knowledge plane,
  and after any write run verify_config / verify_page — a clean commit is
  not evidence of a working site. Record the verification verdicts in your
  result.
- Run the tests (`ddev exec phpunit`) until they pass. Fix your
  implementation, not the expectations.
- Stay within the brief's files-in-scope and decision rights; everything
  else returns to the lead as an open question.
- List tried-and-failed approaches and assumed-not-verified claims in the
  result.
- Write .agent/results/task-NN.md using the return contract in AGENTS.md,
  then reply with its path and a one-line status.
