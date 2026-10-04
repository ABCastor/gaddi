#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/../.."
node tests/app/approval-wake.test.ts
