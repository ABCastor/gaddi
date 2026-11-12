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
# Each fault removes one guarantee of the public-broker journeys; the run must go red on that guarantee's assertion.
for row in "fill-ungated|ASSERT_FILL_HELD_LIKE_SIGNIN" "create-ignores-remember|ASSERT_REMEMBERED_CREATE_SUBMITS"; do
  IFS='|' read -r mutation assertion <<<"$row"
  log="tests/.state/logs/signin-browser-${mutation}.log"
  if GADDI_SIGNIN_HELPER_ONLY=1 GADDI_HELPER_MUTATE="$mutation" node tests/signin/browser.test.ts >"$log" 2>&1; then
    echo "FAIL ${mutation} did not fail its journey"
    exit 1
  fi
  if ! rg -q "AssertionError.*${assertion}" "$log"; then
    cat "$log"
    echo "FAIL ${mutation} failed for an unrelated reason"
    exit 1
  fi
  echo "FALSIFIED public broker: ${mutation} fails ${assertion}"
done
# CONFIRM: the confirm-email box stays empty, so the site refuses the form; CAPTCHA: the probe sees a challenge.
for row in "CONFIRM|ASSERT_REGISTER_ACCEPTED" "CAPTCHA|ASSERT_REMEMBERED_CREATE_SUBMITS"; do
  IFS='|' read -r mutation assertion <<<"$row"
  log="tests/.state/logs/signin-browser-signup-${mutation}.log"
  if GADDI_SIGNIN_HELPER_ONLY=1 GADDI_SIGNIN_BREAK_CONTENT="$mutation" node tests/signin/browser.test.ts >"$log" 2>&1; then
    echo "FAIL removing sign-up ${mutation} did not fail the Ombudsman-shaped journey"
    exit 1
  fi
  if ! rg -q "AssertionError.*${assertion}" "$log"; then
    cat "$log"
    echo "FAIL sign-up ${mutation} failed for an unrelated reason"
    exit 1
  fi
  echo "FALSIFIED sign-up: removing ${mutation} fails the Ombudsman-shaped journey"
done
