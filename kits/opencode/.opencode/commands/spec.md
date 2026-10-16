---
description: Draft or update a living spec with acceptance criteria and edge cases
agent: lead
---

Draft or update docs/specs/<feature>.md for the feature named in this
request. Read .agent/progress.md for known gotchas first, and consult the
drupal-dev-planes failure-mode catalog (`list_failure_modes`) when the
feature touches config, modules, or content delivery.

Include: goal; scope and out-of-scope; acceptance criteria (each one
testable); edge cases and Drupal-specific failure modes (silent partial
success classes — config imported but page dead, cache semantics, install
ordering); open questions.

Size the spec to the risk: a one-line fix needs no spec, a new feature
needs a short living spec that is revised as you learn.

Then stop and present the spec for human approval. Do not start
implementation, and do not write tests yet.
