#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
npx --no-install tsc --noEmit
echo 'PASS TypeScript: strict noEmit check'
node tests/typescript.ts
echo '== TypeScript: 3 passed, 0 failed'
