#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
# HANDOFF-SHOW in a real Chrome for Testing (headless=new, disposable profile): show and foreground open restore the
# minimized window holding the tab; background work and unrelated windows stay as they were.
node tests/bridge/handoff.ts
mkdir -p tests/.state/logs
for pair in SHOW:ASSERT_HANDOFF_SHOW OPEN:ASSERT_HANDOFF_OPEN QUIET:ASSERT_HANDOFF_QUIET OTHER:ASSERT_HANDOFF_OTHER_WINDOW BOUNDS:ASSERT_HANDOFF_BOUNDS; do
  mutation=${pair%%:*} assertion=${pair#*:}
  LOG="tests/.state/logs/handoff-${mutation}-falsified.log"
  if GADDI_HANDOFF_BREAK=$mutation node tests/bridge/handoff.ts >"$LOG" 2>&1; then
    echo "FAIL handoff $mutation: mutant passed"; exit 1
  fi
  if ! rg -q "AssertionError.*${assertion}:" "$LOG"; then
    cat "$LOG"; echo "FAIL handoff $mutation: failed for an unrelated reason"; exit 1
  fi
  echo "FALSIFIED handoff $mutation: $assertion failed"
done
