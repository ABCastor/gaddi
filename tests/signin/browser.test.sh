#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
node tests/signin/browser.test.ts
mkdir -p tests/.state/logs
log=tests/.state/logs/signin-browser-falsified.log
if GADDI_SIGNIN_BREAK_LANDED=1 node tests/signin/browser.test.ts >"$log" 2>&1; then
  echo 'FAIL removing credential recovery did not fail the real password fixture'
  exit 1
fi
if ! rg -q 'AssertionError.*ASSERT_SIGNIN_RELOAD \?sticky' "$log"; then
  cat "$log"
  echo 'FAIL sign-in falsification failed for an unrelated reason'
  exit 1
fi
echo 'FALSIFIED sign-in: removing interrupted-insert recovery fails the real password fixture'
for mutation in NAME FORM; do
  log="tests/.state/logs/signin-browser-aura-${mutation}.log"
  if GADDI_SIGNIN_BREAK_AURA="$mutation" node tests/signin/browser.test.ts >"$log" 2>&1; then
    echo "FAIL removing component sign-in ${mutation} did not fail its fixture"
    exit 1
  fi
  if ! rg -q 'AssertionError.*ASSERT_SIGNIN_RELOAD \?aura' "$log"; then
    cat "$log"
    echo "FAIL component sign-in ${mutation} failed for an unrelated reason"
    exit 1
  fi
  echo "FALSIFIED component sign-in: removing ${mutation} fails the real fixture"
done
