#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/../.."
result=0
export GADDI_BRIDGE_BREAK_WAIT=0 GADDI_BRIDGE_BREAK_VISIBLE=0
export GADDI_BRIDGE_BREAK_CAPTURE_SCROLL=0 GADDI_BRIDGE_BREAK_CAPTURE_BOX=0
export GADDI_BRIDGE_BREAK_SCREENSHOT=0
export GADDI_BRIDGE_BREAK_TYPE_REPLACEMENT=0 GADDI_BRIDGE_BREAK_INPUT_FOCUS=0
export GADDI_BRIDGE_BREAK_OUTLINE_STATE=0 GADDI_BRIDGE_BREAK_CHANGED=0 GADDI_BRIDGE_BREAK_CHECKED_DESCRIPTION=0
export GADDI_BRIDGE_BREAK_PRE_SCROLL_SIGNATURE=0
export GADDI_BRIDGE_BREAK_FOREIGN_REMOVE=0 GADDI_BRIDGE_BREAK_FOREIGN_SHADOW=0 GADDI_BRIDGE_BREAK_HSCROLL=0
GADDI_BRIDGE_BREAK_NAMES=0 GADDI_BRIDGE_BREAK_EXPLICIT_CLOSE=0 node tests/bridge/extension.ts || result=$?
if [[ "$result" != 0 ]]; then exit "$result"; fi
mkdir -p tests/.state/logs
LOG=tests/.state/logs/bridge-extension-falsified.log
if GADDI_BRIDGE_BREAK_NAMES=1 node tests/bridge/extension.ts >"$LOG" 2>&1; then
  echo 'FAIL broken name resolution did not fail the describe assertion'
  exit 1
fi
if ! rg -q 'ASSERT_DESCRIBE_NAME' "$LOG"; then
  cat "$LOG"
  echo 'FAIL falsification failed for an unrelated reason'
  exit 1
fi
echo 'FALSIFIED bridge extension: broken name resolution fails chrome.describe'

LOG=tests/.state/logs/bridge-explicit-close-falsified.log
if GADDI_BRIDGE_BREAK_NAMES=0 GADDI_BRIDGE_BREAK_EXPLICIT_CLOSE=1 node tests/bridge/extension.ts >"$LOG" 2>&1; then
  echo 'FAIL active-tab fallback did not fail the explicit close assertion'
  exit 1
fi
if ! rg -q 'AssertionError.*ASSERT_EXPLICIT_CLOSE_TABS' "$LOG"; then
  cat "$LOG"
  echo 'FAIL explicit close falsification failed for an unrelated reason'
  exit 1
fi
echo 'FALSIFIED bridge explicit close: active-tab fallback fails required tabs assertion'

LOG=tests/.state/logs/bridge-screenshot-falsified.log
if GADDI_BRIDGE_BREAK_NAMES=0 GADDI_BRIDGE_BREAK_EXPLICIT_CLOSE=0 GADDI_BRIDGE_BREAK_SCREENSHOT=1 node tests/bridge/extension.ts >"$LOG" 2>&1; then
  echo 'FAIL forcing viewport clip y to zero did not fail the scrolled centre-pixel assertion'
  exit 1
fi
if ! rg -q 'AssertionError.*ASSERT_SCROLLED_VIEWPORT_CENTER' "$LOG"; then
  cat "$LOG"
  echo 'FAIL screenshot falsification failed for an unrelated reason'
  exit 1
fi
echo 'FALSIFIED bridge screenshot: viewport clip y=0 fails scrolled centre pixel'

LOG=tests/.state/logs/bridge-type-replacement-falsified.log
if GADDI_BRIDGE_BREAK_TYPE_REPLACEMENT=1 node tests/bridge/extension.ts >"$LOG" 2>&1; then
  echo 'FAIL removing selection did not fail the replacement assertion'
  exit 1
fi
if ! rg -q 'AssertionError.*ASSERT_TYPE_REPLACES' "$LOG"; then
  cat "$LOG"
  echo 'FAIL replacement falsification failed for an unrelated reason'
  exit 1
fi
echo 'FALSIFIED bridge type: removing selection fails prefilled replacement assertion'

LOG=tests/.state/logs/bridge-input-focus-falsified.log
if GADDI_BRIDGE_BREAK_INPUT_FOCUS=1 node tests/bridge/extension.ts >"$LOG" 2>&1; then
  echo 'FAIL removing input focus emulation did not fail native background input'
  exit 1
fi
if ! rg -q 'AssertionError.*ASSERT_NATIVE_INPUT_CLICK' "$LOG"; then
  cat "$LOG"
  echo 'FAIL input focus falsification failed for an unrelated reason'
  exit 1
fi
echo 'FALSIFIED bridge input: removing focus emulation fails native background trusted click'

for mutation in OUTLINE_STATE CHANGED CHECKED_DESCRIPTION PRE_SCROLL_SIGNATURE; do
  case "$mutation" in
    OUTLINE_STATE) assertion=ASSERT_OUTLINE_STATE; label='removing state output fails control-state assertions' ;;
    CHANGED) assertion=ASSERT_ACTION_CHANGED; label='forcing changed=false fails observed scroll outcome' ;;
    CHECKED_DESCRIPTION) assertion=ASSERT_CHECKED_DESCRIPTION_CLICK; label='removing gate recheck delivers a forbidden renamed click' ;;
    PRE_SCROLL_SIGNATURE) assertion=ASSERT_LARGE_CHANGED_NOOP; label='restoring pre-scroll signature falsely reports a large-page no-op click as changed' ;;
  esac
  LOG="tests/.state/logs/bridge-page-state-${mutation}.log"
  if env "GADDI_BRIDGE_BREAK_${mutation}=1" node tests/bridge/extension.ts >"$LOG" 2>&1; then
    echo "FAIL page state ${mutation} mutation did not fail its assertion"
    exit 1
  fi
  if ! rg -q "AssertionError.*${assertion}" "$LOG"; then
    cat "$LOG"
    echo "FAIL page state ${mutation} falsification failed for an unrelated reason"
    exit 1
  fi
  echo "FALSIFIED bridge page state: $label"
