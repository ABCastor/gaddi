#!/usr/bin/env bash
# Isolated broker plus fake bridge. No Chrome, live sockets, configs or credentials.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export GADDI_HOME="$REPO/tests/.state-mcp/server-$$"
# Keep the private test socket within macOS path limits regardless of checkout length.
export GADDI_SOCKET="/tmp/gaddi-mcp-$$.sock"
export GADDI_STATE="$GADDI_HOME/state.json"
export GADDI_AUDIT="$GADDI_HOME/audit.jsonl"
export GADDI_APPROVER_PUB="$GADDI_HOME/approver.pub"
export GADDI_POLICY_OFF=0
export GADDI_APP_LAUNCHER=/usr/bin/true
mkdir -p "$GADDI_HOME"
node "$REPO/tests/mcp/map.test.ts"
node "$REPO/tests/mcp/reader.test.ts"
node "$REPO/tests/mcp/metadata.test.ts"
node "$REPO/daemon/daemon.mjs" >"$GADDI_HOME/daemon.log" 2>&1 &
DAEMON_PID=$!
cleanup() {
  kill -TERM "$DAEMON_PID" 2>/dev/null || true
  wait "$DAEMON_PID" 2>/dev/null || true
  if kill -0 "$DAEMON_PID" 2>/dev/null; then echo 'FAIL MCP broker did not stop'; exit 1; fi
  echo 'PASS MCP broker cleanup: process stopped'
}
trap cleanup EXIT
for _ in {1..50}; do
  [[ -S "$GADDI_SOCKET" ]] && break
  if ! kill -0 "$DAEMON_PID" 2>/dev/null; then cat "$GADDI_HOME/daemon.log"; exit 1; fi
  sleep 0.1
done
[[ -S "$GADDI_SOCKET" ]] || { cat "$GADDI_HOME/daemon.log"; exit 1; }
node "$REPO/tests/mcp/client.ts"
echo '== MCP server: all checks passed, 0 failed'
