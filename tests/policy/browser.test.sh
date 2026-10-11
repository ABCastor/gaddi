#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
mkdir -p tests/.state/logs
COPY="$(mktemp -d tests/.state/browser-policy-XXXXXX)"
mkdir -p "$COPY/daemon" "$COPY/policy" "$COPY/shared" "$COPY/tests/policy"
cp package.json "$COPY/"
cp shared/protocol.ts "$COPY/shared/"
cp tests/policy/overlay.ts "$COPY/tests/policy/"
for mutation in DEFAULT MERGE INVALID; do
  cp daemon/policy.ts "$COPY/daemon/"
  cp policy/policy.default.json "$COPY/policy/"
  node --input-type=module - "$COPY" "$mutation" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const [copy,mutation]=process.argv.slice(2);
if(mutation==='DEFAULT') {
  const file=path.join(copy,'policy/policy.default.json');const policy=JSON.parse(fs.readFileSync(file,'utf8'));
  policy.browser.window='shared';fs.writeFileSync(file,JSON.stringify(policy));
} else {
  const file=path.join(copy,'daemon/policy.ts');let source=fs.readFileSync(file,'utf8');
  const before=mutation==='MERGE'?'out[k] = isRecord(base[k])':"window: v => v === 'own' || v === 'shared'";
  const after=mutation==='MERGE'?"out[k] = k !== 'browser' && isRecord(base[k])":'window: () => true';
  assert.equal(source.split(before).length,2);fs.writeFileSync(file,source.replace(before,after));
}
NODE
  log="tests/.state/logs/browser-policy-${mutation}-falsified.log"
  if node "$COPY/tests/policy/overlay.ts" >"$log" 2>&1; then
    echo "FAIL browser policy $mutation: mutant passed"; exit 1
  fi
  if ! rg -q "ASSERT_BROWSER_POLICY_${mutation}" "$log"; then
    cat "$log";echo "FAIL browser policy $mutation: unrelated failure";exit 1
  fi
  echo "FALSIFIED browser policy $mutation: ASSERT_BROWSER_POLICY_${mutation} failed"
done
