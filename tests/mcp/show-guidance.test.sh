#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
mkdir -p tests/.state/logs
COPY="$(mktemp -d tests/.state/show-guidance-XXXXXX)"
mkdir -p "$COPY/tests/mcp"
cp -R mcp shared "$COPY/"
cp package.json "$COPY/"
cp tests/mcp/metadata.test.ts "$COPY/tests/mcp/"
ln -s "$PWD/node_modules" "$COPY/node_modules"
for mutation in INSTRUCTIONS DESCRIPTION; do
  cp mcp/server.ts "$COPY/mcp/"
  node --input-type=module - "$COPY/mcp/server.ts" "$mutation" <<'NODE'
import fs from 'node:fs';
import assert from 'node:assert/strict';
const [file,mutation]=process.argv.slice(2);
const before=mutation==='INSTRUCTIONS'?'Rendering never needs show; show only requests owner attention':'Request owner attention, without focus by default. Rendering never needs show.';
const after='Bring tabs to the front to render them.';
const source=fs.readFileSync(file,'utf8');assert.equal(source.split(before).length,2);fs.writeFileSync(file,source.replace(before,after));
NODE
  log="tests/.state/logs/show-guidance-${mutation}-falsified.log"
  if node "$COPY/tests/mcp/metadata.test.ts" >"$log" 2>&1; then
    echo "FAIL show guidance $mutation: mutant passed"; exit 1
  fi
  if ! rg -q 'AssertionError.*ASSERT_SHOW_GUIDANCE' "$log"; then
    cat "$log"; echo "FAIL show guidance $mutation: unrelated failure"; exit 1
  fi
  echo "FALSIFIED show guidance $mutation: ASSERT_SHOW_GUIDANCE failed"
done
