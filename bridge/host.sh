#!/bin/bash
set -eu
BRIDGE_DIR="$(cd "$(dirname "$0")" && pwd)"
# Chrome launched by Finder may have a minimal PATH. No login shell or profile.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"
GADDI_SOCKET="${GADDI_SOCKET:-$HOME/Library/Application Support/Gaddi/gaddi.sock}"
export GADDI_SOCKET
exec node "$BRIDGE_DIR/host.ts" "$@"
