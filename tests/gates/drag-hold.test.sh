#!/usr/bin/env bash
TEST_FILE="${BASH_SOURCE[0]}"
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"
gate_main || exit 1

# DRAG-HOLD falsification: in a disposable copy of the broker, one rule at a time is removed. The named check must go
# red, and only after the checks before it passed.
COPY=$(mktemp -d "$REPO/tests/.state/drag-hold-XXXXXX")
trap 'rm -rf "$COPY"' EXIT # Disposable mutation sources only.
mkdir -p "$COPY/tests/fixtures" "$COPY/tests/.state" "$REPO/tests/.state/logs"
cp -R "$REPO/daemon" "$REPO/mcp" "$REPO/shared" "$REPO/policy" "$REPO/cli" "$COPY/"
cp "$REPO"/tests/fixtures/*.ts "$COPY/tests/fixtures/"
ln -s "$REPO/tests/mcp" "$COPY/tests/mcp"
cp -R "$COPY/daemon" "$COPY/daemon.orig"
mutate() { # <name> <file> <exact text> <replacement> <assertion> <check that must still pass>
  local name=$1 file=$2 marker=$3 replacement=$4 assertion=$5 kept=$6
  rm -rf "$COPY/daemon"; cp -R "$COPY/daemon.orig" "$COPY/daemon"
  if [[ $(grep -cF -- "$marker" "$COPY/daemon/$file") -ne 1 ]]; then echo "FAIL $name mutation point is missing"; exit 1; fi
  node -e 'const fs=require("fs"),[f,m,r]=process.argv.slice(1);fs.writeFileSync(f,fs.readFileSync(f,"utf8").replace(m,r))' \
    "$COPY/daemon/$file" "$marker" "$replacement"
  local log="$REPO/tests/.state/logs/drag-hold-$name-falsified.log"
  if env -u GADDI_POLICY_OFF node "$COPY/tests/fixtures/broker-checks.ts" drag-hold gated >"$log" 2>&1; then
    echo "FAIL removing the $name rule did not fail $assertion"; exit 1
  fi
  if ! grep -q "^FAIL ASSERTION drag-hold: $assertion" "$log" || { [[ -n $kept ]] && ! grep -q "^PASS $kept\$" "$log"; }; then
    cat "$log"; echo "FAIL $name falsification failed for an unrelated reason"; exit 1
  fi
  echo "FALSIFIED $name: removing the rule fails $assertion"
}
mutate drop-judged daemon.ts '        check = strictest(check, dropCheck);' '' ASSERT_DROP_JUDGED a-drag-onto-an-ordinary-area-runs-and-is-audited
mutate drop-bin daemon.ts "dropsInBin(dropped.name) ? HOLD('verb:delete')" "false ? HOLD('verb:delete')" ASSERT_DROP_JUDGED a-drag-onto-an-ordinary-area-runs-and-is-audited
mutate drop-document daemon.ts 'frameOf.id !== startFrame.id || frameOf.document !== startFrame.document ?' 'false ?' \
  ASSERT_DROP_OTHER_DOCUMENT the-drop-target-is-judged-a-bin-is-a-delete
mutate drop-bound daemon.ts '...(transaction ? { transaction } : {}), ...(drop ? { drop } : {}) };' '...(transaction ? { transaction } : {}) };' \
  ASSERT_DROP_BOUND a-drag-into-another-document-asks
mutate hold-bounds daemon.ts 'params.holdMs < 1 || params.holdMs > HOLD_MS_MAX' 'params.holdMs < 0' ASSERT_GESTURE_SHAPE a-hold-is-judged-on-what-it-presses
