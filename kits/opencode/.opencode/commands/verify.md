---
description: Run the suite and confirm tests were not changed since approval
agent: lead
---

Test diff since approval:

!`git diff --stat approved-tests -- tests/ ':(glob)web/modules/custom/*/tests/**'`

Run the full test suite (`ddev exec phpunit`). Report pass/fail counts with
the output tail, not the full log.

If the diff above is not empty, stop and list every changed test file —
tests may not drift after approval without a human-approved re-run of
/tests.

Only a green suite plus an empty test diff passes verification. Then record
the outcome in .agent/ledger.md. If the drupal-agent-planes server is
configured and the feature made site writes, also confirm the verification
verdicts (verify_config / verify_page) recorded in the results — "tests
green" does not prove the delivered site works.
