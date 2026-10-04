#!/bin/bash
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")" && pwd)"
DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
export DEVELOPER_DIR
BUNDLE="$APP_DIR/build/Gaddi.app"
mkdir -p "$BUNDLE/Contents/MacOS" "$APP_DIR/build/module-cache"
SDK="$(/usr/bin/xcrun --sdk macosx --show-sdk-path)"
ARCH="$(uname -m)"
/usr/bin/xcrun swiftc -swift-version 5 -O -target "$ARCH-apple-macosx26.0" -sdk "$SDK" \
  -module-cache-path "$APP_DIR/build/module-cache" \
  -framework AppKit -framework LocalAuthentication -framework Security \
  -framework UserNotifications -framework CryptoKit \
  "$APP_DIR"/Sources/*.swift -o "$BUNDLE/Contents/MacOS/Gaddi"
cp "$APP_DIR/Info.plist" "$BUNDLE/Contents/Info.plist"
mkdir -p "$BUNDLE/Contents/Resources/Fonts"
cp "$APP_DIR/Gaddi.icns" "$BUNDLE/Contents/Resources/Gaddi.icns"
# The panel's faces travel with the app; their licence ships beside them.
cp "$APP_DIR"/Fonts/*.ttf "$APP_DIR/Fonts/OFL.txt" "$BUNDLE/Contents/Resources/Fonts/"
/usr/bin/codesign -s - --force --deep "$BUNDLE" >&2
printf '%s\n' "$BUNDLE"
