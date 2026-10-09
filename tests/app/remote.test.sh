#!/bin/bash
# The phone-approval checks in app/Tests/main.swift and tests/app/card.swift can fail: each mutation breaks ONE rule
# in a disposable copy of the app sources, and the check that guards that rule must fail BY NAME. A fake daemon
# (never the live socket) keeps the unmodified build green first, so a red can only come from the mutation.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
STATE="$REPO/tests/.state/app-remote-$$"
mkdir -p "$STATE/src" "$STATE/shots" "$REPO/app/build/module-cache"
export GADDI_SOCKET="/tmp/gaddi-test-app-remote-$$"
PID=''
cleanup() { if [[ -n "$PID" ]]; then kill "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true; fi; rm -f "$GADDI_SOCKET"; }
trap cleanup EXIT
GADDI_FAKE_MODE=normal node "$REPO/tests/app/fake-daemon.ts" > "$STATE/server.log" 2>&1 &
PID=$!
for _ in {1..50}; do
  if [[ -S "$GADDI_SOCKET" ]]; then break; fi
  if ! kill -0 "$PID" 2>/dev/null; then cat "$STATE/server.log"; exit 1; fi
  sleep 0.1
done
[[ -S "$GADDI_SOCKET" ]] || { echo 'FAIL fake daemon did not start'; exit 1; }
primitives() {
  DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer /usr/bin/xcrun swiftc -swift-version 5 \
    -module-cache-path "$REPO/app/build/module-cache" -framework CryptoKit \
    "$1/SocketClient.swift" "$1/Protocol.swift" "$1/ApprovalCard.swift" "$REPO/app/Tests/main.swift" -o "$2"
}
card() {
  DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer /usr/bin/xcrun swiftc -swift-version 5 \
    -module-cache-path "$REPO/app/build/module-cache" \
    -framework AppKit -framework CryptoKit -framework LocalAuthentication -framework Security -framework UserNotifications \
    "$1/SocketClient.swift" "$1/Protocol.swift" "$1/SigningKey.swift" "$1/ApprovalCard.swift" "$1/AppController.swift" \
    "$REPO/tests/app/card.swift" -o "$2"
}
primitives "$REPO/app/Sources" "$STATE/pristine"
"$STATE/pristine" > "$STATE/pristine.log" 2>&1 || { cat "$STATE/pristine.log"; echo 'FAIL the unmodified app sources must pass every primitive check first'; exit 1; }
grep -Fq 'PASS Touch ID signs the exact fingerprint and the time' "$STATE/pristine.log"
echo "PASS pristine app primitives: $(grep -c '^PASS ' "$STATE/pristine.log") checks green"
card "$REPO/app/Sources" "$STATE/card-pristine"
"$STATE/card-pristine" "$STATE/shots" "$REPO/app/Fonts" > "$STATE/card-pristine.log" 2>&1 || { cat "$STATE/card-pristine.log"; echo 'FAIL the unmodified card harness must pass first'; exit 1; }
grep -Fq 'PASS a request the phone may answer says so' "$STATE/card-pristine.log"
echo "PASS pristine card harness: $(grep -c '^PASS ' "$STATE/card-pristine.log") checks green"

FALSIFIED=0
for mutation in \
  FINGERPRINT_LENGTH FINGERPRINT_DIGITS SHORT MESSAGE MESSAGE_GUARD STATUS_DROP STATUS_CANDIDATE STATUS_GUARD \
  GRANT_APPROVER GRANT_UNKNOWN GRANT_SUMMARY \
  DECISION_BY DECISION_STATUS DECISION_TIME DECISION_APPROVED LINE LINE_GRANT \
  CARD_LINE LIST_REMOTE PANEL_LIMIT PANEL_ENABLED PANEL_OFF PANEL_ANSWERS PANEL_FROZEN; do
  cp "$REPO"/app/Sources/*.swift "$STATE/src/"
  # The edit is applied by a script on stdin; its answer goes through a file, not a command substitution,
  # because /bin/bash is 3.2 on macOS, which cannot parse a here-document inside $( ).
  node --input-type=module - "$STATE/src" "$mutation" >"$STATE/expect.txt" <<'NODE'
import fs from 'node:fs';
import assert from 'node:assert/strict';
const [root, name] = process.argv.slice(2);
// [which harness, file, text that must occur exactly once, replacement, the check (by name) that must fail first]
const table = {
  FINGERPRINT_LENGTH: ['primitives', 'Protocol.swift', 'value.utf8.count == 64 &&', 'value.utf8.count > 0 &&', 'a malformed fingerprint is never shown or signed'],
  FINGERPRINT_DIGITS: ['primitives', 'Protocol.swift', '(97...102).contains($0)', '(97...122).contains($0)', 'a malformed fingerprint is never shown or signed'],
  SHORT: ['primitives', 'Protocol.swift', 'let digits = Array(value.prefix(16))', 'let digits = Array(value.prefix(8))',
    'the owner compares the first sixteen digits, in groups of four'],
  MESSAGE: ['primitives', 'Protocol.swift', 'return "remote.enable|\\(fingerprint)|\\(timestamp)"', 'return "remote.enable|\\(timestamp)|\\(fingerprint)"',
    'Touch ID signs the exact fingerprint and the time'],
  MESSAGE_GUARD: ['primitives', 'Protocol.swift', 'guard isKeyFingerprint(fingerprint) else { throw AppError("Invalid key fingerprint") }', '',
    'a turn-on message for a malformed fingerprint is refused'],
  STATUS_DROP: ['primitives', 'Protocol.swift', 'fingerprint = (object["fingerprint"] as? String).flatMap { isKeyFingerprint($0) ? $0 : nil }',
    'fingerprint = object["fingerprint"] as? String', 'a damaged fingerprint is dropped, never shown'],
  STATUS_CANDIDATE: ['primitives', 'Protocol.swift', 'candidate = ((object["candidate"] as? JSONObject)?["fingerprint"] as? String).flatMap { isKeyFingerprint($0) ? $0 : nil }',
    'candidate = nil', 'an off status carries only the key that is waiting'],
  STATUS_GUARD: ['primitives', 'Protocol.swift', 'guard let enabled = object["enabled"] as? Bool else { return nil }',
    'let enabled = (object["enabled"] as? Bool) ?? false', 'a status without a plain yes or no is rejected'],
  GRANT_APPROVER: ['primitives', 'Protocol.swift', 'approver = (object["approver"] as? String).flatMap { $0 == "remote" ? $0 : nil }', 'approver = nil',
    'a grant the phone approved says so, and a Touch ID grant does not'],
  GRANT_UNKNOWN: ['primitives', 'Protocol.swift', 'approver = (object["approver"] as? String).flatMap { $0 == "remote" ? $0 : nil }',
    'approver = object["approver"] as? String', 'an approver the app does not know is not shown'],
  GRANT_SUMMARY: ['primitives', 'ApprovalCard.swift', 'if approver == "remote" { lines.append("Approved from your phone") }', '',
    'the panel lists who approved a grant only when it was the phone'],
  DECISION_BY: ['primitives', 'Protocol.swift', 'guard object["by"] as? String == "remote", let status = object["status"] as? String,',
    'guard let status = object["status"] as? String,', 'only an answer the phone really gave is listed (by signed-proof)'],
  DECISION_STATUS: ['primitives', 'Protocol.swift', '["granted", "used", "denied"].contains(status), let approval = Approval(object),',
    'let approval = Approval(object),', 'only an answer the phone really gave is listed (status cancelled)'],
  DECISION_TIME: ['primitives', 'Protocol.swift', 'let at = instant(object["decidedAt"] ?? object["resolvedAt"]) else { return nil }',
    'let at = instant(object["resolvedAt"]) else { return nil }',
    'an answer from the phone decodes, and its time is when it was decided, not when the agent used it'],
  DECISION_APPROVED: ['primitives', 'Protocol.swift', 'self.approved = status != "denied"', 'self.approved = true', 'a denial reads as one'],
  LINE: ['primitives', 'ApprovalCard.swift', 'from phone: \\(approval.caller)', 'by phone: \\(approval.caller)', 'it reads as one line: who, what, where, when'],
  LINE_GRANT: ['primitives', 'ApprovalCard.swift', 'let place = approval.kind == "grant" ? "" : " " + ApprovalWords.place(approval)',
    'let place = " " + ApprovalWords.place(approval)', 'a session grant is listed without its rule list'],
  CARD_LINE: ['card', 'ApprovalCard.swift', 'NSTextField(wrappingLabelWithString: "Can also be approved from your phone.")',
    'NSTextField(wrappingLabelWithString: "")', 'a request the phone may answer says so'],
  LIST_REMOTE: ['card', 'ApprovalCard.swift', 'remote: remote.contains(approval.id)', 'remote: !remote.isEmpty',
    'only the request the broker flagged says it can be answered from the phone'],
  PANEL_LIMIT: ['card', 'ApprovalCard.swift', 'addLine("The limit: a program running as you on this Mac that can read the phone approver\'s key could approve these requests too.")', '',
    'phone-off-light-528: what it allows, what it never does, the honest limit and the key to compare'],
  PANEL_ENABLED: ['card', 'ApprovalCard.swift', 'on.isEnabled = canTurnOn && status.candidate != nil', 'on.isEnabled = canTurnOn',
    'with no key waiting, Turn on… is disabled and says why'],
  PANEL_OFF: ['card', 'ApprovalCard.swift', 'let off = PanelButton("Turn off", kind: .secondary) { turnOff() }', 'let off = PanelButton("Turn off", kind: .secondary) { turnOn() }',
    'phone-on-light-528: Turn off ends it and does nothing else'],
  PANEL_ANSWERS: ['card', 'ApprovalCard.swift', 'for decision in decisions { addLine(decision.line) }', '',
    'phone-off-light-528: what the phone answered is listed'],
  PANEL_FROZEN: ['card', 'ApprovalCard.swift', 'off.isEnabled = canTurnOff', 'off.isEnabled = true', 'a disconnected panel cannot turn it off'],
};
const [harness, file, before, after, expected] = table[name];
const target = `${root}/${file}`, source = fs.readFileSync(target, 'utf8');
assert.equal(source.split(before).length, 2, `${name}: ${file} must contain the mutation target exactly once`);
fs.writeFileSync(target, source.replace(before, () => after));
process.stdout.write(`${harness}\n${expected}`);
NODE
  harness=$(head -n 1 "$STATE/expect.txt")
  expect=$(tail -n +2 "$STATE/expect.txt")
  code=0
  if [[ "$harness" == primitives ]]; then
    primitives "$STATE/src" "$STATE/mutant-$mutation"
    "$STATE/mutant-$mutation" > "$STATE/mutant-$mutation.log" 2>&1 || code=$?
  else
    card "$STATE/src" "$STATE/mutant-$mutation"
    "$STATE/mutant-$mutation" "$STATE/shots" "$REPO/app/Fonts" > "$STATE/mutant-$mutation.log" 2>&1 || code=$?
  fi
  if [[ "$code" -eq 0 ]] || ! grep -Fq "FAIL $expect" "$STATE/mutant-$mutation.log"; then
    cat "$STATE/mutant-$mutation.log"
    echo "FAIL app remote ${mutation}: the check \"$expect\" must fail, and fail first (exit ${code})"
    exit 1
  fi
  FALSIFIED=$((FALSIFIED + 1))
  echo "FALSIFIED app remote ${mutation}: \"$expect\" failed"
done
echo "== app remote falsification: ${FALSIFIED} falsified, 0 survived"
