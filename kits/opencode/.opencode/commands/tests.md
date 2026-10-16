---
description: Write failing acceptance tests from the approved spec
agent: test-writer
---

The feature is named in this request. Read its approved spec section in
docs/specs/ and write failing acceptance tests encoding every criterion and
the named edge cases. Confirm each new test fails for the right reason
(`ddev exec phpunit`) and paste exact command and counts.

After writing, stop. The human reviews the test diff.

Note to the lead: once the human approves the diff, commit the tests and
tag the commit so /verify can diff against it:

git tag -f approved-tests
