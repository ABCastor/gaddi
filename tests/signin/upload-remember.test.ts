// Owner-signed upload permissions, disposable policies and proofs. No browser or keychain.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createApprovals, publicView } from '../../daemon/approvals.ts';
import { approvalMessage, createProofVerifier, uploadRevokeMessage } from '../../daemon/proof.ts';
import { checkRememberedUpload, checkUpload, loadPolicy, setUploadRemember, UPLOAD_HOLD, uploadSite } from '../../daemon/policy.ts';
import { readUpload } from '../../daemon/uploads.ts';
import type { StoredApproval } from '../../daemon/approvals.ts';

const state = path.resolve(import.meta.dirname, '../.state'); fs.mkdirSync(state, { recursive: true });
const home = fs.mkdtempSync(path.join(state, 'upload-remember-'));
const overlay = path.join(home, 'policy.json'), publicKeyPath = path.join(home, 'approver.pub');
const site = 'https://github.com', url = site + '/ABCastor/gaddi/settings';
const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
fs.writeFileSync(publicKeyPath, publicKey.export({ type: 'spki', format: 'pem' }));
const verifier = createProofVerifier({ publicKeyPath, usedPath: path.join(home, 'used.log') });
const approvals = createApprovals({});
let policy = loadPolicy({ overlay, off: false }), passed = 0;
const pass = (name: string) => { passed++; console.log(`PASS ${name}`); };
const sign = (message: string, ts: number) => ({ ts, sig: crypto.sign('sha256', Buffer.from(message), privateKey).toString('base64') });
const check = (page = url) => checkRememberedUpload(policy, page, checkUpload(policy));
const hold = () => approvals.hold({ kind: 'upload', caller: 'test', tab: 7, url, detail: 'preview.png (1 KB)', reason: UPLOAD_HOLD,
  rememberable: check().rememberable, action: { caller: 'test', method: 'upload', url, nonce: crypto.randomUUID() } });
const grant = (a: StoredApproval, proof: unknown, remember: unknown = true) => approvals.signed(a.id, 'grant', proof, verifier, approvalMessage,
  { remember, onRemember: origin => { policy = setUploadRemember(overlay, origin, true); } });
