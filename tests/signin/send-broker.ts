// Real daemon handlers with an in-memory socket boundary. No OS socket, browser or Secure Enclave.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { approvalMessage, sendRevokeMessage } from '../../daemon/proof.ts';
import type { StoredApproval } from '../../daemon/approvals.ts';
import type { SendRule } from '../../daemon/policy.ts';
import type { BrokerParams, ChromeRequest, Reply } from '../../shared/protocol.ts';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gaddi-send-wire-'));
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
    conn.emit('data', JSON.stringify({ id, method, params: { caller: 'send-fixture', ...params } }) + '\n');
  });
}
async function result(method: string, params: BrokerParams = {}) {
  const reply = await call(method, params); assert.equal(reply.error, undefined, JSON.stringify(reply)); return reply.result;
}
const sign = (message: string, ts: number) => ({ ts, sig: crypto.sign('sha256', Buffer.from(message), privateKey).toString('base64') });
const site = 'https://chat.example.test:8443';
let page = site + '/chat', name = 'Send', submitName = 'Send', href = '';
const rule: SendRule = { site, kind: 'press', reason: 'enter-submits:send' };
const clickRule: SendRule = { site, kind: 'click', reason: 'verb:send' };
const dispatched: string[] = [];
const typed: ChromeRequest[] = [];
try {
  await import('../../daemon/daemon.ts');
  const bridge = socket();
  bridge.onWrite = line => {
    const request = JSON.parse(line) as ChromeRequest;
    if (request.id === 'attach') return;
    let value: unknown = {};
    if (request.method === 'chrome.tabs') value = { tabs: [{ id: 7, url: page, title: 'Fixture' }] };
    else if (request.method === 'chrome.describe') value = { name, submitName, href, tag: 'BUTTON', type: 'text', autocomplete: '', selector: '@abcdef:1' };
    else if (request.method === 'chrome.type') { typed.push(request); value = { typed: true }; }
    else if (request.method === 'chrome.press') { dispatched.push('press'); value = { pressed: true }; }
    else if (request.method === 'chrome.click') { dispatched.push('click'); value = { clicked: true }; }
    queueMicrotask(() => bridge.emit('data', JSON.stringify({ id: request.id, result: value }) + '\n'));
  };
  bridge.emit('data', JSON.stringify({ id: 'attach', method: 'bridge.attach', params: { kind: 'chrome' } }) + '\n');
  assert.deepEqual(await result('sends.remembered'), { rules: [] });
  assert.deepEqual(await result('type', { tab: 7, selector: '#editor', text: ' suffix', mode: 'append' }), { typed: true });
  assert.equal(typed[0].params.mode, 'append', 'ASSERT_APPEND_BROKER');
  assert.equal(typed[0].params.text, ' suffix', 'ASSERT_APPEND_BROKER');
  assert.deepEqual(await result('type', { tab: 7, selector: '#editor', text: 'replacement' }), { typed: true });
  assert.equal(typed[1].params.mode, undefined, 'ASSERT_APPEND_BROKER');
  assert.match((await call('type', { tab: 7, selector: '#editor', text: 'text', mode: 'invalid' as 'append' })).error?.message || '', /mode/, 'ASSERT_APPEND_BROKER');
  assert.equal(typed.length, 2, 'ASSERT_APPEND_BROKER');
  console.log('PASS ASSERT_APPEND_BROKER');
  async function held(kind = 'press') {
    const reply = await call(kind, { tab: 7, ...(kind === 'press' ? { key: 'Enter' } : { selector: '@abcdef:1' }) });
    assert.equal(reply.error?.code, 'held', 'ASSERT_SEND_WIRE_HELD');
    const list = await result('approvals.list') as { pending: StoredApproval[] };
    const approval = list.pending.find(a => a.id === reply.error?.approval?.id); assert.ok(approval); return approval;
  }
  const approval = await held(); assert.equal(approval.rememberable, true, 'ASSERT_SEND_WIRE_REMEMBERABLE'); assert.equal(approval.site, site);
  assert.equal((await call('approval.grant', { id: String(approval.id), remember: true })).error?.code, 'proof-invalid');
  const ts = Date.now();
  const proof = sign(approvalMessage('grant', approval, ts, true), ts);
  assert.equal((await call('approval.grant', { id: String(approval.id), remember: false, proof })).error?.code, 'proof-invalid');
  await result('approval.grant', { id: String(approval.id), remember: true, proof });
  assert.deepEqual(await result('sends.remembered'), { rules: [rule] });
  assert.deepEqual(await result('press', { tab: 7, key: 'Enter', approval: String(approval.id) }), { pressed: true });
  assert.deepEqual(await result('press', { tab: 7, key: 'Enter' }), { pressed: true }, 'ASSERT_SEND_WIRE_REMEMBERED');
  const click = await held('click'); assert.equal(click.reason, clickRule.reason);
  for (const suffix of ['/payment', '/settings/security', '/delete-account', '/chat?next=/security', '/chat#/checkout']) {
    page = site + suffix; const blocked = await held(); assert.equal(blocked.rememberable, undefined, 'ASSERT_SEND_WIRE_PROTECTED');
    assert.equal(blocked.site, undefined);
    assert.equal((await call('approval.grant', { id: String(blocked.id), remember: true })).error?.code, 'approval-invalid');
  }
  page = site + '/chat'; submitName = 'Send and delete';
  assert.equal((await held()).rememberable, undefined); submitName = 'Send';
  page = 'https://other.example.test/chat'; assert.equal((await held()).site, 'https://other.example.test');
  page = 'https://mail.google.com/mail';
  assert.equal((await call('press', { tab: 7, key: 'Enter' })).error?.code, 'denied');
  assert.equal((await call('click', { tab: 7, selector: '@abcdef:1' })).error?.code, 'denied');
  page = site + '/chat'; name = 'Send'; href = site + '/payment';
  assert.equal((await held('click')).rememberable, undefined); href = '';
  assert.equal((await call('sends.revoke', rule)).error?.code, 'proof-invalid');
  const revokeTs = Date.now(), revokeProof = sign(sendRevokeMessage(rule, revokeTs), revokeTs);
  assert.equal((await call('sends.revoke', { ...clickRule, proof: revokeProof })).error?.code, 'proof-invalid');
  await result('sends.revoke', { ...rule, proof: revokeProof });
  assert.deepEqual(await result('sends.remembered'), { rules: [] }); await held();
  assert.equal((await call('sends.revoke', { ...rule, proof: revokeProof })).error?.code, 'proof-invalid');
  assert.deepEqual(dispatched, ['press', 'press']);
  console.log('PASS real daemon NDJSON grant/list/revoke handlers dispatch only owner-remembered exact sends; protected query/hash, Gmail and other holds remain gated');
  console.log('== send broker in-memory transport: 1 passed, 0 failed');
} finally {
  Object.defineProperty(net, 'createServer', { configurable: true, value: createServer });
  for (const conn of sockets) conn.destroy();
  fs.rmSync(home, { recursive: true, force: true }); // Only the disposable daemon fixture.
}
