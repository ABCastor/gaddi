#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/../.."
export GADDI_BRIDGE_RESTART_ONLY=1
GADDI_BRIDGE_BREAK_REQUEST_DEADLINE=0 node tests/bridge/extension.ts
mkdir -p tests/.state/logs
LOG=tests/.state/logs/bridge-restart-falsified.log
if GADDI_BRIDGE_BREAK_REQUEST_DEADLINE=1 node tests/bridge/extension.ts >"$LOG" 2>&1; then
  echo 'FAIL removing the request deadline did not fail the restart regression'
  exit 1
fi
if ! rg -q 'AssertionError.*ASSERT_RESTART_REQUEST_DEADLINE' "$LOG"; then
  cat "$LOG"
  echo 'FAIL restart falsification failed for an unrelated reason'
  exit 1
fi
echo 'FALSIFIED bridge restart: removing the request deadline fails ASSERT_RESTART_REQUEST_DEADLINE'
