#!/usr/bin/env bash
# Install the harness kit into a target project directory.
# Usage: ./install.sh <target-project-dir>
set -euo pipefail

TARGET="${1:?usage: install.sh <target-project-dir>}"
SRC="$(cd "$(dirname "$0")" && pwd)"

if [ ! -d "$TARGET" ]; then
  echo "error: target '$TARGET' does not exist" >&2
  exit 1
fi
if [ -e "$TARGET/.agent" ]; then
  echo "error: $TARGET/.agent already exists — refusing to overwrite (this project may already run a harness)" >&2
  exit 1
fi
if [ -e "$TARGET/.opencode/agents/lead.md" ]; then
  echo "error: $TARGET/.opencode already has a lead agent — refusing to overwrite" >&2
  exit 1
fi

cp -R "$SRC/.opencode" "$TARGET/"
cp -R "$SRC/.agent" "$TARGET/"
mkdir -p "$TARGET/docs/specs"

cat <<EOF

Copied .opencode/ and .agent/ into $TARGET and created docs/specs/.

Finish by hand:
  1. Merge $SRC/opencode.jsonc into $TARGET/opencode.jsonc
  2. Append $SRC/AGENTS.snippet.md to $TARGET/AGENTS.md
  3. Adjust per-project knobs (test command, edit globs) — see $SRC/README.md

EOF
