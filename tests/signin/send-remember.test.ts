// Production gates and real daemon, disposable software proofs and bridge. No Chrome or keychain.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createApprovals, publicView } from '../../daemon/approvals.ts';
import { approvalMessage, createProofVerifier, sendRevokeMessage } from '../../daemon/proof.ts';
import { checkClick, checkPress, checkRememberedSend, checkUpload, loadPolicy, setSendRemember, sendRule, hostOf } from '../../daemon/policy.ts';
import type { SendRule } from '../../daemon/policy.ts';
import type { StoredApproval } from '../../daemon/approvals.ts';
import type { BrokerParams, ChromeRequest, Reply } from '../../shared/protocol.ts';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gaddi-send-'));
const overlay = path.join(home, 'policy.json'), publicKeyPath = path.join(home, 'approver.pub');
const site = 'https://chat.example.test:8443', url = site + '/chat';
const rule: SendRule = { site, kind: 'press', reason: 'enter-submits:send' };
const clickRule: SendRule = { site, kind: 'click', reason: 'verb:send' };
const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
fs.writeFileSync(publicKeyPath, publicKey.export({ type: 'spki', format: 'pem' }));
let policy = loadPolicy({ overlay, off: false });
const verifier = createProofVerifier({ publicKeyPath, usedPath: path.join(home, 'used.log') });
const approvals = createApprovals({});
let passed = 0;
const pass = (name: string) => { passed++; console.log(`PASS ${name}`); };
const sign = (message: string, ts: number) => ({ ts, sig: crypto.sign('sha256', Buffer.from(message), privateKey).toString('base64') });
const check = (page = url, kind = 'press', name = 'Send', destination = '') => checkRememberedSend(policy, page, kind,
  kind === 'press' ? checkPress(policy, hostOf(page), 'Enter', name) : checkClick(policy, hostOf(page), name), name, destination);
const hold = () => approvals.hold({ kind: 'press', caller: 'test', tab: 7, url, detail: 'Enter',
  reason: rule.reason, rememberable: check().rememberable, action: { caller: 'test', method: 'press', url, key: 'Enter', nonce: crypto.randomUUID() } });
const grant = (a: StoredApproval, proof: unknown, remember: unknown = true) => approvals.signed(a.id, 'grant', proof, verifier, approvalMessage,
  { remember, onRemember: (_origin, send) => { assert.ok(send); policy = setSendRemember(overlay, send, true); } });
