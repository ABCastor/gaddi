#!/bin/bash
set -uo pipefail
cd "$(dirname "$0")/../.."
status=0
node tests/bridge/version-logic.ts || status=$?
node tests/fixtures/broker-checks.ts page-version gated || status=$?
node tests/bridge/version-falsify.ts || status=$?
exit "$status"
