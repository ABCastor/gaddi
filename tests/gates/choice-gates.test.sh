#!/usr/bin/env bash
TEST_FILE="${BASH_SOURCE[0]}"
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"
gate_main || exit 1

# SELECT-CHOICE, COMMIT-CHOICES and KEY-CHOICE falsification: in a disposable copy of the broker, one gate at a time is
# removed. The named check must go red, and only after the checks before it passed.
COPY=$(mktemp -d "$REPO/tests/.state/choice-gates-XXXXXX")
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
  local log="$REPO/tests/.state/logs/choice-gates-$name-falsified.log"
  if env -u GADDI_POLICY_OFF node "$COPY/tests/fixtures/broker-checks.ts" choice-gates gated >"$log" 2>&1; then
    echo "FAIL removing the $name gate did not fail $assertion"; exit 1
  fi
  if ! grep -q "^FAIL ASSERTION choice-gates: $assertion" "$log" || { [[ -n $kept ]] && ! grep -q "^PASS $kept\$" "$log"; }; then
    cat "$log"; echo "FAIL $name falsification failed for an unrelated reason"; exit 1
  fi
  echo "FALSIFIED $name: removing the gate fails $assertion"
}
mutate select daemon.ts '    check = judged.check;' '    check = { outcome: "allow" };' ASSERT_SELECT_OPTION_HELD ''
mutate commit daemon.ts '      check = strictest(check, commit.check);' '' ASSERT_COMMIT_CHOICE_HELD a-select-approval-covers-the-option-it-showed
mutate commit-bare policy.ts "verbs.filter(verb => !NAMING_VERBS.includes(fold(verb))), true)" "verbs.filter(verb => !NAMING_VERBS.includes(fold(verb))), false)" \
  ASSERT_COMMIT_CHOICE_HELD a-select-approval-covers-the-option-it-showed
mutate enter-commit daemon.ts 'judgeNames(enter ? enterCommits : space ? spaceCommits : [], { commit: true }, scopeURL)' 'judgeNames([], { commit: true }, scopeURL)' \
  ASSERT_ENTER_COMMIT_HELD ordinary-choices-leave-the-commit-alone-and-are-bound
mutate key daemon.ts 'judgeNames(keyChoices, { choice: true }, scopeURL)' 'judgeNames([], { choice: true }, scopeURL)' \
  ASSERT_KEY_CHOICE_HELD enter-that-sends-a-chosen-instruction-is-held
mutate space daemon.ts "const submitName = enter ? info.submitName : space ? info.spaceName : '';" "const submitName = enter ? info.submitName : '';" \
  ASSERT_SPACE_PRESS_HELD a-key-that-could-pick-an-order-is-held-ordinary-lists-are-not
