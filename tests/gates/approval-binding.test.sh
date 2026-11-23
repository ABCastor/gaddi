#!/usr/bin/env bash
TEST_FILE="${BASH_SOURCE[0]}"
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"
gate_main || exit 1

# TX-BIND and FRAME-BIND falsification: in a disposable copy of the broker, one binding at a time is removed. The named
# check must go red, and a check of another binding must stay green, so the red comes from that mutation alone.
COPY=$(mktemp -d "$REPO/tests/.state/approval-binding-XXXXXX")
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
  local log="$REPO/tests/.state/logs/approval-binding-$name-falsified.log"
  if env -u GADDI_POLICY_OFF node "$COPY/tests/fixtures/broker-checks.ts" approval-binding gated >"$log" 2>&1; then
    echo "FAIL removing the $name binding did not fail $assertion"; exit 1
  fi
  if ! grep -q "^FAIL $assertion: " "$log" || ! grep -q "^PASS $kept\$" "$log" || grep -q '^INFRA ' "$log"; then
    cat "$log"; echo "FAIL $name falsification failed for an unrelated reason"; exit 1
  fi
  echo "FALSIFIED $name: removing the binding fails $assertion"
}
mutate tx-bind daemon.ts 'transaction: keyedTransaction(description.transaction) /* TX_BIND_TEST_POINT */' 'transaction: undefined' \
  ASSERT_TX_BOUND ASSERT_FRAME_BOUND
mutate frame-bind daemon.ts 'const frame = at ? { frame:' 'const frame = false ? { frame:' ASSERT_FRAME_BOUND ASSERT_TX_BOUND
mutate tx-key daemon.ts 'crypto.randomBytes(32) /* TX_KEY_TEST_POINT */' 'Buffer.alloc(32)' ASSERT_TX_RESTART ASSERT_TX_BOUND
mutate tx-held-only daemon.ts "check.outcome === 'allow' && params.approval === undefined) {" 'false) {' ASSERT_TX_PRIVATE ASSERT_TX_BOUND
