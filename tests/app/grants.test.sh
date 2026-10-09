#!/bin/bash
# The session-grant checks in app/Tests/main.swift can fail: each mutation breaks ONE rule in a disposable
# copy of the app sources, and the check that guards that rule must fail BY NAME. A fake daemon (never the
# live socket) keeps the unmodified build green first, so a red can only come from the mutation.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
STATE="$REPO/tests/.state/app-grants-$$"
mkdir -p "$STATE/src" "$REPO/app/build/module-cache"
export GADDI_SOCKET="/tmp/gaddi-test-app-grants-$$"
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
compile() {
  DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer /usr/bin/xcrun swiftc -swift-version 5 \
    -module-cache-path "$REPO/app/build/module-cache" -framework CryptoKit \
    "$1/SocketClient.swift" "$1/Protocol.swift" "$1/ApprovalCard.swift" "$REPO/app/Tests/main.swift" -o "$2"
}
compile "$REPO/app/Sources" "$STATE/pristine"
"$STATE/pristine" > "$STATE/pristine.log" 2>&1 || { cat "$STATE/pristine.log"; echo 'FAIL the unmodified app sources must pass every primitive check first'; exit 1; }
grep -Fq 'PASS a session grant never offers Always allow' "$STATE/pristine.log"
echo "PASS pristine app primitives: $(grep -c '^PASS ' "$STATE/pristine.log") checks green"

FALSIFIED=0
for mutation in REASON EMPTY_RULES TITLE REMEMBER RULE_TEXT DURATION LABEL DECODE UNLABELED EXPIRED BANNER PLAIN TUPLE SIGN_REMEMBER; do
  cp "$REPO"/app/Sources/*.swift "$STATE/src/"
  # The edit is applied by a script on stdin; its answer goes through a file, not a command substitution,
  # because /bin/bash is 3.2 on macOS, which cannot parse a here-document inside $( ).
  node --input-type=module - "$STATE/src" "$mutation" >"$STATE/expect.txt" <<'NODE'
import fs from 'node:fs';
import assert from 'node:assert/strict';
const [root, name] = process.argv.slice(2);
// [file, text that must occur exactly once, replacement, the check (by name) that must fail first]
const table = {
  REASON: ['ApprovalCard.swift',
    'if reason == "session grant" { return "Payments, purchases, sending messages, sign-in and security changes still ask you every time." }',
    'if reason == "session grant" { return "Held because this action needs your approval." }',
    'the card says what still asks every time'],
  EMPTY_RULES: ['Protocol.swift', 'let rules = object["rules"] as? [String], !rules.isEmpty,', 'let rules = object["rules"] as? [String],',
    'a malformed session grant is rejected, never half-shown'],
  TITLE: ['ApprovalCard.swift', 'case "grant": return ("work without asking you", ', 'case "grant": return ("click", ',
    'a session grant is worded as working unattended for a time'],
  REMEMBER: ['Protocol.swift', 'var canRemember: Bool { kind == "signin" && site != nil || sendPermission != nil }', 'var canRemember: Bool { true }',
    'a session grant never offers Always allow'],
  RULE_TEXT: ['ApprovalCard.swift', 'return "\\(parts[0]) on \\(scheme)\\(host)\\(port)\\(url.path == "/" ? "" : url.path)"',
    'return "\\(parts[0]) at \\(scheme)\\(host)\\(port)\\(url.path == "/" ? "" : url.path)"', 'canonical rules read as the card lists them'],
  DURATION: ['ApprovalCard.swift', 'duration = String(line.dropFirst(4))', 'duration = String(line.dropFirst(5))',
    'a session grant is worded as working unattended for a time'],
  LABEL: ['ApprovalCard.swift', 'label = line.trimmingCharacters(in: CharacterSet(charactersIn: "“”"))', 'label = line',
    "the card lists every rule, then the agent's own words"],
  // The test stops at its first failure, so each mutation below is placed to break its check before any later one.
  DECODE: ['Protocol.swift', 'self.id = id; self.rules = rules; self.expiresAt = expiresAt',
    'self.id = id; self.rules = Array(rules.dropLast()); self.expiresAt = expiresAt', 'session grant decodes with its caller, label and rules'],
  UNLABELED: ['Protocol.swift', 'label = (object["label"] as? String).flatMap { $0.isEmpty ? nil : $0 }', 'label = object["label"] as? String ?? ""',
    'a grant without a label decodes without one'],
  EXPIRED: ['Protocol.swift', 'var expired: Bool { expiresAt <= Date() }', 'var expired: Bool { false }', 'an ended grant reads as expired'],
  BANNER: ['Protocol.swift', 'return "\\(caller) wants to \\(words.verb) \\(words.object)"', 'return "\\(caller) wants to \\(words.verb)"',
    'the banner says the same'],
  PLAIN: ['ApprovalCard.swift', 'return (rules, duration, label)', 'return (rules, duration, label ?? "")',
    'a grant without a description is read back without one'],
  TUPLE: ['Protocol.swift', 'tab = string(object["tab"]) ?? ""', 'tab = string(object["tab"]) ?? (kind == "grant" ? "0" : "")',
    'a session grant signs the ordinary tuple with an empty tab'],
  SIGN_REMEMBER: ['Protocol.swift', 'guard verb == "grant", canRemember, let site, !site.isEmpty, !site.contains("|") else {', 'guard verb == "grant" else {',
    'a session grant cannot sign a remember choice'],
};
const [file, before, after, expected] = table[name];
const target = `${root}/${file}`, source = fs.readFileSync(target, 'utf8');
assert.equal(source.split(before).length, 2, `${name}: ${file} must contain the mutation target exactly once`);
fs.writeFileSync(target, source.replace(before, () => after));
process.stdout.write(expected);
NODE
  expect=$(cat "$STATE/expect.txt")
  compile "$STATE/src" "$STATE/mutant-$mutation"
  code=0
  "$STATE/mutant-$mutation" > "$STATE/mutant-$mutation.log" 2>&1 || code=$?
  if [[ "$code" -eq 0 ]] || ! grep -Fq "FAIL $expect" "$STATE/mutant-$mutation.log"; then
    cat "$STATE/mutant-$mutation.log"
    echo "FAIL app grants ${mutation}: the check \"$expect\" must fail, and fail first (exit ${code})"
    exit 1
  fi
  FALSIFIED=$((FALSIFIED + 1))
  echo "FALSIFIED app grants ${mutation}: \"$expect\" failed"
done
echo "== app grants falsification: ${FALSIFIED} falsified, 0 survived"
