#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
node tests/bridge/eval-readonly.ts
mkdir -p tests/.state/logs
# The engine's side-effect check removed: the bypass assertion must go red, and only it.
LOG=tests/.state/logs/eval-readonly-falsified.log
if GADDI_EVAL_BREAK=READONLY node tests/bridge/eval-readonly.ts >"$LOG" 2>&1; then
  echo 'FAIL running eval with side effects did not fail the bypass assertion'; exit 1
fi
if ! rg -q 'AssertionError.*ASSERT_EVAL_BYPASS_REFUSED' "$LOG" || ! rg -q '^PASS eval reads' "$LOG"; then
  cat "$LOG"; echo 'FAIL eval read-only falsification failed for an unrelated reason'; exit 1
fi
echo 'FALSIFIED eval read-only: turning off the side-effect check fails ASSERT_EVAL_BYPASS_REFUSED'
