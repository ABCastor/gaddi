#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
node tests/bridge/react-widgets.ts
mkdir -p tests/.state/logs
# Each fault removes one guarantee; the run must go red on that guarantee's own assertion.
for row in "PATIENT|ASSERT_REACT_LATE_CHANGE_SEEN" "HIDDEN|ASSERT_REACT_HIDDEN_OPTION"; do
  IFS='|' read -r mutation assertion <<<"$row"
  log="tests/.state/logs/react-widgets-${mutation}.log"
  if GADDI_REACT_BREAK="$mutation" node tests/bridge/react-widgets.ts >"$log" 2>&1; then
    echo "FAIL removing ${mutation} did not fail its React widget"
    exit 1
  fi
  if ! rg -q "AssertionError.*${assertion}" "$log"; then
    cat "$log"
    echo "FAIL ${mutation} failed for an unrelated reason"
    exit 1
  fi
  echo "FALSIFIED react widgets: removing ${mutation} fails ${assertion}"
done
