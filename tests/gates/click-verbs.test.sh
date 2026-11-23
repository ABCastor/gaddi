#!/usr/bin/env bash
TEST_FILE="${BASH_SOURCE[0]}"
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"
gate_main || exit 1

# CHOICE-PROSE falsification: in a disposable copy of the broker, a choice whose name starts with a hold verb is held
# again whatever follows the verb ("Pay Monthly Mobile"). The named check must go red, and only for that reason.
COPY=$(mktemp -d "$REPO/tests/.state/click-verbs-XXXXXX")
trap 'rm -rf "$COPY"' EXIT # Disposable mutation sources only.
mkdir -p "$COPY/tests/fixtures" "$COPY/tests/.state" "$REPO/tests/.state/logs"
cp -R "$REPO/daemon" "$REPO/mcp" "$REPO/shared" "$REPO/policy" "$REPO/cli" "$COPY/"
cp "$REPO"/tests/fixtures/*.ts "$COPY/tests/fixtures/"
ln -s "$REPO/tests/mcp" "$COPY/tests/mcp"
marker='    if (!bare && rest && !ORDER_OBJECT.test(rest)) continue;'
if [[ $(grep -cF "$marker" "$COPY/daemon/policy.ts") -ne 1 ]]; then echo 'FAIL choice mutation point is missing'; exit 1; fi
node -e 'const fs=require("fs"),[f,m]=process.argv.slice(1);fs.writeFileSync(f,fs.readFileSync(f,"utf8").replace(m,""))' "$COPY/daemon/policy.ts" "$marker"
LOG="$REPO/tests/.state/logs/click-verbs-choice-falsified.log"
if env -u GADDI_POLICY_OFF node "$COPY/tests/fixtures/broker-checks.ts" click-verbs gated >"$LOG" 2>&1; then
  echo 'FAIL holding every choice that starts with a hold verb did not fail the choice check'; exit 1
fi
if ! grep -q '^FAIL ASSERTION click-verbs: ASSERT_CHOICE_NAME_NOT_ORDER' "$LOG" || ! grep -q 'PASS a-choice-named-as-an-action-is-still-held' "$LOG"; then
  cat "$LOG"; echo 'FAIL choice falsification failed for an unrelated reason'; exit 1
fi
echo 'FALSIFIED choice names: holding "Pay Monthly Mobile" again fails ASSERT_CHOICE_NAME_NOT_ORDER'

# CONTAINER-VERB falsification: a panel's text is judged as one control's name again (the readwise left panel held as
# "remove"), or the count of controls inside is ignored (a long-named Remove button let through). Each named check must
# go red, and only for that reason.
container() { # <name> <exact text> <replacement> <check that must go red>
  local name=$1 marker=$2 replacement=$3 assertion=$4
  cp "$REPO/daemon/policy.ts" "$COPY/daemon/policy.ts"
  if [[ $(grep -cF -- "$marker" "$COPY/daemon/policy.ts") -ne 1 ]]; then echo "FAIL $name mutation point is missing"; exit 1; fi
  node -e 'const fs=require("fs"),[f,m,r]=process.argv.slice(1);fs.writeFileSync(f,fs.readFileSync(f,"utf8").replace(m,r))' "$COPY/daemon/policy.ts" "$marker" "$replacement"
  local log="$REPO/tests/.state/logs/click-verbs-$name-falsified.log"
  if env -u GADDI_POLICY_OFF node "$COPY/tests/fixtures/broker-checks.ts" click-verbs gated >"$log" 2>&1; then
    echo "FAIL $name did not fail $assertion"; exit 1
  fi
  if ! grep -q "^FAIL ASSERTION click-verbs: $assertion" "$log" || ! grep -q '^PASS a-choice-named-with-a-leading-verb-is-chosen' "$log" || grep -q '^INFRA ' "$log"; then
    cat "$log"; echo "FAIL $name falsification failed for an unrelated reason"; exit 1
  fi
  echo "FALSIFIED $name: it fails $assertion"
}
container container-verb 'control.container && !control.commit && !control.choice ? containerVerb' 'false ? containerVerb' ASSERT_CONTAINER_NOT_VERB
container container-count 'controls >= 2 && fold(name)' 'fold(name)' ASSERT_CONTAINER_BUTTON_HELD
