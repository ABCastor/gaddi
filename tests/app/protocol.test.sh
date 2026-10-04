#!/bin/bash
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
STATE="$REPO/tests/.state/app-$$"
mkdir -p "$STATE"
export GADDI_SOCKET="/tmp/gaddi-test-app-$$-0"
export GADDI_FAKE_RECORD="$STATE/calls.jsonl"
export GADDI_HEADLESS_CHECK_SECONDS=3
BUNDLE="$(bash "$REPO/app/build.sh")"
APP="$BUNDLE/Contents/MacOS/Gaddi"
PID=''
SOCKET_N=0
cleanup() { if [[ -n "$PID" ]]; then kill "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true; PID=''; fi; rm -f /tmp/gaddi-test-app-$$-*; }
trap cleanup EXIT
start_fake() {
  SOCKET_N=$((SOCKET_N+1))
  export GADDI_SOCKET="/tmp/gaddi-test-app-$$-$SOCKET_N"
  GADDI_FAKE_MODE="$1" node "$REPO/tests/app/fake-daemon.ts" > "$STATE/$1.server.log" 2>&1 &
  PID=$!
  for _ in {1..50}; do
    if [[ -S "$GADDI_SOCKET" ]]; then return; fi
    if ! kill -0 "$PID" 2>/dev/null; then cat "$STATE/$1.server.log"; exit 1; fi
    sleep 0.1
  done
  echo 'FAIL fake daemon did not start'; exit 1
}
start_fake normal
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer /usr/bin/xcrun swiftc -swift-version 5 \
  -module-cache-path "$REPO/app/build/module-cache" -framework CryptoKit \
  "$REPO/app/Sources/SocketClient.swift" "$REPO/app/Sources/Protocol.swift" "$REPO/app/Sources/ApprovalCard.swift" "$REPO/app/Tests/main.swift" \
  -o "$STATE/primitives"
"$STATE/primitives"
"$APP" --headless-check > "$STATE/normal.log" 2>&1
cat "$STATE/normal.log"
for line in \
  'NOTIFICATION Already pending wants to click “click Pay café”' \
  'NOTIFICATION Café task wants to click “click Pay café”' \
  'APPROVAL a1 kind=click tab=42 detail=click Pay café reason=checkout action' \
  'EVENT approval.resolved' \
  'RESOLVED approval=a1' \
  'RESOLVED approval=existing' \
  'PASS headless-check:'; do
  grep -Fq "$line" "$STATE/normal.log" || { echo "FAIL missing: $line"; exit 1; }
done
node - "$GADDI_FAKE_RECORD" <<'NODE'
const fs = require('node:fs');
const rows = fs.readFileSync(process.argv[2], 'utf8').trim().split('\n').map(JSON.parse);
if (rows.filter(x => x.method === 'events.subscribe').length < 2) throw Error('No reconnect');
for (const method of ['approvals.list', 'signin.remembered', 'sends.remembered']) {
  if (rows.filter(x => x.method === method).length < 2) throw Error(`No refresh for ${method}`);
}
if (rows.some(x => !['events.subscribe', 'approvals.list', 'signin.remembered', 'sends.remembered'].includes(x.method) && !x.method?.startsWith('test.') && !x.subscriptions)) throw Error('App called an unsupported or mutating method');
NODE
echo 'PASS app events: existing approvals, Unicode/fragmented events, resolution and reconnect recovery'
cleanup
start_fake malformed
"$APP" --headless-check > "$STATE/malformed.log" 2>&1
grep -Fq 'RECONNECT ' "$STATE/malformed.log"
grep -Fq 'PASS headless-check:' "$STATE/malformed.log"
echo 'PASS app stream: malformed JSON reconnects and recovers'
cleanup
start_fake refuse
if GADDI_HEADLESS_CHECK_SECONDS=1 "$APP" --headless-check > "$STATE/refuse.log" 2>&1; then
  echo 'FAIL rejected subscription reported success'; exit 1
fi
grep -Fq 'FAIL headless-check:' "$STATE/refuse.log"
echo 'PASS app failure: refused subscription exits nonzero'
cleanup
start_fake snapshot-error
GADDI_HEADLESS_CHECK_SECONDS=6 "$APP" --headless-check > "$STATE/snapshot-error.log" 2>&1
grep -Fq 'RECONNECT transient snapshot failure' "$STATE/snapshot-error.log"
grep -Fq 'NOTIFICATION Recovered task wants to' "$STATE/snapshot-error.log"
grep -Fq 'PASS headless-check:' "$STATE/snapshot-error.log"
echo 'PASS app snapshot: transient RPC failure recovers without another event'
cleanup
echo '== app protocol: 4 scenarios passed, 0 failed (primitive checks reported above)'
