#!/bin/bash
# Real broker, extension and native host in a disposable headless Chrome: kill it, prove the broker reopens it.
set -euo pipefail
cd "$(dirname "$0")/../.."
mkdir -p tests/.state/logs
node tests/bridge/chrome-heal-browser.ts
for pair in call:ASSERT_HEAL_BROWSER sync:ASSERT_HEAL_BROWSER; do
  mutation="${pair%%:*}" label="${pair#*:}"
  log="tests/.state/logs/chrome-heal-browser-falsified-${mutation}.log"
  if GADDI_HEAL_BREAK="$mutation" node tests/bridge/chrome-heal-browser.ts >"$log" 2>&1; then
    echo "FAIL breaking ${mutation} did not fail the disposable-Chrome recovery"; exit 1
  fi
  if ! rg -q "AssertionError.*${label}" "$log"; then
    cat "$log"; echo "FAIL ${mutation} falsification failed for an unrelated reason"; exit 1
  fi
  echo "FALSIFIED chrome heal browser: breaking ${mutation} fails ${label}"
done
