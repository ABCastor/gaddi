#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
mkdir -p tests/.state/logs
node tests/fixtures/broker-checks.ts sessions normal

COPY=$(mktemp -d tests/.state/sessions-XXXXXX)
trap 'rm -rf "$COPY"' EXIT # Disposable mutation sources only.
mkdir -p "$COPY/tests/fixtures" "$COPY/tests/.state"
cp -R daemon mcp shared policy cli "$COPY/"
cp tests/fixtures/*.ts "$COPY/tests/fixtures/"
ln -s "$PWD/tests/mcp" "$COPY/tests/mcp"

for mutation in END SHOWN CROSS FOREGROUND GROUPED MOVED ISOLATION IDLE AUDIT REATTACH; do
  # Reset from the real source before applying ONE distinct mutation to this copy.
  cp daemon/daemon.ts "$COPY/daemon/daemon.ts"
  node --input-type=module - "$COPY/daemon/daemon.ts" "$mutation" <<'NODE'
import fs from 'node:fs';
import assert from 'node:assert/strict';
const [file, mutation] = process.argv.slice(2);
const mutations = {
  END: ['session.endedAt !== undefined && start - session.endedAt >= SESSION_END_MS', 'session.endedAt !== undefined'],
  SHOWN: ["if (method === 'show') rememberShown(selected[0]);", "if (method === 'show' && !session.owned.has(selected[0])) rememberShown(selected[0]);"],
  CROSS: ["if (method === 'show') rememberShown(selected[0]);", "if (method === 'show' && session.owned.has(selected[0])) rememberShown(selected[0]);"],
  FOREGROUND: ['if (params.foreground === true) rememberShown(meta.tab);', 'if (false) rememberShown(meta.tab);'],
  GROUPED: ["// Grouping existing tabs never grants ownership: these may be the user's tabs.", "if (method === 'group') for (const id of selected) session.owned.add(id);"],
  MOVED: ["return typeof group === 'string' && group.startsWith(AGENT_GROUP_PREFIX);", 'return true;'],
  ISOLATION: ['if (session) session.endedAt = Date.now();', 'if (session) for (const sibling of sessions.values()) if (sibling.caller === session.caller) sibling.endedAt = Date.now();'],
  IDLE: ['const idle = start - session.lastActivity >= SESSION_IDLE_MS;', 'const idle = false;'],
  AUDIT: ['if (closed.length) audit(', 'if (false) audit('],
  REATTACH: ['for (const session of sessions.values()) session.owned.clear();', 'void 0;'],
};
const source = fs.readFileSync(file, 'utf8'), [before, after] = mutations[mutation];
assert.equal(source.split(before).length, 2, `${mutation}: mutation target must occur exactly once`);
fs.writeFileSync(file, source.replace(before, after));
NODE
  LOG="tests/.state/logs/sessions-${mutation}-falsified.log"
  code=0
  node "$COPY/tests/fixtures/broker-checks.ts" sessions "$mutation" >"$LOG" 2>&1 || code=$?
  if [[ "$code" -ne 1 ]] || rg -q '^INFRA ' "$LOG" \
    || [[ $(rg -c '^FAIL ASSERTION sessions:' "$LOG") != 1 ]] \
    || ! rg -q "^FAIL ASSERTION sessions: ASSERT_SESSION_${mutation}:" "$LOG" \
    || ! rg -q "^== sessions \(${mutation}\): 9 passed, 1 failed$" "$LOG"; then
    cat "$LOG"
    echo "FAIL session ${mutation}: must fail only ASSERT_SESSION_${mutation}, with all nine other checks passing"
    exit 1
  fi
  echo "FALSIFIED sessions ${mutation}: ASSERT_SESSION_${mutation} failed; 9 other assertions passed"
done
