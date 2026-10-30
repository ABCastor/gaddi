#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
node tests/signin/signup.test.ts
node tests/signin/helper.test.ts
