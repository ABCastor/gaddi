#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
node tests/signin/upload-remember.test.ts
node tests/signin/upload-broker.ts
node tests/signin/upload-remember.falsify.ts
