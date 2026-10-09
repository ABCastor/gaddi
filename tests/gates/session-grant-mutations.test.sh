#!/usr/bin/env bash
# Falsification of the session-grant checks: each mutation breaks ONE rule in a disposable copy of
# the broker, and the check that guards that rule must turn red BY NAME. The pristine copy must be
# green first, so a red can only come from the mutation. Pure rule logic is also falsified at unit
# level (tests/policy/grants.test.sh); this one proves the broker wiring around it.
set -euo pipefail
cd "$(dirname "$0")/../.."
mkdir -p tests/.state/logs
COPY=$(mktemp -d tests/.state/session-grant-XXXXXX)
trap 'rm -rf "$COPY"' EXIT # Disposable mutation sources only.
mkdir -p "$COPY/tests/fixtures" "$COPY/tests/.state"
cp -R daemon mcp shared policy cli "$COPY/"
cp tests/fixtures/*.ts "$COPY/tests/fixtures/"
ln -s "$PWD/tests/mcp" "$COPY/tests/mcp"

BASE="tests/.state/logs/session-grant-pristine.log"
code=0
env -u GADDI_POLICY_OFF node "$COPY/tests/fixtures/broker-checks.ts" session-grant pristine >"$BASE" 2>&1 || code=$?
if [[ "$code" -ne 0 ]] || ! grep -Eq '^== session-grant \(pristine\): [0-9]+ passed, 0 failed$' "$BASE"; then
  cat "$BASE"
  echo "FAIL session-grant mutations: the unmodified copy must pass every check first"
  exit 1
fi
echo "PASS session-grant pristine copy: $(grep -Ec '^PASS ASSERT_GRANT_' "$BASE" || true) checks green"

FALSIFIED=0
for mutation in \
  OTHER_SESSION CLI LIVE_REQUIRED ENDED_ASK PROOF REMEMBER REVOKE SESSION_END AUDIT APPROVAL_CREDIT UPLOAD CLICK ENTER \
  LEAK_VIEW LEAK_DISK CLEAN_GRANT ONE_OPEN EXPIRY LIST BOUNDARY ORIGIN PERMISSION MIXED PROTECTED DESTINATION NEVER GMAIL TABLE DETAIL \
  NEEDED DENY SECRET RESTART; do
  # Reset every source from the real tree, then apply ONE distinct mutation to this copy.
  for source in daemon/*.ts; do cp "$source" "$COPY/$source"; done
  # The edit is applied by a script on stdin; its answer goes through a file, not a command substitution,
  # because macOS ships bash 3.2, which cannot parse a here-document inside $( ).
  node --input-type=module - "$COPY" "$mutation" >"$COPY/expect.txt" <<'NODE'
import fs from 'node:fs';
import assert from 'node:assert/strict';
const [root, name] = process.argv.slice(2);
// [file, text that must occur exactly once, replacement]; the check that must go red.
const table = {
  OTHER_SESSION: ['ASSERT_GRANT_OTHER_SESSION', ['daemon/grants.ts', '.filter(grant => grant.session === session);', '.filter(() => true);']],
  CLI: ['ASSERT_GRANT_CLI', ['daemon/grants.ts',
    'return session === undefined ? [] : [...entries.values()].map(entry => entry.grant).filter(grant => grant.session === session);',
    'return [...entries.values()].map(entry => entry.grant).filter(grant => session === undefined || grant.session === session);']],
  LIVE_REQUIRED: ['ASSERT_GRANT_LIVE_REQUIRED', ['daemon/daemon.ts', 'if (session === undefined || !liveSessions.has(session)) {', 'if (session === undefined) {']],
  ENDED_ASK: ['ASSERT_GRANT_ENDED_ASK',
    ['daemon/daemon.ts', 'if (!isGrantSpec(spec) || !liveSessions.has(spec.session)) {', 'if (!isGrantSpec(spec)) {'],
    ['daemon/daemon.ts', 'for (const request of pendingGrantsOf(key)) approvals.cancel(request.id);', 'void 0;']],
  PROOF: ['ASSERT_GRANT_PROOF', ['daemon/proof.ts', "if (!valid) invalid('proof signature verification failed');", '']],
  REMEMBER: ['ASSERT_GRANT_REMEMBER', ['daemon/daemon.ts',
    "if (remember === true) throw new GateError('approval-invalid', 'a session grant cannot be remembered');", '']],
  REVOKE: ['ASSERT_GRANT_REVOKE', ['daemon/daemon.ts',
    "if (typeof id !== 'string' || !grants.revoke(id)) throw new Error('no such active session grant');",
    "if (typeof id !== 'string') throw new Error('no such active session grant');"]],
  SESSION_END: ['ASSERT_GRANT_SESSION_END', ['daemon/daemon.ts', 'grants.endSession(key);', 'void key;']],
  AUDIT: ['ASSERT_GRANT_AUDIT', ['daemon/daemon.ts', 'if (grantId && !params.approval) meta.grantId = grantId;', '']],
  APPROVAL_CREDIT: ['ASSERT_GRANT_APPROVAL_CONSUMED', ['daemon/daemon.ts', 'if (grantId && !params.approval) meta.grantId = grantId;',
    'if (grantId) meta.grantId = grantId;']],
  UPLOAD: ['ASSERT_GRANT_UPLOAD', ['daemon/daemon.ts', "check = grantCheck(check, { kind: 'upload' });", '']],
  CLICK: ['ASSERT_GRANT_CLICK', ['daemon/daemon.ts', "check = grantCheck(check, { kind: 'click', name: info.name, destination });", '']],
  ENTER: ['ASSERT_GRANT_ENTER', ['daemon/daemon.ts', "check = grantCheck(check, { kind: 'press', name: submitName });", '']],
  LEAK_VIEW: ['ASSERT_GRANT_NO_SESSION_LEAK', ['daemon/approvals.ts',
    'export function publicView({ actionHash, targetSelector, grant, ...record }: StoredApproval) {',
    'export function publicView({ actionHash, targetSelector, ...record }: StoredApproval) {']],
  LEAK_DISK: ['ASSERT_GRANT_NO_SESSION_LEAK', ['daemon/approvals.ts',
    "function persistable() { return [...entries.values()].filter(a => a.kind !== 'grant'); }",
    'function persistable() { return [...entries.values()]; }']],
  CLEAN_GRANT: ['ASSERT_GRANT_DETAIL', ['daemon/approvals.ts', "detail: kind === 'grant' ? detail : cleanDetail(detail),", 'detail: cleanDetail(detail),']],
  ONE_OPEN: ['ASSERT_GRANT_ONE_OPEN', ['daemon/daemon.ts', 'for (const older of pendingGrantsOf(session)) approvals.cancel(older.id);', '']],
  EXPIRY: ['ASSERT_GRANT_EXPIRY', ['daemon/grants.ts', 'expiresAt: created + spec.minutes * minuteMs };', 'expiresAt: created + spec.minutes * minuteMs * 1000 };']],
  LIST: ['ASSERT_GRANT_LIST', ['daemon/grants.ts', 'mine: mine !== undefined && grant.session === mine });', 'mine: true });']],
  BOUNDARY: ['ASSERT_GRANT_BOUNDARY', ['daemon/grants.ts', "url.pathname.startsWith(rule.path + '/')", 'url.pathname.startsWith(rule.path)']],
  ORIGIN: ['ASSERT_GRANT_ORIGIN', ['daemon/grants.ts', 'return url.origin === rule.origin && (', 'return (']],
  PERMISSION: ['ASSERT_GRANT_PERMISSION', ['daemon/grants.ts',
    'grant.rules.some(rule => rule.permission === needed && covers(rule, target))', 'grant.rules.some(rule => covers(rule, target))']],
  MIXED: ['ASSERT_GRANT_MIXED', ['daemon/grants.ts', 'for (const verb of protections(policy).verbs) {', 'for (const verb of [] as string[]) {']],
  PROTECTED: ['ASSERT_GRANT_PROTECTED', ['daemon/grants.ts',
    'if (!permission || !page || protectedAddress(policy, page)) return check;', 'if (!permission || !page) return check;']],
  DESTINATION: ['ASSERT_GRANT_DESTINATION', ['daemon/grants.ts', 'if (scope.destination) {', 'if (scope.destination && false) {']],
  NEVER: ['ASSERT_GRANT_NEVER', ['daemon/grants.ts', 'if (!isPermission(permission)) throw new Error(', 'if (false) throw new Error(']],
  GMAIL: ['ASSERT_GRANT_GMAIL', ['daemon/grants.ts', 'if (hosts.some(host => rx(host)?.test(hostOf(canonical)))) bad(', 'if (false) bad(']],
  TABLE: ['ASSERT_GRANT_NEVER_WAIVED', ['daemon/grants.ts',
    "return POST_VERBS.includes(folded) ? 'post' : DELETE_VERBS.includes(folded) ? 'delete' : undefined;",
    "return POST_VERBS.includes(folded) ? 'post' : 'delete';"]],
  DETAIL: ['ASSERT_GRANT_DETAIL', ['daemon/grants.ts', ".join('\\n');", ".join(' | ');"]],
  // A chat with no grant gets a waiver anyway.
  NEEDED: ['ASSERT_GRANT_NEEDED',
    ['daemon/grants.ts', "if (check.outcome !== 'hold' || grants.length === 0) return check;", "if (check.outcome !== 'hold') return check;"],
    ['daemon/grants.ts', 'if (!grant) return check;', "if (!grant) return { outcome: 'allow', reason: 'session grant', grant: 'none' };"]],
  // A request the owner denied can still be approved afterwards.
  DENY: ['ASSERT_GRANT_DENY', ['daemon/approvals.ts', "if (a.status !== 'pending') throw new GateError('approval-invalid', ", "if (false) throw new GateError('approval-invalid', "]],
  // The refusal of key and credential files stops holding, so only the grant stands between the agent and the file.
  SECRET: ['ASSERT_GRANT_SECRET', ['daemon/uploads.ts',
    "const refuse = (reason: string): never => { throw new GateError('denied', ",
    "const refuse = (reason: string): never => { if (reason) return undefined as never; throw new GateError('denied', "]],
  // Grant records are written to state.json and read back after a restart.
  RESTART: ['ASSERT_GRANT_RESTART',
    ['daemon/approvals.ts', "function persistable() { return [...entries.values()].filter(a => a.kind !== 'grant'); }", 'function persistable() { return [...entries.values()]; }'],
    ['daemon/approvals.ts', "String(a.actionHash)) && a.kind !== 'grant') {", 'String(a.actionHash))) {']],
};
const [expected, ...edits] = table[name];
for (const [file, before, after] of edits) {
  const target = `${root}/${file}`, source = fs.readFileSync(target, 'utf8');
  assert.equal(source.split(before).length, 2, `${name}: ${file} must contain the mutation target exactly once`);
  fs.writeFileSync(target, source.replace(before, () => after));
}
process.stdout.write(expected);
NODE
  expect=$(cat "$COPY/expect.txt")
  LOG="tests/.state/logs/session-grant-${mutation}-falsified.log"
  code=0
  env -u GADDI_POLICY_OFF node "$COPY/tests/fixtures/broker-checks.ts" session-grant "$mutation" >"$LOG" 2>&1 || code=$?
  if [[ "$code" -ne 1 ]] || grep -q '^INFRA ' "$LOG" || ! grep -q "^FAIL ASSERTION session-grant: ${expect}:" "$LOG"; then
    cat "$LOG"
    echo "FAIL session-grant ${mutation}: ${expect} must turn red, with no infrastructure failure (exit ${code})"
    exit 1
  fi
  FALSIFIED=$((FALSIFIED + 1))
  echo "FALSIFIED session-grant ${mutation}: ${expect} failed"
done
echo "== session-grant mutations: ${FALSIFIED} falsified, 0 survived"
