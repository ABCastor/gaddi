#!/usr/bin/env bash
# Register gaddi in Claude Desktop: mcpServers entry in claude_desktop_config.json (other entries kept).
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"
# The running app owns this file and rewrites it from memory; edits must wait until it quits.
if (( ! DRY )); then
  RUNNING="$("${GADDI_LSAPPINFO:-/usr/bin/lsappinfo}" find bundleID=com.anthropic.claudefordesktop)"
  if [[ -n "$RUNNING" ]]; then
    echo 'claude-desktop.sh: quit Claude Desktop first; it rewrites this config file from memory.' >&2
    exit 1
  fi
fi
edit desktop-json "$ROOT/Library/Application Support/Claude/claude_desktop_config.json" claude-desktop
