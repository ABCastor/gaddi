#!/bin/bash
# User-level registration only. Dry runs never build, change files or call launchctl.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
DRY=0
REMOVE=0
for argument in "$@"; do
  case "$argument" in
    --dry-run) DRY=1 ;;
    --remove) REMOVE=1 ;;
    -h|--help) echo 'usage: app.sh [--dry-run] [--remove]'; exit 0 ;;
    *) echo "app.sh: unknown argument: $argument" >&2; exit 2 ;;
  esac
done
ROOT="${GADDI_CONFIG_ROOT:-$HOME}"
TRASH="${GADDI_TRASH:-/usr/bin/trash}"
BUILD="${GADDI_APP_BUILD:-$REPO/app/build.sh}"
CODESIGN="${GADDI_CODESIGN:-/usr/bin/codesign}"
BUNDLE="$ROOT/Applications/Gaddi.app"
if (( DRY )); then
  if (( REMOVE )); then
    printf 'Would trash: %s\n' "$BUNDLE"
  else
    printf 'Would build: %s\nWould replace in place (rsync -a --delete): %s\nApp launches on demand for approval.\n' "$BUILD" "$BUNDLE"
  fi
  exit 0
fi
if (( ! REMOVE )); then
  SOURCE="$(bash "$BUILD")"
  "$CODESIGN" --verify --deep --strict "$SOURCE"
fi
if (( REMOVE )); then
  [[ ! -e "$BUNDLE" ]] || "$TRASH" "$BUNDLE"
  echo 'Removed app registration and moved the installed bundle to the Bin. Approver key and public key retained.'
  exit 0
fi
mkdir -p "$BUNDLE"
# A running copy keeps executing the old binary after the bundle is replaced, so new approval
# kinds never reach the panel (2 Oct 2026). Quit it; the broker relaunches it on demand.
if [[ "$ROOT" == "$HOME" ]]; then /usr/bin/osascript -e 'quit app id "com.abcastor.gaddi"' >/dev/null 2>&1 || true; fi
# Replace in place so the Bin never acquires a duplicate app with the same bundle ID.
/usr/bin/rsync -a --delete "$SOURCE/" "$BUNDLE/"
printf 'Installed: %s\n' "$BUNDLE"
