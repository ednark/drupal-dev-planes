#!/usr/bin/env bash
# scripts/ralph.sh — loop mode (Phase 4): one task per pass, fresh context.
#
# Guardrails (harness doc):
#   - Run in a sandbox/container with no production credentials, no push rights.
#   - Work on a dedicated branch; the human merges after review, never the loop.
#   - Hard stops: plan empty, tests red after a pass, max passes, task blocked twice.
#
# CAVEATS (harness doc open questions — verify before relying):
#   - Confirm the exact non-interactive flags of `opencode run` in your
#     installed version (`opencode run --help`) before using in automation.
#   - Replace the suite command with the site's actual invocation
#     (default here: ddev exec phpunit).
#   - .agent/plan.md must contain `- [ ]` task lines (/ralph-plan writes them).
set -uo pipefail

MAX=${1:-20}
TEST_CMD=${TEST_CMD:-"ddev exec phpunit"}
cd "$(dirname "$0")/.." || exit 1

for i in $(seq 1 "$MAX"); do
  grep -q '^- \[ \]' .agent/plan.md || { echo "plan complete"; exit 0; }
  echo "=== pass $i ==="
  opencode run --agent lead "$(cat .agent/ralph-prompt.md)" || true
  if ! $TEST_CMD; then
    echo "tests red after pass $i; stopping for review"; exit 1
  fi
done
echo "hit max passes ($MAX); review .agent/progress.md"
