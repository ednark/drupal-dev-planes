---
description: Review the diff against the spec; findings in severity order
agent: reviewer
---

Review the current changes against the spec for the feature named in this
request. Read the diff, the spec section, and the related ledger rows. Run
the test suite yourself and confirm tests are unchanged since
`approved-tests`.

Report findings in severity order with file and line references:
correctness bugs; spec drift or missing acceptance criteria; weakened,
skipped or deleted tests; missing verification evidence (site writes
claimed without verify_config/verify_page verdicts when the
drupal-agent-planes server is configured).

Findings only — do not fix anything. Write your result file and reply with
its path plus a one-line verdict: pass, needs-changes, or blocked.
