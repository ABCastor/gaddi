#!/bin/bash
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
export GADDI_CONFIG_ROOT="$REPO/tests/.state/app-build-config-$$"
node "$REPO/tests/app/background.ts"
BUNDLE="$(bash "$REPO/app/build.sh")"
[[ -x "$BUNDLE/Contents/MacOS/Gaddi" ]]
echo 'PASS app build: swiftc produced Gaddi.app'
/usr/bin/plutil -lint "$BUNDLE/Contents/Info.plist"
[[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$BUNDLE/Contents/Info.plist")" == com.abcastor.gaddi ]]
[[ "$(/usr/libexec/PlistBuddy -c 'Print :LSUIElement' "$BUNDLE/Contents/Info.plist")" == true ]]
echo 'PASS app plist: valid bundle identity and menu-bar mode'
DETAILS="$(/usr/bin/codesign -dv --verbose=2 "$BUNDLE" 2>&1)"
printf '%s\n' "$DETAILS"
[[ "$DETAILS" == *'Identifier=com.abcastor.gaddi'* ]]
[[ "$DETAILS" == *'Signature=adhoc'* ]]
/usr/bin/codesign --verify --deep --strict "$BUNDLE"
echo 'PASS app codesign: ad-hoc bundle verified'
LINKS="$(/usr/bin/otool -L "$BUNDLE/Contents/MacOS/Gaddi")"
if [[ "$LINKS" == *WebKit* ]]; then echo 'FAIL app still links a browser viewer'; exit 1; fi
echo 'PASS app scope: executable has no WebKit dependency'
STATUS=0
"$BUNDLE/Contents/MacOS/Gaddi" --approve 'bad|id' >/dev/null 2>&1 || STATUS=$?
[[ "$STATUS" == 2 ]]
echo 'PASS app launch: invalid approval ID fails before UI or key access'
if [[ -f "$REPO/tests/app/.signed" ]]; then
  node "$REPO/tests/app/verify-signature.ts" "$REPO/tests/app/.signed"
else
  echo 'SKIP app signature: tests/app/.signed absent; Touch ID requires a manual run'
fi
bash -n "$REPO/install/register/app.sh"
DRY="$(bash "$REPO/install/register/app.sh" --dry-run)"
[[ "$DRY" == *'Would replace in place (rsync -a --delete):'* && "$DRY" == *'App launches on demand'* ]]
[[ "$DRY" != *'Would bootstrap:'* && "$DRY" != *'<key>KeepAlive</key>'* ]]
REMOVE="$(bash "$REPO/install/register/app.sh" --dry-run --remove)"
[[ "$REMOVE" == *'Would trash:'* ]]
echo 'PASS app installer: install/remove dry runs, in-place replacement and on-demand launch'
echo '== app build: 7 passed, 0 failed (interactive signature reported separately)'
