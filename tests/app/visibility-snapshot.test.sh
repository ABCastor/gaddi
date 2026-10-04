#!/bin/bash
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
STATE="$REPO/tests/.state/app-visibility-snapshot-$$"
mkdir -p "$STATE" "$REPO/app/build/module-cache"
export GADDI_SOCKET="/tmp/gaddi-test-visibility-$$"
export GADDI_FAKE_RECORD="$STATE/calls.jsonl"
GADDI_FAKE_MODE=quiet-snapshot node "$REPO/tests/app/fake-daemon.ts" > "$STATE/server.log" 2>&1 &
PID=$!
cleanup() { kill "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true; }
trap cleanup EXIT
for _ in {1..50}; do
  [[ ! -S "$GADDI_SOCKET" ]] || break
  if ! kill -0 "$PID" 2>/dev/null; then cat "$STATE/server.log"; exit 1; fi
  sleep 0.1
done
[[ -S "$GADDI_SOCKET" ]]
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer /usr/bin/xcrun swiftc -swift-version 5 \
  -module-cache-path "$REPO/app/build/module-cache" -framework AppKit -framework CryptoKit \
  "$REPO/app/Sources/SocketClient.swift" "$REPO/app/Sources/Protocol.swift" "$REPO/app/Sources/ApprovalCard.swift" \
  "$REPO/tests/app/visibility-snapshot.swift" -o "$STATE/visibility"
"$STATE/visibility"
node --input-type=module - "$GADDI_FAKE_RECORD" <<'NODE'
import assert from 'node:assert/strict';
import fs from 'node:fs';
const rows = fs.readFileSync(process.argv[2], 'utf8').trim().split('\n').map(JSON.parse);
assert(rows.every(row => row.subscriptions || ['events.subscribe', 'approvals.list', 'signin.remembered', 'sends.remembered'].includes(row.method)));
console.log('PASS snapshot visibility uses only read-only RPC, with no authentication or grant');
NODE
