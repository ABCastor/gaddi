#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
mkdir -p tests/.state/helper-evidence
node tests/downloads/files.test.ts
node tests/downloads/broker.test.ts
for scenario in signup download; do
  log="tests/.state/helper-evidence/ungated-${scenario}.log"
  if [[ "$scenario" == download ]]; then
    export GADDI_HELPER_ONLY_DOWNLOAD=1
    assertion=ASSERT_DOWNLOAD_HOLD
    fault=GADDI_HELPER_POLICY_OFF=1
  else
    unset GADDI_HELPER_ONLY_DOWNLOAD
    assertion=ASSERT_HELPER_CREATE_HOLD
    fault=GADDI_HELPER_BREAK_CREATE_HOLD=1
  fi
  if env "$fault" node tests/downloads/broker.test.ts >"$log" 2>&1; then
    echo "FAIL ungated $scenario unexpectedly passed"; exit 1
  fi
  if ! grep -q "AssertionError.*$assertion" "$log"; then
    cat "$log"; echo "FAIL unrelated ungated $scenario failure"; exit 1
  fi
  echo "FALSIFIED helper $scenario: removing its hold fails $assertion"
done
