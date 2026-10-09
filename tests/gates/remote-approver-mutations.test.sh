#!/usr/bin/env bash
# Falsification of the remote-approval checks: each mutation breaks ONE rule in a disposable copy of the
# broker, and the check that guards that rule must turn red BY NAME. The pristine copy must be green first, so
# a red can only come from the mutation. The pure rule logic (key handling, which kinds can ever be answered
# remotely) is also falsified at unit level (tests/policy/remote.test.sh); this one proves the broker wiring.
set -euo pipefail
cd "$(dirname "$0")/../.."
mkdir -p tests/.state/logs
COPY=$(mktemp -d tests/.state/remote-approver-XXXXXX)
MCP=$(mktemp -d tests/.state/remote-mcp-XXXXXX)
trap 'rm -rf "$COPY" "$MCP"' EXIT # Disposable mutation sources only.
mkdir -p "$COPY/tests/fixtures" "$COPY/tests/.state"
cp -R daemon mcp shared policy cli "$COPY/"
cp tests/fixtures/*.ts "$COPY/tests/fixtures/"
ln -s "$PWD/tests/mcp" "$COPY/tests/mcp"

BASE="tests/.state/logs/remote-approver-pristine.log"
code=0
env -u GADDI_POLICY_OFF node "$COPY/tests/fixtures/broker-checks.ts" remote-approver pristine >"$BASE" 2>&1 || code=$?
if [[ "$code" -ne 0 ]] || ! grep -Eq '^== remote-approver \(pristine\): [0-9]+ passed, 0 failed$' "$BASE"; then
  cat "$BASE"
  echo "FAIL remote-approver mutations: the unmodified copy must pass every check first"
  exit 1
fi
echo "PASS remote-approver pristine copy: $(grep -Ec '^PASS ASSERT_REMOTE_' "$BASE" || true) checks green"

FALSIFIED=0
for mutation in \
  OFF ENABLE_PROOF ENABLE_MATCH ENABLE_SAVED ENABLE_EVENT STORED_ONLY DISABLE_NOOP DISABLE_FILE DISABLE_EVENT \
  RESTART_FORGET INVALID_LOADED SIG_UNCHECKED BIND_KIND BIND_VERB BIND_DIGEST BIND_ID WINDOW NONCE_FORMAT NO_JOURNAL NONCE_JOURNAL \
  REATTACH ATTACH_ANNOUNCE PENDING_ONLY SCOPE_ANY GRANT_CAP SIGNIN QUERY MIXED DESTINATION PROTECTED ADDRESS TABLE \
  BY_REMOTE DENY_VERB ANNOUNCE \
  APPROVER GRANT_LIST GRANT_AUDIT AUDIT_APPROVER AUDIT_LEAK; do
  # Reset every source from the real tree, then apply ONE distinct mutation to this copy.
  for source in daemon/*.ts; do cp "$source" "$COPY/$source"; done
  # The edit is applied by a script on stdin; its answer goes through a file, not a command substitution,
  # because macOS ships bash 3.2, which cannot parse a here-document inside $( ).
  node --input-type=module - "$COPY" "$mutation" >"$COPY/expect.txt" <<'NODE'
import fs from 'node:fs';
import assert from 'node:assert/strict';
const [root, name] = process.argv.slice(2);
const SPEND = "proofs.spend([sha256(signature), sha256(Buffer.from('remote|' + nonce, 'utf8'))]);";
const ELIGIBLE = "if (!active || a.status !== 'pending') return false;";
// [the check that must go red, [file, text that must occur exactly once, replacement], ...]
const table = {
  // The feature is off unless it is on.
  OFF: ['ASSERT_REMOTE_OFF', ['daemon/remote.ts', ELIGIBLE, "if (a.status !== 'pending') return false;"]],
  // Turning it on: Touch ID, the matching file, a private saved choice, an announcement.
  ENABLE_PROOF: ['ASSERT_REMOTE_ENABLE', ['daemon/remote.ts', 'proofs.verify(proof, enableMessage(fingerprint, isRecord(proof) ? proof.ts : undefined));', '']],
  ENABLE_MATCH: ['ASSERT_REMOTE_ENABLE', ['daemon/remote.ts', 'if (!found || found.fingerprint !== fingerprint) {', 'if (!found) {']],
  ENABLE_SAVED: ['ASSERT_REMOTE_ENABLE', ['daemon/remote.ts', "save({ publicKey: String(found.key.export({ type: 'spki', format: 'pem' })), fingerprint, enabledAt });", '']],
  ENABLE_EVENT: ['ASSERT_REMOTE_ENABLE', ['daemon/remote.ts', "emit('remote.changed', { enabled: true, fingerprint });", '']],
  // Once on, only the key the owner turned on counts.
  STORED_ONLY: ['ASSERT_REMOTE_SWAP', ['daemon/remote.ts', 'active.key, signature)', '(candidate()?.key ?? active.key), signature)']],
  // Turning it off works at once, for anyone, and is remembered.
  DISABLE_NOOP: ['ASSERT_REMOTE_DISABLE', ['daemon/remote.ts', 'active = undefined;', 'void 0;']],
  DISABLE_FILE: ['ASSERT_REMOTE_DISABLE', ['daemon/remote.ts', 'try { fs.unlinkSync(statePath); }', 'try { void 0; }']],
  DISABLE_EVENT: ['ASSERT_REMOTE_DISABLE', ['daemon/remote.ts', "if (was || removed) emit('remote.changed', { enabled: false });", '']],
  // The owner's choice survives a restart; a damaged file means off.
  RESTART_FORGET: ['ASSERT_REMOTE_RESTART', ['daemon/remote.ts', "load(); // the owner's saved choice, read back at startup", '']],
  INVALID_LOADED: ['ASSERT_REMOTE_RESTART', ['daemon/remote.ts', "if (!key || fingerprintOf(key) !== saved.fingerprint) throw new Error('key');", "if (!key) throw new Error('key');"]],
  // A decision is signed by that key, for exactly one request, and is fresh.
  SIG_UNCHECKED: ['ASSERT_REMOTE_SIGNER', ['daemon/remote.ts', "if (!valid) return invalid('decision signature verification failed');", '']],
  BIND_KIND: ['ASSERT_REMOTE_BINDING', ['daemon/remote.ts', '|${String(a.kind)}|${remoteDigest(a)}|', '|click|${remoteDigest(a)}|']],
  BIND_VERB: ['ASSERT_REMOTE_BINDING', ['daemon/remote.ts', 'return `gaddi-remote|${verb}|', 'return `gaddi-remote|grant|']],
  BIND_DIGEST: ['ASSERT_REMOTE_BINDING', ['daemon/remote.ts', '|${remoteDigest(a)}|${nonce}|${ts}`', '|${nonce}|${ts}`']],
  BIND_ID: ['ASSERT_REMOTE_BINDING', ['daemon/remote.ts', '|${String(a.id)}|${String(a.kind)}|', '|${String(a.kind)}|']],
  WINDOW: ['ASSERT_REMOTE_FRESH', ['daemon/remote.ts', 'if (Math.abs(Date.now() - ts) > WINDOW_MS) return invalid(', 'if (false) return invalid(']],
  NONCE_FORMAT: ['ASSERT_REMOTE_FRESH', ['daemon/remote.ts', ' || !NONCE.test(nonce)', '']],
  // Single use, also across a restart.
  NO_JOURNAL: ['ASSERT_REMOTE_REPLAY', ['daemon/remote.ts', SPEND, '']],
  NONCE_JOURNAL: ['ASSERT_REMOTE_REPLAY', ['daemon/remote.ts', SPEND, 'proofs.spend([sha256(signature)]);']],
  REATTACH: ['ASSERT_REMOTE_REPLAY', ['daemon/daemon.ts', 'if (existing) approvals.attach(existing, remoteFacts);', '']],
  ATTACH_ANNOUNCE: ['ASSERT_REMOTE_REPLAY', ['daemon/approvals.ts',
    "if (!before && remote(a, facts.get(a))) emit('approval.pending', { approval: view(a), tab: a.tab });", '']],
  // Only a waiting request can be answered, and only one the broker says is in scope.
  PENDING_ONLY: ['ASSERT_REMOTE_STATE', ['daemon/remote.ts', ELIGIBLE, 'if (!active) return false;']],
  SCOPE_ANY: ['ASSERT_REMOTE_SCOPE', ['daemon/remote.ts', "remoteWaivable(policy, facts.pageURL, { outcome: 'hold', reason: facts.reason }, facts.scope)", 'true']],
  GRANT_CAP: ['ASSERT_REMOTE_SCOPE', ['daemon/remote.ts', 'a.grant.minutes <= REMOTE_GRANT_MINUTES', 'true']],
  // A sign-in is never answerable from another device, whatever the facts say.
  SIGNIN: ['ASSERT_REMOTE_SIGNIN', ['daemon/remote.ts', ELIGIBLE, ELIGIBLE + " if (a.kind === 'signin') return true;"]],
  // The page address keeps its query, because a query can make a page protected.
  QUERY: ['ASSERT_REMOTE_SCOPE', ['daemon/daemon.ts', 'remoteScope = { pageURL, scope };', 'remoteScope = { pageURL: cleanURL(pageURL), scope };']],
  // The scan shared with session grants.
  MIXED: ['ASSERT_REMOTE_SCOPE', ['daemon/grants.ts', 'for (const verb of protections(policy).verbs) {', 'for (const verb of [] as string[]) {']],
  DESTINATION: ['ASSERT_REMOTE_SCOPE', ['daemon/grants.ts', 'if (scope.destination) {', 'if (scope.destination && false) {']],
  PROTECTED: ['ASSERT_REMOTE_SCOPE', ['daemon/grants.ts', 'if (!permission || !page || protectedAddress(policy, page)) return check;', 'if (!permission || !page) return check;']],
  ADDRESS: ['ASSERT_REMOTE_SCOPE', ['daemon/grants.ts', 'grantableAddress(target) ? EVERYTHING : undefined', 'EVERYTHING']],
  TABLE: ['ASSERT_REMOTE_SCOPE', ['daemon/grants.ts',
    "return POST_VERBS.includes(folded) ? 'post' : DELETE_VERBS.includes(folded) ? 'delete' : undefined;",
    "return POST_VERBS.includes(folded) ? 'post' : 'delete';"]],
  // What a remote answer does: it says who decided, it denies when told to, it is announced as remote.
  BY_REMOTE: ['ASSERT_REMOTE_CONSUME', ['daemon/approvals.ts', "{ by: 'remote', decidedAt: new Date().toISOString() }", "{ by: 'signed-proof', decidedAt: new Date().toISOString() }"]],
  DENY_VERB: ['ASSERT_REMOTE_CONSUME', ['daemon/approvals.ts', "resolve(a, verb === 'grant' ? 'granted' : 'denied', { by: 'remote'", "resolve(a, 'granted', { by: 'remote'"]],
  ANNOUNCE: ['ASSERT_REMOTE_CONSUME', ['daemon/approvals.ts', "emit('approval.pending', { approval: view(a), tab });", "emit('approval.pending', { approval: publicView(a), tab });"]],
  // A session grant approved remotely says so, in the list and in the audit.
  APPROVER: ['ASSERT_REMOTE_GRANT', ['daemon/daemon.ts', ', ...(approver ? { approver } : {})', '']],
  GRANT_LIST: ['ASSERT_REMOTE_GRANT', ['daemon/grants.ts',
    ' ...(grant.approver ? { approver: grant.approver } : {}),\n    mine:', ' mine:']],
  GRANT_AUDIT: ['ASSERT_REMOTE_GRANT', ['daemon/grants.ts',
    '...(grant.approver ? { approver: grant.approver } : {}),\n      rules: grant.rules.map(ruleString)', 'rules: grant.rules.map(ruleString)']],
  // The audit names who decided and what, and never the signature or the nonce.
  AUDIT_APPROVER: ['ASSERT_REMOTE_AUDIT', ['daemon/daemon.ts', "{ approver: 'remote', kind: meta.decision.kind, verb: meta.decision.verb }", '{ kind: meta.decision.kind, verb: meta.decision.verb }']],
  AUDIT_LEAK: ['ASSERT_REMOTE_AUDIT', ['daemon/daemon.ts', '...(meta.remoteKey ? { fingerprint: meta.remoteKey } : {}),',
    '...(meta.remoteKey ? { fingerprint: meta.remoteKey } : {}), nonce: params.nonce, sig: params.sig,']],
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
  LOG="tests/.state/logs/remote-approver-${mutation}-falsified.log"
  code=0
  env -u GADDI_POLICY_OFF node "$COPY/tests/fixtures/broker-checks.ts" remote-approver "$mutation" >"$LOG" 2>&1 || code=$?
  if [[ "$code" -ne 1 ]] || grep -q '^INFRA ' "$LOG" || ! grep -q "^FAIL ASSERTION remote-approver: ${expect}:" "$LOG"; then
    cat "$LOG"
    echo "FAIL remote-approver ${mutation}: ${expect} must turn red, with no infrastructure failure (exit ${code})"
    exit 1
  fi
  FALSIFIED=$((FALSIFIED + 1))
  echo "FALSIFIED remote-approver ${mutation}: ${expect} failed"
done

# The agent surface: a tool that reaches a remote method must turn the MCP metadata test red BY NAME.
mkdir -p "$MCP/tests/mcp"
cp -R mcp shared "$MCP/"
cp tests/mcp/metadata.test.ts "$MCP/tests/mcp/"
LOG="tests/.state/logs/remote-approver-MCP-pristine.log"
code=0
node "$MCP/tests/mcp/metadata.test.ts" >"$LOG" 2>&1 || code=$?
if [[ "$code" -ne 0 ]] || ! grep -q '^PASS ASSERT_REMOTE_NO_MCP' "$LOG"; then
  cat "$LOG"
  echo "FAIL remote-approver MCP: the unmodified copy must pass the metadata test first"
  exit 1
fi
node --input-type=module - "$MCP/mcp/server.ts" <<'NODE'
import fs from 'node:fs';
import assert from 'node:assert/strict';
const file = process.argv[2], source = fs.readFileSync(file, 'utf8');
const before = "  tool('status', 'Report broker and Chrome bridge status.'),";
assert.equal(source.split(before).length, 2, 'MCP: mutation target must occur exactly once');
fs.writeFileSync(file, source.replace(before, () => before + "\n  tool('remote', 'Answer a request from another device.', {}, [], 'remote.status'),"));
NODE
LOG="tests/.state/logs/remote-approver-MCP-falsified.log"
code=0
node "$MCP/tests/mcp/metadata.test.ts" >"$LOG" 2>&1 || code=$?
if [[ "$code" -eq 0 ]] || ! grep -q 'ASSERT_REMOTE_NO_MCP: browser_remote' "$LOG"; then
  cat "$LOG"
  echo "FAIL remote-approver MCP: a tool that reaches a remote method must turn ASSERT_REMOTE_NO_MCP red (exit ${code})"
  exit 1
fi
FALSIFIED=$((FALSIFIED + 1))
echo "FALSIFIED remote-approver MCP: ASSERT_REMOTE_NO_MCP failed"
echo "== remote-approver mutations: ${FALSIFIED} falsified, 0 survived"
