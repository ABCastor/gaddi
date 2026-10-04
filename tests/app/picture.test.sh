#!/bin/bash
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
STATE="$REPO/tests/.state/app-picture-$$"
mkdir -p "$STATE" "$REPO/app/build/module-cache"
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer /usr/bin/xcrun swiftc -swift-version 5 \
  -module-cache-path "$REPO/app/build/module-cache" \
  -framework AppKit -framework CryptoKit -framework LocalAuthentication -framework Security -framework UserNotifications \
  "$REPO/app/Sources/SocketClient.swift" "$REPO/app/Sources/Protocol.swift" \
  "$REPO/app/Sources/SigningKey.swift" "$REPO/app/Sources/ApprovalCard.swift" "$REPO/app/Sources/AppController.swift" \
  "$REPO/tests/app/picture.swift" -o "$STATE/picture"
"$STATE/picture" "$STATE"
