#!/usr/bin/env bash
# Antigravity owns its config. Use its CLI, never edit its settings file.
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"
AGY="${GADDI_AGY:-agy}"
if (( REMOVE )); then
  CMD=("$AGY" mcp remove gaddi)
else
  CMD=("$AGY" mcp add --type stdio --env GADDI_HARNESS=agy)
  [[ -n "$OMNIREAD_BIN" ]] && CMD+=(--env "OMNIREAD_BIN=$OMNIREAD_BIN")
  CMD+=(gaddi "$NODE_BIN" "$SERVER")
fi
if (( DRY )); then
  printf '%q ' "${CMD[@]}"; printf '\n'
  printf '%q ' "$AGY" mcp list; printf '\n'
  exit 0
fi
"${CMD[@]}"
"$AGY" mcp list
