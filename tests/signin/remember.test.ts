// Production approval, proof and policy code with disposable software keys and policy files.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApprovals } from '../../daemon/approvals.ts';
import { approvalMessage, createProofVerifier, signinRevokeMessage } from '../../daemon/proof.ts';
import { checkSignin, loadPolicy, setSigninRemember } from '../../daemon/policy.ts';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gaddi-remember-'));
const overlay = path.join(home, 'policy.json');
const publicKeyPath = path.join(home, 'approver.pub'), usedPath = path.join(home, 'used-proofs.log');
const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
fs.writeFileSync(publicKeyPath, publicKey.export({ type: 'spki', format: 'pem' }));
let verifier = createProofVerifier({ publicKeyPath, usedPath });
const approvals = createApprovals({});
const site = 'https://example.test:8443';
let policy = loadPolicy({ overlay, off: false }), passed = 0;
const pass = (name: string) => { passed++; console.log(`PASS ${name}`); };
const sign = (message: string, ts: number) => ({ ts, sig: crypto.sign('sha256', Buffer.from(message), privateKey).toString('base64') });
const hold = (kind = 'signin', url = site + '/login') => approvals.hold({ kind, tab: 7, caller: 'fake-agent', url,
  detail: 'Fixture login', action: { method: kind, caller: 'fake-agent', url, nonce: crypto.randomUUID() } });
const grant = (a: ReturnType<typeof hold>, proof: unknown, remember: unknown = true) => approvals.signed(a.id, 'grant', proof, verifier, approvalMessage,
  { remember, onRemember: origin => { policy = setSigninRemember(overlay, origin, true); } });
