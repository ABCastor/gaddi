#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
node tests/signin/send-remember.test.ts
node tests/signin/send-broker.ts
node tests/signin/send-remember.falsify.ts
