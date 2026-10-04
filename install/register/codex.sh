#!/usr/bin/env bash
# Register gaddi in Codex CLI: [mcp_servers.gaddi] (+ .env) tables in ~/.codex/config.toml, rest untouched.
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"
edit codex-toml "$ROOT/.codex/config.toml" codex