const revoke = (origin: string, proof: unknown) => {
  const ts = proof && typeof proof === 'object' && 'ts' in proof ? proof.ts : undefined;
  verifier.verify(proof, signinRevokeMessage(origin, ts));
  policy = setSigninRemember(overlay, origin, false);
};
try {
  const a = hold(), ts = Date.now();
  assert.equal(checkSignin(policy, site).outcome, 'hold');
  assert.equal(approvals.list().pending[0].site, site);
  assert.throws(() => grant(a, undefined), /signed proof/);
  assert.throws(() => grant(a, sign(approvalMessage('grant', a, ts), ts)), /verification failed/);
  assert.throws(() => grant(a, sign(approvalMessage('grant', a, ts, true), ts), 'true'), /boolean/);
  assert.equal(a.status, 'pending'); assert.equal(fs.existsSync(overlay), false);
  pass('unsigned, allow-once escalation and non-boolean remember leave policy and hold unchanged');

  const rememberedProof = sign(approvalMessage('grant', a, ts, true), ts);
  assert.throws(() => grant(a, rememberedProof, false), /verification failed/);
  // Change the actual stored record: signed(id) deliberately ignores caller-supplied fields.
  const original = a.url; a.url = 'https://other.example.test/login';
  assert.throws(() => grant(a, rememberedProof), /verification failed/); a.url = original;
  grant(a, rememberedProof);
  assert.equal(a.status, 'granted'); assert.equal(checkSignin(policy, site).outcome, 'allow');
  assert.deepEqual(JSON.parse(fs.readFileSync(overlay, 'utf8')), { signin: { remember: [site] } });
  assert.equal(fs.statSync(overlay).mode & 0o777, 0o600);
  pass('remember signature binds choice and origin; verified grant saves private overlay and updates policy');

  for (const other of ['https://example.test', 'https://example.test:8444', 'https://sub.example.test:8443', 'http://example.test:8443']) {
    assert.equal(checkSignin(policy, other).outcome, 'hold');
  }
  policy = loadPolicy({ overlay, off: true });
  assert.equal(checkSignin(policy, site).outcome, 'allow');
  assert.equal(checkSignin(policy, 'https://other.example.test').outcome, 'hold');
  verifier = createProofVerifier({ publicKeyPath, usedPath });
  assert.throws(() => verifier.verify(rememberedProof, approvalMessage('grant', a, ts, true)), /already used/);
  pass('persisted exact-origin policy reloads; scheme/port/subdomain mismatches hold and proof replay survives restart');

  const click = hold('click'), denied = hold();
  assert.throws(() => grant(click, sign(approvalMessage('grant', click, ts), ts)), /sign-in grant/);
  assert.throws(() => approvals.signed(denied.id, 'deny', rememberedProof, verifier, approvalMessage, { remember: true }), /sign-in grant/);
  const stale = Date.now() - 60001;
  assert.throws(() => grant(denied, sign(approvalMessage('grant', denied, stale, true), stale)), /60 seconds/);
  const impostor = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
  assert.throws(() => grant(denied, { ts, sig: crypto.sign('sha256', Buffer.from(approvalMessage('grant', denied, ts, true)), impostor).toString('base64') }), /verification failed/);
  pass('wrong-kind, deny, stale and wrong-key proofs cannot add grants');

  const revokeTs = Date.now(), revokeProof = sign(signinRevokeMessage(site, revokeTs), revokeTs);
  assert.throws(() => revoke(site, undefined), /signed proof/);
  assert.throws(() => revoke('https://other.example.test', revokeProof), /verification failed/);
  assert.throws(() => revoke(site, rememberedProof), /already used/);
  revoke(site, revokeProof);
  assert.equal(checkSignin(policy, site).outcome, 'hold');
  assert.equal(checkSignin(loadPolicy({ overlay, off: false }), site).outcome, 'hold');
  assert.throws(() => revoke(site, revokeProof), /already used/);
  pass('revocation is signed, origin-bound and replay-protected; active and reloaded policy hold again');

  const rules = { hold: { verbs: ['submit record'] }, deny: { eval_patterns: ['API\\.LMSCommit'] }, approvals: { ttl_minutes: 2 },
    signin: { remember: ['https://existing.example.test'] } };
  fs.writeFileSync(overlay, JSON.stringify(rules));
  setSigninRemember(overlay, site, true); setSigninRemember(overlay, site, true);
  let saved = JSON.parse(fs.readFileSync(overlay, 'utf8'));
  assert.deepEqual(saved, { ...rules, signin: { remember: ['https://existing.example.test', site] } });
  setSigninRemember(overlay, site, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(overlay, 'utf8')), rules);
  for (const invalid of ['https://example.test/', 'https://example.test/login', 'https://user@example.test', 'http://example.test', '*.example.test', 1]) {
    assert.throws(() => setSigninRemember(overlay, invalid, true), /invalid value/);
  }
  pass('overlay edits preserve unrelated rules and origins, deduplicate grants and reject non-exact origins');

  const writeFailed = hold(), writeTs = Date.now();
  const writeProof = sign(approvalMessage('grant', writeFailed, writeTs, true), writeTs);
  const durable = fs.readFileSync(overlay, 'utf8'), rename = fs.renameSync;
  fs.renameSync = () => { throw new Error('fixture atomic rename failure'); };
  try {
    assert.throws(() => grant(writeFailed, writeProof), /fixture atomic rename failure/);
    assert.equal(writeFailed.status, 'pending'); assert.equal(fs.readFileSync(overlay, 'utf8'), durable);
    assert.equal(fs.readdirSync(home).some(file => file.endsWith('.tmp')), false);
  } finally { fs.renameSync = rename; }
  assert.throws(() => grant(writeFailed, writeProof), /already used/);
  grant(writeFailed, sign(approvalMessage('grant', writeFailed, writeTs + 1, true), writeTs + 1));
  assert.equal(writeFailed.status, 'granted');
  pass('failed atomic rename preserves policy and pending hold, cleans temporary file and requires a fresh proof to retry');

  fs.writeFileSync(overlay, '{');
  const blocked = hold(), blockedTs = Date.now();
  assert.throws(() => grant(blocked, sign(approvalMessage('grant', blocked, blockedTs, true), blockedTs)), /Invalid policy overlay/);
  assert.equal(blocked.status, 'pending'); assert.equal(fs.readFileSync(overlay, 'utf8'), '{');
  fs.unlinkSync(overlay); fs.mkdirSync(overlay);
  assert.throws(() => grant(blocked, sign(approvalMessage('grant', blocked, blockedTs + 1, true), blockedTs + 1)), /Invalid policy overlay/);
  assert.equal(blocked.status, 'pending');
  assert.equal(fs.readdirSync(home).some(file => file.endsWith('.tmp')), false);
  pass('invalid or unreadable policy cannot resolve a remember hold');
  const restored = createApprovals({});
  try {
    restored.restore([
      ...['', undefined, 'http://untrusted.example.test', 'file:///tmp/login'].map((url, index) => ({
        id: 'malformed-' + index, kind: 'signin', url, actionHash: 'a'.repeat(64), status: 'pending', expiresAt: new Date(0).toISOString(),
      })),
      { ...denied, status: 'pending' },
    ]);
    assert.deepEqual(restored.list().pending.map(a => a.id), [denied.id]);
    assert.equal(restored.list().pending[0].site, site);
    assert.throws(() => restored.get('malformed-0'), /unknown/);
  } finally { restored.stop(); }
  pass('malformed restored sign-in URLs cannot poison healthy snapshots or expiry');
  console.log(`== signin remember: ${passed} passed, 0 failed`);
} finally {
  approvals.stop();
  fs.rmSync(home, { recursive: true, force: true }); // This test's temporary fixture only.
}
