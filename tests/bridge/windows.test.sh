#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
node tests/bridge/windows.ts
mkdir -p tests/.state/logs
for mutation in OWN SECONDARY ATTENTION SHARED RESTORE RELOAD RECYCLED RECREATE DISPLAY_CHANGE BLANK RENDER CLEANUP OWNER PAINT BROKER_STOP; do
  log="tests/.state/logs/window-${mutation}-falsified.log"
  if node tests/bridge/windows.ts "$mutation" >"$log" 2>&1; then
    echo "FAIL window $mutation: mutant passed"; exit 1
  fi
  if ! rg -q "^FAIL ASSERT_WINDOW_${mutation}:" "$log"; then
    cat "$log"; echo "FAIL window $mutation: unrelated failure"; exit 1
  fi
  echo "FALSIFIED window $mutation: ASSERT_WINDOW_${mutation} failed"
done
