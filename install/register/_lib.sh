# install/register/_lib.sh — shared by the register scripts (sourced, not run).
# Flags: --dry-run (print the exact change, touch nothing), --remove (take our entry out).
# GADDI_CONFIG_ROOT: root under which the harness config files live (default $HOME); tests point it at copies.
# GADDI_NODE: node binary to register (default: the node on PATH).
# OMNIREAD_BIN: extractor path (default: omniread on the registration shell's PATH).
set -euo pipefail
REG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$REG_DIR/../.." && pwd)"
ROOT="${GADDI_CONFIG_ROOT:-$HOME}"
NODE_BIN="${GADDI_NODE:-$(command -v node || true)}"
[[ -n "$NODE_BIN" && -x "$NODE_BIN" ]] || { echo "register: node not found (set GADDI_NODE)" >&2; exit 1; }
OMNIREAD_BIN="${OMNIREAD_BIN-$(command -v omniread || true)}"
if [[ -n "$OMNIREAD_BIN" ]]; then
  OMNIREAD_BIN="$("$NODE_BIN" --input-type=module -e 'import path from "node:path"; process.stdout.write(path.resolve(process.argv[1]));' -- "$OMNIREAD_BIN")"
fi
SERVER="$REPO/mcp/server.mjs"
DRY=0; REMOVE=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --remove) REMOVE=1 ;;
    -h|--help) echo "usage: $(basename "$0") [--dry-run] [--remove]   (env: GADDI_CONFIG_ROOT, GADDI_NODE, OMNIREAD_BIN)"; exit 0 ;;
    *) echo "register: unknown argument $a" >&2; exit 2 ;;
  esac
done
FLAGS=()
(( DRY )) && FLAGS+=(--dry-run)
(( REMOVE )) && FLAGS+=(--remove)
TOOLS="$("$NODE_BIN" "$SERVER" --list-tools | paste -sd, -)"
# edit <kind> <file> <harness>
edit() {
  echo "== $(basename "$0") ($3): $2"
  "$NODE_BIN" "$REG_DIR/edit.ts" "$1" "$2" --node "$NODE_BIN" --server "$SERVER" --harness "$3" --tools "$TOOLS" --omniread "$OMNIREAD_BIN" ${FLAGS[@]+"${FLAGS[@]}"}
}
