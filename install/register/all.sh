#!/usr/bin/env bash
# Register the broker, five harnesses, approval app and Chrome native host.
set -uo pipefail
D="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
rc=0
for s in daemon claude-code claude-desktop codex opencode agy app chrome-bridge; do
  echo "== register/$s.sh"
  bash "$D/$s.sh" "$@" || { echo "!! $s.sh failed (exit $?)"; rc=1; }
done
if [[ " $* " != *" --remove "* ]]; then
  printf '\nManual steps remaining:\n'
  printf '  1. Load unpacked extension: chrome://extensions > Developer mode > Load unpacked > %s/extension\n' "$(dirname "$(dirname "$D")")"
  printf '  2. Touch ID on first approval in the Gaddi app.\n'
else
  echo 'Remove the unpacked Gaddi extension in chrome://extensions too.'
fi
exit $rc
