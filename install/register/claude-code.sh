#!/usr/bin/env bash
# Register gaddi in Claude Code: user-scope MCP server in ~/.claude.json + allow rules in ~/.claude/settings.json.
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"
edit claude-json "$ROOT/.claude.json" claude-code
edit claude-settings "$ROOT/.claude/settings.json" claude-code
