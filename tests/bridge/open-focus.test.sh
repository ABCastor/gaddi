#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
node tests/bridge/open-focus.ts
mkdir -p tests/.state/logs
for mutation in RESTORE EXISTING CHROME USER_SWITCH OPEN_ERROR READ_FAILURE ACTIVATE_FAILURE ADAPTER NON_MAC MALFORMED BRIDGE_ERROR BROKER_WIRING; do
  log="tests/.state/logs/open-focus-${mutation}-falsified.log"
  code=0
  node tests/bridge/open-focus.ts "$mutation" >"$log" 2>&1 || code=$?
  if [[ "$code" -eq 0 ]]; then echo "FAIL open focus $mutation: mutant passed"; exit 1; fi
  if ! rg -q "^FAIL ASSERT_OPEN_FOCUS_${mutation}:" "$log"; then
    cat "$log";echo "FAIL open focus $mutation: unrelated failure";exit 1
  fi
  echo "FALSIFIED open focus $mutation: ASSERT_OPEN_FOCUS_${mutation} failed"
done