try {
  assert.deepEqual(policy.uploads?.remember, []);
  assert.equal(check().outcome, 'hold', 'ASSERT_UPLOAD_DEFAULT_HELD');
  assert.equal(check().rememberable, true, 'ASSERT_UPLOAD_REMEMBERABLE');
  const a = hold(); assert.equal(publicView(a).site, site);
  const ts = Date.now(), proof = sign(approvalMessage('grant', a, ts, true), ts);
  assert.throws(() => grant(a, undefined), /signed proof/, 'ASSERT_UPLOAD_UNSIGNED_REJECTED');
  assert.throws(() => grant(a, sign(approvalMessage('grant', a, ts), ts)), /verification failed/, 'ASSERT_UPLOAD_ONCE_FORGE');
  assert.throws(() => grant(a, proof, false), /verification failed/);
  assert.throws(() => grant(a, proof, 'true'), /boolean/);
  const oldURL = a.url; a.url = 'https://other.example.test/settings';
  assert.throws(() => grant(a, proof), /verification failed/); a.url = oldURL;
  const oldDetail = a.detail; a.detail = 'other.png (2 KB)';
  assert.throws(() => grant(a, proof), /verification failed/); a.detail = oldDetail;
  assert.equal(fs.existsSync(overlay), false); assert.equal(a.status, 'pending');
  pass('default hold exposes exact site; unsigned, Allow once forgery, changed origin/detail and nonboolean remember are rejected');

  grant(a, proof);
  assert.equal(check().outcome, 'allow', 'ASSERT_UPLOAD_RULE_APPLIED');
  assert.equal(check().reason, 'owner remembered uploads on this site');
  assert.deepEqual(JSON.parse(fs.readFileSync(overlay, 'utf8')), { uploads: { remember: [site] } });
  assert.equal(fs.statSync(overlay).mode & 0o777, 0o600);
  policy = loadPolicy({ overlay, off: false });
  assert.equal(check(site + '/another-repo/settings').outcome, 'allow');
  for (const page of ['http://github.com/settings', 'https://github.com:8443/settings', 'https://sub.github.com/settings', 'https://other.example.test/settings']) {
    assert.equal(check(page).outcome, 'hold', 'ASSERT_UPLOAD_EXACT_SITE');
  }
  assert.throws(() => createProofVerifier({ publicKeyPath, usedPath: path.join(home, 'used.log') }).verify(proof,
    approvalMessage('grant', a, ts, true)), /already used/);
  policy = setUploadRemember(overlay, site, true); assert.deepEqual(policy.uploads?.remember, [site]);
  pass('signed remember persists privately and across reload, deduplicates, matches exact scheme/host/port and rejects replay');

  for (const page of ['/security', '/settings/security', '/payment', '/checkout', '/delete-account', '/settings?next=/security', '/settings#/checkout']) {
    const blocked = check(site + page);
    assert.equal(blocked.outcome, 'hold', 'ASSERT_UPLOAD_PROTECTED');
    assert.equal(blocked.rememberable, undefined);
    assert.equal(uploadSite(site + page), undefined, 'ASSERT_UPLOAD_PROTECTED_SITE');
  }
  assert.equal(uploadSite('https://mail.google.com/mail'), undefined, 'ASSERT_UPLOAD_REFUSED_HOST');
  assert.equal(check('https://mail.google.com/mail').outcome, 'hold');
  assert.equal(check('https://mail.google.com/mail').rememberable, undefined, 'ASSERT_UPLOAD_REFUSED_HOST');
  assert.equal(check('https://user:password@github.com/settings').rememberable, undefined);
  assert.equal(check('file:///tmp/page').rememberable, undefined);
  assert.equal(checkRememberedUpload(policy, url, { outcome: 'deny', reason: 'refused file' }).outcome, 'deny');
  assert.equal(checkRememberedUpload(policy, url, { outcome: 'hold', reason: 'security action' }).rememberable, undefined);
  const ineligible = { ...a, id: 'bad', kind: 'upload', reason: 'security action', status: 'pending', rememberable: true };
  assert.throws(() => approvalMessage('grant', ineligible, ts, true), /eligible upload/);
  assert.throws(() => approvalMessage('deny', a, ts, true), /eligible upload/);
  pass('built-in protected paths, query/hash, refused hosts, credential URLs and other hold/refusal kinds never gain upload authority');

  const others = { signin: { remember: ['https://login.example.test'] }, sends: { remember: [] },
    hold: { url_patterns: ['/private'] }, deny: { verbs_on_hosts: [{ host: '^blocked\\.example\\.test$', verbs: ['send'] }] },
    uploads: { remember: [site, 'https://blocked.example.test'] } };
  fs.writeFileSync(overlay, JSON.stringify(others)); policy = loadPolicy({ overlay, off: false });
  assert.equal(check(site + '/private').outcome, 'hold', 'ASSERT_UPLOAD_OWNER_PROTECTED');
  assert.equal(check(site + '/private').rememberable, undefined);
  assert.equal(check(site + '/security').outcome, 'hold', 'ASSERT_UPLOAD_BUILTIN_OVERLAY');
  assert.equal(check('https://blocked.example.test/profile').outcome, 'hold', 'ASSERT_UPLOAD_OWNER_HOST');
  assert.equal(check('https://blocked.example.test/profile').rememberable, undefined);
  policy = setUploadRemember(overlay, 'https://second.example.test:8443', true);
  const saved = JSON.parse(fs.readFileSync(overlay, 'utf8'));
  for (const key of ['signin', 'sends', 'hold', 'deny'] as const) assert.deepEqual(saved[key], others[key]);
  pass('owner URL/host protections apply and built-in protections survive array replacement; other policy choices are preserved');

  const revokeTs = Date.now(), revokeProof = sign(uploadRevokeMessage(site, revokeTs), revokeTs);
  assert.throws(() => verifier.verify(revokeProof, uploadRevokeMessage('https://other.example.test', revokeTs)), /verification failed/);
  verifier.verify(revokeProof, uploadRevokeMessage(site, revokeTs));
  policy = setUploadRemember(overlay, site, false);
  assert.equal(check().outcome, 'hold', 'ASSERT_UPLOAD_REVOKED');
  assert.ok(policy.uploads?.remember.includes('https://second.example.test:8443'));
  assert.throws(() => verifier.verify(revokeProof, uploadRevokeMessage(site, revokeTs)), /already used/);
  for (const invalid of [site + '/', site + '/settings', 'http://github.com', 'https://mail.google.com', 'https://user:password@github.com', '*', 42]) {
    assert.throws(() => setUploadRemember(overlay, invalid, true), /invalid/, 'ASSERT_UPLOAD_INVALID_SITE');
    fs.writeFileSync(path.join(home, 'invalid.json'), JSON.stringify({ uploads: { remember: [invalid] } }));
    assert.throws(() => loadPolicy({ overlay: path.join(home, 'invalid.json'), off: false }), /invalid/i);
  }
  pass('signed revoke binds exact origin, removes only that site and rejects replay; malformed or refused stored sites fail validation');

  const failed = hold(), failedTs = Date.now(), failedProof = sign(approvalMessage('grant', failed, failedTs, true), failedTs);
  const before = fs.readFileSync(overlay, 'utf8'), rename = fs.renameSync;
  fs.renameSync = () => { throw new Error('fixture write failure'); };
  try { assert.throws(() => grant(failed, failedProof), /fixture write failure/); }
  finally { fs.renameSync = rename; }
  assert.equal(failed.status, 'pending', 'ASSERT_UPLOAD_SAVE_BEFORE_RESOLVE');
  assert.equal(fs.readFileSync(overlay, 'utf8'), before);
  assert.throws(() => grant(failed, failedProof), /already used/);
  assert.equal(fs.readdirSync(home).some(name => name.endsWith('.tmp')), false);
  pass('failed atomic save leaves approval pending and policy unchanged, cleans its temporary file and consumes proof');

  for (const file of ['.env', 'id_ed25519', 'login.keychain-db', 'credentials.json', '.ssh/id_rsa',
    'Library/Application Support/Google/Chrome/Default/Cookies', 'Library/Application Support/1Password/data']) {
    const target = path.join(home, 'files', file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, 'fixture');
    assert.throws(() => readUpload(target, { home: path.join(home, 'files'), temp: [] }), /upload refused/, 'ASSERT_UPLOAD_REFUSED_FILE');
  }
  pass('keys, keychains, .env, credentials, browser profiles and 1Password data retain file refusal');
  console.log(`== upload remember: ${passed} passed, 0 failed`);
} finally {
  approvals.stop(); fs.rmSync(home, { recursive: true, force: true }); // Only this disposable fixture.
}
