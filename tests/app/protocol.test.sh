#!/bin/bash
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
STATE="$REPO/tests/.state/app-$$"
mkdir -p "$STATE"
export GADDI_SOCKET="${GADDI_TEST_SOCKET_DIR:-/tmp}/gaddi-test-app-$$-0"
export GADDI_FAKE_RECORD="$STATE/calls.jsonl"
export GADDI_HEADLESS_CHECK_SECONDS=3
BUNDLE="$(bash "$REPO/app/build.sh")"
APP="$BUNDLE/Contents/MacOS/Gaddi"
PID=''
SOCKET_N=0
cleanup() { if [[ -n "$PID" ]]; then kill "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true; PID=''; fi; rm -f "${GADDI_TEST_SOCKET_DIR:-/tmp}"/gaddi-test-app-$$-*; }
trap cleanup EXIT
start_fake() {
  SOCKET_N=$((SOCKET_N+1))
  export GADDI_SOCKET="${GADDI_TEST_SOCKET_DIR:-/tmp}/gaddi-test-app-$$-$SOCKET_N"
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
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer /usr/bin/xcrun swiftc -whole-module-optimization -swift-version 5 \
  -module-cache-path "$REPO/app/build/module-cache" -framework CryptoKit \
  "$REPO/app/Sources/SocketClient.swift" "$REPO/app/Sources/Protocol.swift" "$REPO/app/Sources/ApprovalCard.swift" "$REPO/app/Tests/main.swift" \
  -o "$STATE/primitives"
"$STATE/primitives"
# OWNER-NEEDED: each origin and reason check, removed from a disposable copy, lets a malformed notice through.
for pair in 'ORIGIN|url.path.isEmpty, url.query == nil,|true,|a URL path' 'REASON|!reason.contains(where: \.isNewline),|true,|a multi-line reason'; do
  IFS='|' read -r mutation from to label <<<"$pair"
  mkdir -p "$STATE/mutant-$mutation"
  node -e 'const fs=require("fs");const [src,dst,from,to]=process.argv.slice(1);const s=fs.readFileSync(src,"utf8");if(s.split(from).length!==2)throw Error("mutation point "+from);fs.writeFileSync(dst,s.replace(from,to));' \
    "$REPO/app/Sources/Protocol.swift" "$STATE/mutant-$mutation/Protocol.swift" "$from" "$to"
  DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer /usr/bin/xcrun swiftc -whole-module-optimization -swift-version 5 \
    -module-cache-path "$REPO/app/build/module-cache" -framework CryptoKit \
    "$REPO/app/Sources/SocketClient.swift" "$STATE/mutant-$mutation/Protocol.swift" "$REPO/app/Sources/ApprovalCard.swift" "$REPO/app/Tests/main.swift" \
    -o "$STATE/mutant-$mutation/primitives"
  if "$STATE/mutant-$mutation/primitives" > "$STATE/mutant-$mutation.log" 2>&1; then echo "FAIL owner notice $mutation: mutant passed"; exit 1; fi
  grep -Fq "FAIL owner notice with $label is refused" "$STATE/mutant-$mutation.log" || { cat "$STATE/mutant-$mutation.log"; echo "FAIL owner notice $mutation: unrelated failure"; exit 1; }
  echo "FALSIFIED owner notice $mutation: owner notice with $label is accepted"
done
"$APP" --headless-check > "$STATE/normal.log" 2>&1
cat "$STATE/normal.log"
for line in \
  'NOTIFICATION Already pending · Click “click Pay café”' \
  'NOTIFICATION Café task · Click “click Pay café”' \
  'APPROVAL a1 kind=click tab=42 detail=click Pay café reason=checkout action' \
  'GRANTS g1' \
  'ZONES https://sandbox.example.test,https://zone.example.test SANDBOX https://sandbox.example.test' \
  'REMOTE enabled=false candidate=abcd ef01 2345 6789' \
  'REMOTE-APPROVABLE existing' \
  'REMOTE-ANSWERED Approved from phone: Marcus task click “Post” on example.test/shop, ' \
  'EVENT approval.resolved' \
  'NOTICE Chrome had stopped (crash or quit); Gaddi reopened it.' \
  'OWNER-NEEDED Gaddi needs you on https://example.test: finish signing in (security key, passkey or phone) tab=42 step=password' \
  'OWNER-WITHDRAWN own-key' \
  'RESOLVED approval=a1' \
  'RESOLVED approval=existing' \
  'PASS headless-check:'; do
  grep -Fq "$line" "$STATE/normal.log" || { echo "FAIL missing: $line"; exit 1; }
done
# OWNER-NEEDED: a notice with a URL path/query or a multi-line reason never reaches the screen, and one notice is one banner.
if grep -q 'CANARY_NOTICE' "$STATE/normal.log"; then echo 'FAIL malformed owner notice was shown'; exit 1; fi
[[ "$(grep -c '^OWNER-NEEDED ' "$STATE/normal.log")" == 1 ]] || { echo 'FAIL owner notice shown more or less than once'; exit 1; }
node - "$GADDI_FAKE_RECORD" <<'NODE'
const fs = require('node:fs');
const rows = fs.readFileSync(process.argv[2], 'utf8').trim().split('\n').map(JSON.parse);
if (rows.filter(x => x.method === 'events.subscribe').length < 2) throw Error('No reconnect');
for (const method of ['approvals.list', 'signin.remembered', 'sends.remembered', 'uploads.remembered', 'zones.list', 'remote.status', 'owner.notices']) {
  if (rows.filter(x => x.method === method).length < 2) throw Error(`No refresh for ${method}`);
}
if (rows.some(x => !['events.subscribe', 'approvals.list', 'signin.remembered', 'sends.remembered', 'uploads.remembered', 'zones.list', 'remote.status', 'owner.notices'].includes(x.method) && !x.method?.startsWith('test.') && !x.subscriptions)) throw Error('App called an unsupported or mutating method');
NODE
echo 'PASS app events: existing approvals, Unicode/fragmented events, resolution and reconnect recovery'
echo 'PASS app owner notice: shown once from the snapshot, withdrawn with the broker, malformed rows dropped, no owner.show without a click'
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
grep -Fq 'NOTIFICATION Recovered task · Click' "$STATE/snapshot-error.log"
grep -Fq 'PASS headless-check:' "$STATE/snapshot-error.log"
echo 'PASS app snapshot: transient RPC failure recovers without another event'
cleanup
echo '== app protocol: 4 scenarios passed, 0 failed (primitive checks reported above)'
