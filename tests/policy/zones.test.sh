#!/usr/bin/env bash
# TEST-ZONE policy rules; the broker-level checks are ASSERT_ZONE in tests/fixtures/broker-checks.ts.
set -euo pipefail
cd "$(dirname "$0")/../.."
env -u GADDI_POLICY_OFF node tests/policy/zones.ts
