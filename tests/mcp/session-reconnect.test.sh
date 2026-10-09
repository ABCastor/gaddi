#!/usr/bin/env bash
# The MCP adapter reopens its lifetime socket after the broker drops it, so a long chat can still ask for a grant.
set -euo pipefail
cd "$(dirname "$0")/../.."
node tests/mcp/session-reconnect.ts
