#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
node tests/bridge/windows.ts
mkdir -p tests/.state/logs
for mutation in OWN ATTENTION SHARED RESTORE ADOPT RELOAD RECYCLED RECREATE BLANK RENDER CLEANUP OWNER PAINT BROKER_STOP LIST PERSIST CLOSE_PLACEHOLDER OWNER_BOUNDS MINIMIZED REPAIR CLEANUP_SCOPE CLEANUP_SHOWN SHOW_INTERRUPTED CLEANUP_FOCUS CLEANUP_AGENT CLEANUP_PLACEHOLDER OWNER_UNGROUP AGENT_REGROUP CLEANUP_GROUPED CLEANUP_NO_TARGET CLEANUP_RESTART CLEANUP_RECHECK RELOAD_DISCARDED RELOAD_READY EXTERNAL_LINK EXTERNAL_FOCUS AGENT_CREATED AGENT_POPUP NO_OWNER SHARED_LINK SHARED_RESTART OWNER_FOCUS OWNER_IGNORE OWNER_RESTART PLACEHOLDER_LINK CREATION_RACE CREATION_FOCUS; do
  log="tests/.state/logs/window-${mutation}-falsified.log"
  if node tests/bridge/windows.ts "$mutation" >"$log" 2>&1; then
    echo "FAIL window $mutation: mutant passed"; exit 1
  fi
  if ! rg -q "^FAIL ASSERT_WINDOW_${mutation}:" "$log"; then
    cat "$log"; echo "FAIL window $mutation: unrelated failure"; exit 1
  fi
  echo "FALSIFIED window $mutation: ASSERT_WINDOW_${mutation} failed"
done