let daemon: ReturnType<typeof spawn> | undefined;
const connections = new Set<net.Socket>();
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
try {
  assert.deepEqual(policy.sends?.remember, []);
  const initial = check();
  assert.equal(initial.outcome, 'hold'); assert.equal(initial.rememberable, true, 'ASSERT_SEND_REMEMBERABLE');
  const a = hold(); assert.equal(publicView(a).site, site);
  const ts = Date.now(), proof = sign(approvalMessage('grant', a, ts, true), ts);
  assert.throws(() => grant(a, undefined), /signed proof/);
  assert.throws(() => grant(a, sign(approvalMessage('grant', a, ts), ts)), /verification failed/);
  assert.throws(() => grant(a, proof, false), /verification failed/);
  assert.throws(() => grant(a, proof, 'true'), /boolean/);
  const oldReason = a.reason; a.reason = 'enter-submits:send now';
  assert.throws(() => grant(a, proof), /verification failed/); a.reason = oldReason;
  const oldKind = a.kind; a.kind = 'click'; a.reason = 'verb:send';
  assert.throws(() => grant(a, proof), /verification failed/); a.kind = oldKind; a.reason = oldReason;
  const oldURL = a.url; a.url = 'https://other.example.test/chat';
  assert.throws(() => grant(a, proof), /verification failed/); a.url = oldURL;
  assert.equal(fs.existsSync(overlay), false); assert.equal(a.status, 'pending');
  pass('default empty list and eligible metadata; unsigned, once-to-always, origin/kind/reason tampering fail closed');
  grant(a, proof);
  assert.equal(check().outcome, 'allow', 'ASSERT_SEND_RULE_APPLIED');
  assert.deepEqual(JSON.parse(fs.readFileSync(overlay, 'utf8')), { sends: { remember: [rule] } });
  assert.equal(fs.statSync(overlay).mode & 0o777, 0o600);
  policy = loadPolicy({ overlay, off: false });
  assert.equal(check().outcome, 'allow');
  for (const page of ['https://chat.example.test/chat', 'https://chat.example.test:8444/chat', 'https://sub.chat.example.test:8443/chat']) {
    assert.equal(check(page).outcome, 'hold');
  }
  assert.equal(check(url, 'click').outcome, 'hold');
  assert.equal(check(url, 'press', 'Send now').outcome, 'hold');
  assert.throws(() => createProofVerifier({ publicKeyPath, usedPath: path.join(home, 'used.log') }).verify(proof, approvalMessage('grant', a, ts, true)), /already used/);
  pass('signed grant persists privately, reloads, matches exact origin/kind/reason, and rejects replay after restart');
  for (const page of [site + '/payment', site + '/settings/security', site + '/delete-account', site + '/checkout']) {
    assert.equal(check(page).outcome, 'hold'); assert.equal(check(page).rememberable, undefined);
    assert.equal(sendRule(page, rule.kind, rule.reason), undefined, 'ASSERT_PROTECTED_PAGE_INELIGIBLE');
  }
  for (const name of ['Send and pay now', 'Send and delete', 'Send and change password']) {
    assert.equal(check(url, 'click', name).outcome, 'hold'); assert.equal(check(url, 'click', name).rememberable, undefined);
  }
  assert.equal(check('https://mail.google.com/mail', 'click').outcome, 'deny');
  assert.equal(sendRule('https://mail.google.com', 'press', rule.reason), undefined);
  assert.equal(checkUpload(policy).outcome, 'hold');
  const upload = approvals.hold({ kind: 'upload', caller: 'test', url, detail: 'file', reason: rule.reason,
    rememberable: true, action: { method: 'upload', caller: 'test', url } });
  assert.throws(() => grant(upload, proof), /eligible send/);
  assert.equal(publicView(upload).site, undefined);
  const security = { ...a, id: 'security', url: site + '/settings/security', status: 'pending' };
  assert.throws(() => approvalMessage('grant', security, Date.now(), true), /eligible send/);
  assert.equal(check(url, 'click', 'Send', site + '/checkout').rememberable, undefined);
  pass('protected pages/destinations, destructive mixed labels, Gmail, uploads and other kinds never inherit a send exception');
  policy = setSendRemember(overlay, clickRule, true);
  assert.equal(check(url, 'click').outcome, 'allow');
  fs.writeFileSync(overlay, JSON.stringify({ hold: { url_patterns: ['/sensitive'] }, sends: { remember: [rule, clickRule] } }));
  policy = loadPolicy({ overlay, off: false });
  assert.equal(check(site + '/sensitive').outcome, 'hold');
  assert.equal(check(url, 'click', 'Send', site + '/sensitive').rememberable, undefined);
  const revokeTs = Date.now(), revokeProof = sign(sendRevokeMessage(rule, revokeTs), revokeTs);
  assert.throws(() => verifier.verify(revokeProof, sendRevokeMessage(clickRule, revokeTs)), /verification failed/);
  verifier.verify(revokeProof, sendRevokeMessage(rule, revokeTs));
  policy = setSendRemember(overlay, rule, false);
  assert.equal(check().outcome, 'hold'); assert.equal(check(url, 'click').outcome, 'allow');
  assert.deepEqual(JSON.parse(fs.readFileSync(overlay, 'utf8')).hold, { url_patterns: ['/sensitive'] });
  assert.throws(() => verifier.verify(revokeProof, sendRevokeMessage(rule, revokeTs)), /already used/);
  for (const invalid of [{ ...rule, site: site + '/' }, { ...rule, kind: 'upload' }, { ...rule, reason: 'enter-submits:pay' },
    { ...rule, kind: 'click' }, { ...rule, site: 'https://mail.google.com' }]) {
    assert.throws(() => setSendRemember(overlay, invalid as SendRule, true), /invalid/);
  }
  pass('signed revoke binds entire tuple and preserves other rules; custom protected URLs and invalid scopes remain gated');
  policy = setSendRemember(overlay, clickRule, false);
  const failed = hold(), failedTs = Date.now(), failedProof = sign(approvalMessage('grant', failed, failedTs, true), failedTs);
  const before = fs.readFileSync(overlay, 'utf8'), rename = fs.renameSync;
  fs.renameSync = () => { throw new Error('fixture write failure'); };
  try { assert.throws(() => grant(failed, failedProof), /fixture write failure/); }
  finally { fs.renameSync = rename; }
  assert.equal(failed.status, 'pending'); assert.equal(fs.readFileSync(overlay, 'utf8'), before);
  assert.throws(() => grant(failed, failedProof), /already used/);
  assert.equal(fs.readdirSync(home).some(file => file.endsWith('.tmp')), false);
  pass('failed durable policy save preserves pending hold and existing policy and consumes the proof');

  // Exercise actual RPC wiring and bridge dispatch; no externally managed daemon.
  fs.writeFileSync(overlay, '{}');
  const socket = path.join(home, 'broker.sock');
  const env = { ...process.env, GADDI_HOME: home, GADDI_SOCKET: socket, GADDI_APPROVER_PUB: publicKeyPath,
    GADDI_POLICY_OFF: '0', GADDI_APP_LAUNCHER: '/usr/bin/true', GADDI_AUDIT: path.join(home, 'audit.jsonl'),
    GADDI_STATE: path.join(home, 'state.json'), OMNIREAD_BIN: path.join(home, 'missing-reader') };
  daemon = spawn(process.execPath, [path.resolve(import.meta.dirname, '../../daemon/daemon.mjs')], { env });
  let stderr = ''; daemon.stderr!.on('data', chunk => { stderr += chunk; }); daemon.stdout!.resume();
  for (let n = 0; n < 100 && !fs.existsSync(socket) && daemon.exitCode === null; n++) await delay(20);
  if (!fs.existsSync(socket) && /EPERM|operation not permitted/i.test(stderr)) {
    console.log('SKIP remembered-send broker: sandbox refused private Unix socket listen (EPERM)');
  } else {
    assert.ok(fs.existsSync(socket), 'Broker did not start: ' + stderr);
    function connect() { const conn = net.connect(socket); connections.add(conn); conn.setEncoding('utf8'); conn.on('error', () => {}); return conn; }
    function call(method: string, params: BrokerParams = {}): Promise<Reply> {
      const conn = connect(), id = crypto.randomUUID();
      return new Promise((resolve, reject) => {
        let buffer = ''; const timer = setTimeout(() => { conn.destroy(); reject(new Error('RPC timeout: ' + method)); }, 5000);
        conn.on('connect', () => conn.write(JSON.stringify({ id, method, params: { caller: 'test', ...params } }) + '\n'));
        conn.on('error', error => { clearTimeout(timer); reject(error); });
        conn.on('data', chunk => { buffer += chunk; const end = buffer.indexOf('\n'); if (end < 0) return;
          clearTimeout(timer); conn.destroy(); resolve(JSON.parse(buffer.slice(0, end)) as Reply); });
      });
    }
    async function result(method: string, params: BrokerParams = {}) { const reply = await call(method, params); assert.equal(reply.error, undefined); return reply.result; }
    let page = url, name = 'Send', focus = 'Send'; const bridgeCalls: string[] = [];
    const bridge = connect(); let buffer = '';
    bridge.on('connect', () => bridge.write(JSON.stringify({ id: 'attach', method: 'bridge.attach', params: { kind: 'chrome' } }) + '\n'));
    bridge.on('data', chunk => { buffer += chunk; let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const request = JSON.parse(buffer.slice(0, end)) as ChromeRequest; buffer = buffer.slice(end + 1);
        if (request.id === 'attach') continue;
        bridgeCalls.push(request.method);
        const value = request.method === 'chrome.tabs' ? { tabs: [{ id: 7, url: page, title: 'Fixture' }] }
          : request.method === 'chrome.describe' ? { name, tag: 'BUTTON', href: '', selector: '@abcdef:1', submitName: focus }
          : request.method === 'chrome.press' ? { pressed: true }
          : request.method === 'chrome.click' ? { clicked: true } : {};
        bridge.write(JSON.stringify({ id: request.id, result: value }) + '\n');
      }
    });
    for (let n = 0; n < 100; n++) { const status = await result('bridge.status') as { connected?: boolean }; if (status.connected) break; await delay(10); }
    const getHold = async (kind: string) => {
      const reply = await call(kind, { tab: 7, ...(kind === 'press' ? { key: 'Enter' } : { selector: '@abcdef:1' }) });
      assert.equal(reply.error?.code, 'held'); const list = await result('approvals.list') as { pending: StoredApproval[] };
      const approval = list.pending.find(a => a.id === reply.error?.approval?.id); assert.ok(approval); return approval;
    };
    const remembered = await getHold('press'); assert.equal(remembered.site, site); assert.equal(remembered.rememberable, true);
    assert.equal((await call('approval.grant', { id: String(remembered.id), remember: true })).error?.code, 'proof-invalid');
    const grantTs = Date.now();
    await result('approval.grant', { id: String(remembered.id), remember: true, proof: sign(approvalMessage('grant', remembered, grantTs, true), grantTs) });
    assert.deepEqual(await result('sends.remembered'), { rules: [rule] });
    assert.deepEqual(await result('press', { tab: 7, key: 'Enter', approval: String(remembered.id) }), { pressed: true });
    assert.deepEqual(await result('press', { tab: 7, key: 'Enter' }), { pressed: true }, 'ASSERT_BROKER_REMEMBERED_SEND');
    const heldClick = await getHold('click'); assert.equal(heldClick.reason, 'verb:send');
    for (const target of [site + '/settings/security', site + '/payment', 'https://other.example.test/chat']) {
      page = target; const protectedHold = await getHold('press'); assert.equal(protectedHold.rememberable, target.includes('other.') ? true : undefined);
    }
    page = site + '/settings/security'; const protectedHold = await getHold('press');
    assert.equal((await call('approval.grant', { id: String(protectedHold.id), remember: true })).error?.code, 'approval-invalid');
    page = 'https://mail.google.com/mail';
    assert.equal((await call('press', { tab: 7, key: 'Enter' })).error?.code, 'denied');
    assert.equal((await call('click', { tab: 7, selector: '@abcdef:1' })).error?.code, 'denied');
    page = url; focus = 'Send and delete';
    const destructive = await getHold('press'); assert.equal(destructive.rememberable, undefined); focus = 'Send';
    assert.equal((await call('sends.revoke', rule)).error?.code, 'proof-invalid');
    const rpcTs = Date.now(), rpcProof = sign(sendRevokeMessage(rule, rpcTs), rpcTs);
    assert.equal((await call('sends.revoke', { ...clickRule, proof: rpcProof })).error?.code, 'proof-invalid');
    await result('sends.revoke', { ...rule, proof: rpcProof });
    assert.deepEqual(await result('sends.remembered'), { rules: [] }); await getHold('press');
    assert.equal((await call('sends.revoke', { ...rule, proof: rpcProof })).error?.code, 'proof-invalid');
    assert.equal(bridgeCalls.filter(method => method === 'chrome.press').length, 2);
    assert.equal(bridgeCalls.filter(method => method === 'chrome.click').length, 0);
    pass('real broker signed grant/list/revoke wires correctly; only exact remembered sends dispatch, protected/other actions stay gated');
  }
  console.log(`== send remember: ${passed} passed, 0 failed`);
} finally {
  approvals.stop(); for (const connection of connections) connection.destroy();
  if (daemon) { daemon.kill('SIGTERM'); if (daemon.exitCode === null && daemon.signalCode === null) await once(daemon, 'exit'); }
  fs.rmSync(home, { recursive: true, force: true }); // Only this test's disposable fixture.
}
