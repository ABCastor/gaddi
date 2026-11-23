#!/usr/bin/env bash
TEST_FILE="${BASH_SOURCE[0]}"
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"
gate_main || exit 1

# HELD-WAIT and SAME-ACTION falsification: in a disposable copy of the broker, one rule at a time is removed. The named
# check must go red, and a check of another rule must stay green, so the red comes from that mutation alone.
COPY=$(mktemp -d "$REPO/tests/.state/held-wait-XXXXXX")
trap 'rm -rf "$COPY"' EXIT # Disposable mutation sources only.
mkdir -p "$COPY/tests/fixtures" "$COPY/tests/.state" "$REPO/tests/.state/logs"
cp -R "$REPO/daemon" "$REPO/mcp" "$REPO/shared" "$REPO/policy" "$REPO/cli" "$COPY/"
cp "$REPO"/tests/fixtures/*.ts "$COPY/tests/fixtures/"
ln -s "$REPO/tests/mcp" "$COPY/tests/mcp"
cp -R "$COPY/daemon" "$COPY/daemon.orig"
mutate() { # <name> <file> <exact text> <replacement> <check that must go red> <check that must stay green>
  local name=$1 file=$2 marker=$3 replacement=$4 assertion=$5 kept=$6
  rm -rf "$COPY/daemon"; cp -R "$COPY/daemon.orig" "$COPY/daemon"
  if [[ $(grep -cF -- "$marker" "$COPY/daemon/$file") -ne 1 ]]; then echo "FAIL $name mutation point is missing"; exit 1; fi
  node -e 'const fs=require("fs"),[f,m,r]=process.argv.slice(1);fs.writeFileSync(f,fs.readFileSync(f,"utf8").replace(m,r))' \
    "$COPY/daemon/$file" "$marker" "$replacement"
  local log="$REPO/tests/.state/logs/held-wait-$name-falsified.log"
  if env -u GADDI_POLICY_OFF node "$COPY/tests/fixtures/broker-checks.ts" held-wait gated >"$log" 2>&1; then
    echo "FAIL removing $name did not fail $assertion"; exit 1
  fi
  if ! grep -q "^FAIL $assertion: " "$log" || ! grep -q "^PASS $kept\$" "$log" || grep -q '^INFRA ' "$log"; then
    cat "$log"; echo "FAIL $name falsification failed for an unrelated reason"; exit 1
  fi
  echo "FALSIFIED $name: removing it fails $assertion"
}
mutate held-wait daemon.ts "params.heldWait !== true ||" 'true ||' ASSERT_HELD_WAIT_APPROVED ASSERT_SAME_ACTION_TTL
mutate held-wait-ttl approvals.ts '(deadlines.get(a) ?? Infinity) - performance.now(), Date.parse(String(a.expiresAt)) - Date.now()' 'Infinity' \
  ASSERT_HELD_WAIT_TTL ASSERT_HELD_WAIT_APPROVED
mutate same-action daemon.ts 'const granted = approvals.grantedFor(action, targetRef);' 'const granted = undefined;' ASSERT_SAME_ACTION_SPEND ASSERT_HELD_WAIT_APPROVED
mutate same-action-join approvals.ts ".find(a => a.status === 'pending' && a.actionHash === actionHash(action) && a.targetSelector === targetSelector)" \
  '.find(() => false)' ASSERT_SAME_ACTION_JOIN ASSERT_SAME_ACTION_TTL
mutate same-action-chat daemon.ts 'if (meta.chat) action = { ...action, chat: meta.chat };' '' ASSERT_SAME_ACTION_OTHER_CHAT ASSERT_HELD_WAIT_APPROVED
