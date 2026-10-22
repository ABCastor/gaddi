#!/bin/bash
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
STATE="$REPO/tests/.state/app-visibility-$$"
mkdir -p "$STATE" "$REPO/app/build/module-cache"
node "$REPO/tests/app/background.ts"
if node "$REPO/tests/app/background.ts" AUTO_FOCUS > "$STATE/focus-mutation.log" 2>&1; then
  echo 'FAIL automatic focus mutation passed'; exit 1
fi
grep -Fq 'automatic approval presentation must not take focus' "$STATE/focus-mutation.log"
echo 'FALSIFIED automatic focus: routing automatic presentation through the explicit activating open fails the focus check'
compile() {
  DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer /usr/bin/xcrun swiftc -whole-module-optimization -swift-version 5 \
    -module-cache-path "$REPO/app/build/module-cache" -framework AppKit -framework CryptoKit \
    "$REPO/app/Sources/SocketClient.swift" "$1" "$REPO/app/Sources/ApprovalCard.swift" \
    "$REPO/tests/app/visibility.swift" -o "$2"
}
compile "$REPO/app/Sources/Protocol.swift" "$STATE/visibility"
"$STATE/visibility"
python3 - "$REPO/app/Sources/Protocol.swift" "$STATE/Protocol.swift" <<'PY'
from pathlib import Path
import sys
source = Path(sys.argv[1]).read_text()
old = 'presented = pending\n        return true'
assert source.count(old) == 1
Path(sys.argv[2]).write_text(source.replace(old, 'presented = pending\n        return false'))
PY
compile "$STATE/Protocol.swift" "$STATE/no-presentation"
if "$STATE/no-presentation" > "$STATE/mutation.log" 2>&1; then
  echo 'FAIL invisible approval mutation passed'; exit 1
fi
grep -Fq 'FAIL pending snapshot presents even without notifications or events' "$STATE/mutation.log"
echo 'FALSIFIED invisible approvals: suppressing automatic presentation fails the original notification-independent visibility path'
python3 - "$REPO/app/Sources/Protocol.swift" "$STATE/Protocol-dismiss.swift" <<'PY'
from pathlib import Path
import sys
source = Path(sys.argv[1]).read_text()
old = 'reviewing = false\n        return true'
assert source.count(old) == 1
Path(sys.argv[2]).write_text(source.replace(old, 'reviewing = false\n        return false'))
PY
compile "$STATE/Protocol-dismiss.swift" "$STATE/no-dismissal"
if "$STATE/no-dismissal" > "$STATE/dismissal-mutation.log" 2>&1; then
  echo 'FAIL stale review mutation passed'; exit 1
fi
grep -Fq 'FAIL the last approval closes its finished review' "$STATE/dismissal-mutation.log"
echo 'FALSIFIED stale review: retaining the last resolved approval window fails the queue lifecycle check'
