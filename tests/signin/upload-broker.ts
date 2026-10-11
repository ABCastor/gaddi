// Real daemon handlers with an in-memory socket boundary. No OS socket, browser or Secure Enclave.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { approvalMessage, uploadRevokeMessage } from '../../daemon/proof.ts';
import type { StoredApproval } from '../../daemon/approvals.ts';
import type { BrokerParams, ChromeRequest, Reply } from '../../shared/protocol.ts';

const state = path.resolve(import.meta.dirname, '../.state'); fs.mkdirSync(state, { recursive: true });
const home = fs.mkdtempSync(path.join(state, 'upload-wire-'));
const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
fs.writeFileSync(path.join(home, 'approver.pub'), publicKey.export({ type: 'spki', format: 'pem' }));
Object.assign(process.env, { GADDI_HOME: home, GADDI_SOCKET: path.join(home, 'socket.fixture'), GADDI_POLICY_OFF: '0',
  GADDI_APPROVER_PUB: path.join(home, 'approver.pub'), GADDI_STATE: path.join(home, 'state.json'),
  GADDI_AUDIT: path.join(home, 'audit.jsonl'), GADDI_APP_LAUNCHER: '/usr/bin/true' });
class FixtureSocket extends EventEmitter {
  destroyed = false;
  onWrite: (line: string) => void = () => {};
  setEncoding() { return this; }
  write(line: string) { queueMicrotask(() => { if (!this.destroyed) this.onWrite(line); }); return true; }
  destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('close'); } return this; }
}
let accept: (conn: FixtureSocket) => void;
const server = new EventEmitter();
Object.assign(server, {
  listen(file: string, ready: () => void) { fs.writeFileSync(file, 'fixture'); ready(); return server; },
  close(done: () => void) { done(); return server; },
});
const createServer = net.createServer;
Object.defineProperty(net, 'createServer', { configurable: true, value: (handler: typeof accept) => { accept = handler; return server; } });
const sockets = new Set<FixtureSocket>();
function socket() { const conn = new FixtureSocket(); sockets.add(conn); accept(conn); return conn; }
function call(method: string, params: BrokerParams = {}): Promise<Reply> {
  const conn = socket(), id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { conn.destroy(); reject(new Error('Fixture RPC timed out')); }, 3000);
    conn.onWrite = line => {
      const reply = JSON.parse(line) as Reply; if (reply.id !== id) return;
      clearTimeout(timer); conn.destroy(); resolve(reply);
    };
    conn.emit('data', JSON.stringify({ id, method, params: { caller: 'upload-fixture', ...params } }) + '\n');
  });
}
async function result(method: string, params: BrokerParams = {}) {
  const reply = await call(method, params); assert.equal(reply.error, undefined, JSON.stringify(reply)); return reply.result;
}
const sign = (message: string, ts: number) => ({ ts, sig: crypto.sign('sha256', Buffer.from(message), privateKey).toString('base64') });
const site = 'https://github.com';
let page = site + '/ABCastor/gaddi/settings';
const image = path.join(home, 'preview.png'); fs.writeFileSync(image, 'fixture image');
const dispatched: ChromeRequest[] = [], events: string[] = [];
let passed = 0;
const pass = (name: string) => { passed++; console.log(`PASS ${name}`); };
try {
  await import('../../daemon/daemon.ts');
  const bridge = socket();
  bridge.onWrite = line => {
    const request = JSON.parse(line) as ChromeRequest;
    if (request.id === 'attach') return;
    let value: unknown = {};
    if (request.method === 'chrome.tabs') value = { tabs: [{ id: 7, url: page, title: 'Fixture' }] };
    else if (request.method === 'chrome.describe') value = { name: 'Upload preview', tag: 'INPUT', type: 'file', selector: '@abcdef:1' };
    else if (request.method === 'chrome.uploadChunk' || request.method === 'chrome.upload') {
      dispatched.push(request); if (request.method === 'chrome.upload') value = { uploaded: true };
    }
    queueMicrotask(() => bridge.emit('data', JSON.stringify({ id: request.id, result: value }) + '\n'));
  };
  bridge.emit('data', JSON.stringify({ id: 'attach', method: 'bridge.attach', params: { kind: 'chrome' } }) + '\n');
  const subscriber = socket(); subscriber.onWrite = line => {
    const message = JSON.parse(line); if (message.event) events.push(message.event);
  };
  subscriber.emit('data', JSON.stringify({ id: 'subscribe', method: 'events.subscribe', params: {} }) + '\n');
  const uploadParams = { tab: 7, selector: '@abcdef:1', path: image };
  async function held() {
    const reply = await call('upload', uploadParams);
    assert.equal(reply.error?.code, 'held', 'ASSERT_UPLOAD_WIRE_HELD');
    const list = await result('approvals.list') as { pending: StoredApproval[] };
    const approval = list.pending.find(a => a.id === reply.error?.approval?.id); assert.ok(approval); return approval;
  }
  assert.deepEqual(await result('uploads.remembered'), { sites: [] });
  const approval = await held();
  assert.equal(approval.rememberable, true, 'ASSERT_UPLOAD_WIRE_REMEMBERABLE'); assert.equal(approval.site, site);
  assert.equal((await call('approval.grant', { id: String(approval.id), remember: true })).error?.code, 'proof-invalid', 'ASSERT_UPLOAD_WIRE_FORGED');
  const ts = Date.now(), once = sign(approvalMessage('grant', approval, ts), ts);
  assert.equal((await call('approval.grant', { id: String(approval.id), remember: true, proof: once })).error?.code, 'proof-invalid');
  const attacker = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const forged = { ts, sig: crypto.sign('sha256', Buffer.from(approvalMessage('grant', approval, ts, true)), attacker.privateKey).toString('base64') };
  assert.equal((await call('approval.grant', { id: String(approval.id), remember: true, proof: forged })).error?.code, 'proof-invalid');
  assert.deepEqual(await result('uploads.remembered'), { sites: [] }); assert.equal(dispatched.length, 0);
  pass('real daemon exposes exact upload site and rejects unsigned, once-to-always and attacker-key remember requests');
  const grantTs = Date.now();
  await result('approval.grant', { id: String(approval.id), remember: true, proof: sign(approvalMessage('grant', approval, grantTs, true), grantTs) });
  assert.deepEqual(await result('uploads.remembered'), { sites: [site] }, 'ASSERT_UPLOAD_WIRE_PERSISTED');
  assert.deepEqual(await result('upload', { ...uploadParams, approval: String(approval.id) }), { uploaded: true });
  const future = await call('upload', uploadParams);
  assert.equal(future.error, undefined, 'ASSERT_UPLOAD_WIRE_REMEMBERED'); assert.deepEqual(future.result, { uploaded: true });
  assert.equal(dispatched.filter(r => r.method === 'chrome.upload').length, 2);
  assert.deepEqual(await result('sends.remembered'), { rules: [] }); assert.deepEqual(await result('signin.remembered'), { sites: [] });
  const audit = fs.readFileSync(path.join(home, 'audit.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.ok(audit.some(row => row.method === 'upload' && row.outcome === 'allow' && !row.approval
    && row.reason === 'owner remembered uploads on this site'), 'ASSERT_UPLOAD_WIRE_AUDIT');
  assert.ok(events.includes('uploads.remembered'), 'ASSERT_UPLOAD_WIRE_EVENT');
  pass('signed remember persists via RPC, retries exact file, waives future uploads, emits list changes and audits its reason');
  for (const target of [site + '/security', site + '/settings/security', site + '/settings?next=/security', site + '/settings#/checkout', 'https://mail.google.com/mail']) {
    page = target; const blocked = await held();
    assert.equal(blocked.rememberable, undefined, 'ASSERT_UPLOAD_WIRE_PROTECTED'); assert.equal(blocked.site, undefined);
    assert.equal((await call('approval.grant', { id: String(blocked.id), remember: true })).error?.code, 'approval-invalid');
  }
  for (const target of ['https://other.example.test/settings', 'https://github.com:8443/settings', 'https://sub.github.com/settings']) {
    page = target; const blocked = await held(); assert.equal(blocked.rememberable, true);
  }
  page = site + '/ABCastor/gaddi/settings';
  const refused = path.join(home, '.env'); fs.writeFileSync(refused, 'fixture');
  assert.equal((await call('upload', { ...uploadParams, path: refused })).error?.code, 'denied', 'ASSERT_UPLOAD_WIRE_FILE_REFUSED');
  assert.equal(dispatched.filter(r => r.method === 'chrome.upload').length, 2);
  pass('protected pages including query/hash and refused hosts stay held; other origins stay held and refused files never dispatch');
  assert.equal((await call('uploads.revoke', { site })).error?.code, 'proof-invalid');
  const revokeTs = Date.now(), revokeProof = sign(uploadRevokeMessage(site, revokeTs), revokeTs);
  assert.equal((await call('uploads.revoke', { site: 'https://other.example.test', proof: revokeProof })).error?.code, 'proof-invalid');
  await result('uploads.revoke', { site, proof: revokeProof });
  assert.deepEqual(await result('uploads.remembered'), { sites: [] }, 'ASSERT_UPLOAD_WIRE_REVOKE'); await held();
  assert.equal((await call('uploads.revoke', { site, proof: revokeProof })).error?.code, 'proof-invalid');
  assert.equal(events.filter(event => event === 'uploads.remembered').length, 2);
  pass('signed revoke binds exact origin, updates the list and event, restores the hold and rejects replay');
  console.log(`== upload broker in-memory transport: ${passed} passed, 0 failed`);
} finally {
  Object.defineProperty(net, 'createServer', { configurable: true, value: createServer });
  for (const conn of sockets) conn.destroy();
  fs.rmSync(home, { recursive: true, force: true }); // Only this disposable fixture.
}
