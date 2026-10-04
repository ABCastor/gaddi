#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
mkdir -p tests/.state/logs
node tests/fixtures/broker-checks.ts advice normal
COPY=$(mktemp -d tests/.state/advice-XXXXXX)
trap 'rm -rf "$COPY"' EXIT # Disposable mutation sources only.
mkdir -p "$COPY/tests/fixtures"
cp -R daemon "$COPY/daemon"
cp tests/fixtures/*.ts "$COPY/tests/fixtures/"
ln -s "$PWD/policy" "$COPY/policy"
ln -s "$PWD/shared" "$COPY/shared"
ln -s "$PWD/cli" "$COPY/cli"
ln -s "$PWD/tests/mcp" "$COPY/tests/mcp"
node --input-type=module - "$COPY/daemon/daemon.ts" <<'NODE'
import fs from 'node:fs';
import assert from 'node:assert/strict';
const file = process.argv[2], source = fs.readFileSync(file, 'utf8');
assert.ok(source.includes('if (count >= 3)'));
fs.writeFileSync(file, source.replace('if (count >= 3)', 'if (false)'));
NODE
mkdir -p "$COPY/tests/.state"
LOG=tests/.state/logs/advice-falsified.log
if GADDI_BREAK_ADVICE=1 node "$COPY/tests/fixtures/broker-checks.ts" advice broken >"$LOG" 2>&1; then
  echo 'FAIL advisory mutation passed'; exit 1
fi
if ! rg -q '^FAIL ASSERTION advice: ASSERT_NO_EFFECT_THIRD' "$LOG"; then cat "$LOG"; exit 1; fi
echo 'FALSIFIED no-effect warning: omitted advice fails ASSERT_NO_EFFECT_THIRD'
