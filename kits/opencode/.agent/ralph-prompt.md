# Loop pass

Read AGENTS.md, .agent/plan.md and .agent/progress.md. Run the preflight
(commits since the plan was updated, test baseline, clean tree,
permissions/conditions) and stop on any discrepancy. Take the first
unchecked task in .agent/plan.md; do only that task. Run the tests. On
green, tick the task, append one learning to .agent/progress.md, commit. If
the same task fails twice, mark it blocked with the reason and stop.

Hard rules:

- Never edit, skip, or delete a test; never implement against a failing
  test by changing the test.
- If the drupal-agent-planes MCP server is configured: never write config
  from memory, never assume state, and after any write run
  verify_config / verify_page — a clean commit is not evidence of a working
  site.
- Commit only on a green suite. Never push.