done

# Run a headful mutation in a disposable copy. The launch guard must stop it
# before Chromium can create a window on the user's desktop.
COPY="$(mktemp -d tests/.state-headful-XXXXXX)"
trap 'rm -rf "$COPY"' EXIT # Disposable test sources only.
mkdir -p "$COPY/tests/bridge" "$COPY/tests/fixtures"
cp tests/bridge/*.ts "$COPY/tests/bridge/"
cp tests/fixtures/wire.ts "$COPY/tests/fixtures/"
cp -R extension "$COPY/extension"
ln -s "$PWD/bridge" "$COPY/bridge"
ln -s "$PWD/shared" "$COPY/shared"
node --input-type=module - "$COPY/tests/bridge/extension.ts" <<'NODE'
import fs from 'node:fs';
import assert from 'node:assert/strict';
const file = process.argv[2];
const source = fs.readFileSync(file, 'utf8');
assert.ok(source.includes('headless: true'));
fs.writeFileSync(file, source.replace('headless: true', 'headless: false').replace("'--headless=new', ", ''));
NODE
LOG=tests/.state/logs/bridge-background-falsified.log
if node "$COPY/tests/bridge/extension.ts" >"$LOG" 2>&1; then
  echo 'FAIL headful Chrome mutation bypassed the background guard'
  exit 1
fi
if ! rg -q 'AssertionError.*ASSERT_BACKGROUND_BROWSER: refusing Chrome without new headless mode' "$LOG"; then
  cat "$LOG"
  echo 'FAIL background falsification failed for an unrelated reason'
  exit 1
fi
echo 'FALSIFIED bridge background: disposable headful launch rejected before opening a window'

for mutation in SCROLL BOX; do
  case "$mutation" in
    SCROLL) assertion=ASSERT_CAPTURE_NO_SCROLL ;;
    BOX) assertion=ASSERT_CAPTURE_BOX ;;
  esac
  LOG="tests/.state/logs/bridge-capture-${mutation}-falsified.log"
  if env "GADDI_BRIDGE_BREAK_CAPTURE_${mutation}=1" node tests/bridge/extension.ts >"$LOG" 2>&1; then
    echo "FAIL capture ${mutation} mutation did not fail its assertion"
    exit 1
  fi
  if ! rg -q "AssertionError.*${assertion}" "$LOG"; then
    cat "$LOG"
    echo "FAIL capture ${mutation} falsification failed for an unrelated reason"
    exit 1
  fi
  echo "FALSIFIED approval capture: ${mutation} fails ${assertion}"
done

for mutation in REMOVE SHADOW; do
  case "$mutation" in
    REMOVE) assertion=ASSERT_FOREIGN_REMOVE; label='leaving the frame in place keeps Chrome refusing the debugger' ;;
    SHADOW) assertion=ASSERT_FOREIGN_REMOVE; label='not looking inside closed shadow roots misses the frame a password manager hides there' ;;
  esac
  LOG="tests/.state/logs/bridge-foreign-${mutation}-falsified.log"
  if env "GADDI_BRIDGE_BREAK_FOREIGN_${mutation}=1" node tests/bridge/extension.ts >"$LOG" 2>&1; then
    echo "FAIL foreign-frame ${mutation} mutation did not fail its assertion"
    exit 1
  fi
  if ! rg -q "AssertionError.*${assertion}" "$LOG"; then
    cat "$LOG"
    echo "FAIL foreign-frame ${mutation} falsification failed for an unrelated reason"
    exit 1
  fi
  echo "FALSIFIED foreign frame: $label"
done

LOG=tests/.state/logs/bridge-wait-falsified.log
if GADDI_BRIDGE_BREAK_WAIT=1 node tests/bridge/extension.ts >"$LOG" 2>&1; then
  echo 'FAIL wait mutation passed'; exit 1
fi
if ! rg -q 'AssertionError.*ASSERT_WAIT_TIMER' "$LOG"; then cat "$LOG"; exit 1; fi
echo 'FALSIFIED wait: forced false fails ASSERT_WAIT_TIMER'

LOG=tests/.state/logs/bridge-visible-falsified.log
if GADDI_BRIDGE_BREAK_VISIBLE=1 node tests/bridge/extension.ts >"$LOG" 2>&1; then
  echo 'FAIL visible mutation passed'; exit 1
fi
if ! rg -q 'AssertionError.*ASSERT_VISIBLE_OUTLINE' "$LOG"; then cat "$LOG"; exit 1; fi
echo 'FALSIFIED visible look: disabled viewport filter fails ASSERT_VISIBLE_OUTLINE'

LOG=tests/.state/logs/bridge-hscroll-falsified.log
if GADDI_BRIDGE_BREAK_HSCROLL=1 node tests/bridge/extension.ts >"$LOG" 2>&1; then
  echo 'FAIL horizontal scroll mutation passed'; exit 1
fi
if ! rg -q 'AssertionError.*ASSERT_HSCROLL_PAGE' "$LOG"; then cat "$LOG"; echo 'FAIL horizontal scroll falsification failed for an unrelated reason'; exit 1; fi
echo 'FALSIFIED horizontal scroll: a wheel that sends deltaX 0 fails ASSERT_HSCROLL_PAGE'
echo 'PASS bridge extension suite: baseline and all mutation checks passed'
