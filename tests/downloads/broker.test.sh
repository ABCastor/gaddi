#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
mkdir -p tests/.state/helper-evidence
node tests/downloads/files.test.ts
node tests/downloads/policy.test.ts
node tests/downloads/broker.test.ts
# Each fault removes one guarantee; the run must go red on that guarantee's own assertion.
# name | assertion | environment
falsifications=(
  "signup|ASSERT_HELPER_CREATE_HOLD|GADDI_HELPER_BREAK_CREATE_HOLD=1 GADDI_HELPER_DOWNLOAD_PHASE=default"
  "download-no-hold|ASSERT_DOWNLOAD_NO_HOLD|GADDI_HELPER_MUTATE=download-always-hold GADDI_HELPER_ONLY_DOWNLOAD=1 GADDI_HELPER_DOWNLOAD_PHASE=default"
  "download-click-hold|ASSERT_DOWNLOAD_KEEPS_CLICK_HOLD|GADDI_HELPER_MUTATE=download-drops-click-hold GADDI_HELPER_ONLY_DOWNLOAD=1 GADDI_HELPER_DOWNLOAD_PHASE=default"
  "download-opt-in-hold|ASSERT_DOWNLOAD_HOLD|GADDI_HELPER_MUTATE=download-ignores-switch GADDI_HELPER_DOWNLOAD_PHASE=hold"
  "download-policy-off|ASSERT_DOWNLOAD_HOLD|GADDI_HELPER_POLICY_OFF=1 GADDI_HELPER_DOWNLOAD_PHASE=hold"
)
for row in "${falsifications[@]}"; do
  IFS='|' read -r scenario assertion fault <<<"$row"
  log="tests/.state/helper-evidence/ungated-${scenario}.log"
  # shellcheck disable=SC2086
  if env $fault node tests/downloads/broker.test.ts >"$log" 2>&1; then
    echo "FAIL ungated $scenario unexpectedly passed"; exit 1
  fi
  if ! grep -q "AssertionError.*$assertion\b" "$log"; then
    cat "$log"; echo "FAIL unrelated ungated $scenario failure"; exit 1
  fi
  echo "FALSIFIED helper $scenario: removing its guarantee fails $assertion"
done
