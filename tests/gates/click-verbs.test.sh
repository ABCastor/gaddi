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
