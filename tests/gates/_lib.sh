#!/usr/bin/env bash
# Each gate must fail a real assertion with policy off; startup/socket failures never falsify it.
set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEST_NAME="$(basename "${TEST_FILE:?}" .test.sh)"
gate_main() {
  mkdir -p "$REPO/tests/.state"
  local gated="$REPO/tests/.state/$TEST_NAME.gated.log"
  local ungated="$REPO/tests/.state/$TEST_NAME.ungated.log"
  env -u GADDI_POLICY_OFF node "$REPO/tests/fixtures/broker-checks.ts" "$TEST_NAME" gated > "$gated" 2>&1
  local g=$?
  cat "$gated"
  GADDI_POLICY_OFF=1 node "$REPO/tests/fixtures/broker-checks.ts" "$TEST_NAME" ungated > "$ungated" 2>&1
  local u=$?
  cat "$ungated"
  if [[ $g -eq 0 && $u -eq 1 ]] && grep -q '^FAIL ASSERTION ' "$ungated" && ! grep -q '^INFRA ' "$ungated"; then
    echo "FALSIFIED $TEST_NAME (ungated assertion failed)"
    echo "PASS $TEST_NAME"
    return 0
  fi
  echo "FAIL $TEST_NAME (gated exit $g, ungated exit $u; assertion falsification required)"
  return 1
}
