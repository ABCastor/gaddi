#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
node tests/bridge/sessions-idle.ts
mkdir -p tests/.state/logs
for mutation in FIRST_SIGHT ORPHAN_CLOSE DISCARD_TIME LIVE_SESSION TAB_CLOCK OPEN_CLOCK REATTACH_CLOCK SHOWN END_GRACE BATCH CLOSED_ONLY SHARED; do
  log="tests/.state/logs/idle-${mutation}-falsified.log"
  if node tests/bridge/sessions-idle.ts "$mutation" >"$log" 2>&1; then
    echo "FAIL idle $mutation: mutant passed"; exit 1
  fi
  if ! rg -q "^FAIL ASSERT_IDLE_${mutation}:" "$log"; then
    cat "$log"; echo "FAIL idle $mutation: unrelated failure"; exit 1
  fi
  echo "FALSIFIED idle $mutation: ASSERT_IDLE_${mutation} failed"
done
