#!/usr/bin/env bash
# User LaunchAgent registration; --dry-run never invokes launchctl or changes files.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ROOT="${GADDI_CONFIG_ROOT:-$HOME}"
NODE_BIN="${GADDI_NODE:-$(command -v node || true)}"
LAUNCHCTL="${GADDI_LAUNCHCTL:-/bin/launchctl}"
DRY=0; REMOVE=0; EXTENSION_INSTALL=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --remove) REMOVE=1 ;;
    --allow-extension-install) EXTENSION_INSTALL=1 ;;
    -h|--help) echo 'usage: daemon.sh [--dry-run] [--remove] [--allow-extension-install]'; exit 0 ;;
    *) echo "daemon.sh: unknown argument: $arg" >&2; exit 2 ;;
  esac
done
LABEL=com.abcastor.gaddi
DOMAIN="gui/$(id -u)"
PLIST="$ROOT/Library/LaunchAgents/$LABEL.plist"
STATE="${GADDI_HOME:-$ROOT/Library/Application Support/Gaddi}"
APPROVER="${GADDI_APPROVER_PUB:-$ROOT/Library/Application Support/Gaddi/approver.pub}"
LINK="$ROOT/.local/bin/gaddi"
SOURCE="$REPO/cli/gaddi"
command_line() { printf '%q ' "$@"; printf '\n'; }
plist_content() {
  "$NODE_BIN" --input-type=module - "$REPO" "$NODE_BIN" "$STATE" "$APPROVER" "$EXTENSION_INSTALL" <<'NODE'
import fs from 'node:fs';
const [repo, node, state, approver, extensionInstall] = process.argv.slice(2);
const values = { REPO: repo, NODE: node, STATE: state, APPROVER: approver, EXTENSION_INSTALL: extensionInstall };
const xml = s => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
process.stdout.write(fs.readFileSync(`${repo}/install/com.abcastor.gaddi.plist`, 'utf8')
  .replace(/__(REPO|NODE|STATE|APPROVER|EXTENSION_INSTALL)__/g, (_, key) => xml(values[key])));
NODE
}
# Invariant: registration never overwrites or removes another command at ~/.local/bin/gaddi.
if [[ -e "$LINK" || -L "$LINK" ]]; then
  if [[ ! -L "$LINK" || "$(readlink "$LINK")" != "$SOURCE" ]]; then
    echo "daemon.sh: refusing unrelated path: $LINK" >&2; exit 1
  fi
fi
if (( DRY )); then
  if (( REMOVE )); then
    command_line "$LAUNCHCTL" bootout "$DOMAIN/$LABEL"
    command_line /usr/bin/trash "$PLIST" "$LINK"
  else
    [[ -n "$NODE_BIN" && -x "$NODE_BIN" ]] || { echo 'daemon.sh: node not found' >&2; exit 1; }
    printf 'Would write %s\n' "$PLIST"
    plist_content
    command_line "$LAUNCHCTL" bootstrap "$DOMAIN" "$PLIST"
    command_line ln -s "$SOURCE" "$LINK"
  fi
  exit 0
fi
if (( REMOVE )); then
  if "$LAUNCHCTL" print "$DOMAIN/$LABEL" >/dev/null 2>&1; then "$LAUNCHCTL" bootout "$DOMAIN/$LABEL"; fi
  [[ ! -e "$PLIST" ]] || /usr/bin/trash "$PLIST"
  [[ ! -L "$LINK" ]] || /usr/bin/trash "$LINK"
  echo 'Removed broker registration; audit, approvals, screenshots and approver key retained.'
  exit 0
fi
[[ -n "$NODE_BIN" && -x "$NODE_BIN" ]] || { echo 'daemon.sh: node not found' >&2; exit 1; }
[[ -x "$SOURCE" ]] || { echo "daemon.sh: CLI is not executable: $SOURCE" >&2; exit 1; }
"$NODE_BIN" -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)'
mkdir -p "$(dirname "$PLIST")" "$(dirname "$LINK")" "$STATE"
CONTENT="$(plist_content)"
CHANGED=1
if [[ -f "$PLIST" && "$(cat "$PLIST")" == "$CONTENT" ]]; then CHANGED=0; fi
if (( CHANGED )); then
  [[ ! -e "$PLIST" ]] || cp -p "$PLIST" "$PLIST.bak-$(date +%Y%m%dT%H%M%S)-$$"
  printf '%s\n' "$CONTENT" > "$PLIST.tmp-$$"
  /usr/bin/plutil -lint "$PLIST.tmp-$$"
  chmod 644 "$PLIST.tmp-$$"
  mv "$PLIST.tmp-$$" "$PLIST"
fi
[[ -L "$LINK" ]] || ln -s "$SOURCE" "$LINK"
if "$LAUNCHCTL" print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  if (( ! CHANGED )); then echo 'Broker already registered.'; exit 0; fi
  "$LAUNCHCTL" bootout "$DOMAIN/$LABEL"
fi
"$LAUNCHCTL" bootstrap "$DOMAIN" "$PLIST"
printf 'Registered broker and CLI: %s\n' "$LINK"
