#!/usr/bin/env bash
# OP-DIAGNOSTICS with a fake op only: no real op, token, item or browser.
set -euo pipefail
cd "$(dirname "$0")/../.."
node tests/signin/op-failure.test.ts
