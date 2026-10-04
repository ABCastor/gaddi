#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
mkdir -p tests/.state/readme app/build/module-cache
GADDI_DEMO_CAPTURE=1 python3 docs/media/demo.py
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer /usr/bin/xcrun swiftc -swift-version 5 \
  -module-cache-path app/build/module-cache \
  -framework AppKit -framework CryptoKit -framework LocalAuthentication -framework Security -framework UserNotifications \
  app/Sources/SocketClient.swift app/Sources/Protocol.swift app/Sources/SigningKey.swift \
  app/Sources/ApprovalCard.swift app/Sources/AppController.swift docs/media/render-approval.swift \
  -o tests/.state/readme/render
tests/.state/readme/render tests/.state/readme-approval.json app/Fonts docs/media/approval.png
vhs docs/media/demo.tape
