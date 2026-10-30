#!/bin/bash
# Chrome recovery state machine, fake-only, then each guard removed in turn must turn a named assertion red.
set -euo pipefail
cd "$(dirname "$0")/../.."
mkdir -p tests/.state/logs
node tests/bridge/chrome-heal.test.ts
for pair in running:ASSERT_HEAL_RUNNING ratelimit:ASSERT_HEAL_RATELIMIT once:ASSERT_HEAL_ONCE probe:ASSERT_HEAL_PROBE \
  singleflight:ASSERT_HEAL_SINGLEFLIGHT profile:ASSERT_HEAL_PROFILE bounded:ASSERT_HEAL_BOUNDED; do
  mutation="${pair%%:*}" label="${pair#*:}"
  log="tests/.state/logs/chrome-heal-falsified-${mutation}.log"
  if GADDI_HEAL_MUTATION="$mutation" node tests/bridge/chrome-heal.test.ts >"$log" 2>&1; then
    echo "FAIL removing the ${mutation} guard did not fail the recovery tests"; exit 1
  fi
  if ! rg -q "AssertionError.*${label}" "$log"; then
    cat "$log"; echo "FAIL ${mutation} falsification failed for an unrelated reason"; exit 1
  fi
  echo "FALSIFIED chrome heal: removing the ${mutation} guard fails ${label}"
done
rm -rf tests/.state/heal-mutant-*
