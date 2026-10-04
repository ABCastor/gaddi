#!/usr/bin/env bash
# Register gaddi in OpenCode: "gaddi" local server in the "mcp" object of opencode.jsonc (textual insert, comments kept).
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"
edit opencode-jsonc "$ROOT/.config/opencode/opencode.jsonc" opencode
