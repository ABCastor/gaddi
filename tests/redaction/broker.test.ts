// Real broker/MCP/CLI, synthetic OAuth callback, fake Chrome. Never an owner session.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { isRecord } from '../../shared/protocol.ts';
import type { BrokerParams, ChromeRequest, Reply } from '../../shared/protocol.ts';
import { approvalMessage } from '../../daemon/proof.ts';

const repo = path.resolve(import.meta.dirname, '../..');
const home = fs.mkdtempSync(path.join(repo, 'tests/.state/redaction-'));
const socket = path.join(os.tmpdir(), `gaddi-url-redaction-${process.pid}.sock`);
const params = new URLSearchParams({ page: '2' });
const markers = ['code', 'state', 'id_token', 'access_token', 'token', 'sig', 'key', 'password', 'session']
  .map((name, i) => { const value = `SYNTHETIC_CALLBACK_${i}_${crypto.randomUUID()}`; params.set(name, value); return value; });
const callback = `https://fixture.example/callback?${params}#access_token=${markers[3]}&state=${markers[1]}`;
const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
fs.writeFileSync(path.join(home, 'approver.pub'), publicKey.export({ type: 'spki', format: 'pem' }));
const legacy = { id: 'abcdef0123456789', kind: 'click', caller: `legacy ${callback}`, tab: 7, url: callback,
  detail: `legacy ${callback}`, reason: `legacy ${callback}`, actionHash: 'a'.repeat(64), status: 'pending',
  createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600000).toISOString() };
for (const name of ['state.json', 'state.json.tmp']) fs.writeFileSync(path.join(home, name), JSON.stringify({ approvals: [legacy] }));
for (const name of ['audit.jsonl', 'audit.jsonl.1']) fs.writeFileSync(path.join(home, name), JSON.stringify({ url: callback, caller: `old ${callback}` }) + '\n');
const env = { ...process.env, GADDI_HOME: home, GADDI_SOCKET: socket, GADDI_APP_LAUNCHER: '/usr/bin/true',
  GADDI_AUDIT: path.join(home, 'audit.jsonl'), GADDI_STATE: path.join(home, 'state.json'),
  GADDI_APPROVER_PUB: path.join(home, 'approver.pub'), GADDI_REMOTE_KEY: path.join(home, 'missing-remote-key'),
  OMNIREAD_BIN: path.join(home, 'missing-omniread'), GADDI_POLICY_OFF: '0' };
const entry = process.argv[2] ? path.resolve(process.argv[2]) : path.join(repo, 'daemon/daemon.mjs');
const daemon = spawn(process.execPath, [entry], { env, stdio: ['ignore', 'ignore', 'pipe'] });
let stderr = '', passed = 0, failed = 0, evalError = false;
daemon.stderr.on('data', chunk => { stderr += chunk; });
const clients = new Set<net.Socket>();
let bridge: net.Socket | undefined, mcp: Client | undefined;
const events: unknown[] = [], forwarded: ChromeRequest[] = [];
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const safe = (value: unknown) => {
  const serialized = JSON.stringify(value);
  assert.ok(markers.every(marker => !serialized.includes(marker)), 'ASSERT_URL_REDACTION: synthetic callback credential escaped');
};
async function check(name: string, fn: () => unknown | Promise<unknown>) {
  try { await fn(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failed++; console.log(`FAIL ${name}: ${error instanceof Error ? error.message : 'assertion'}`); }
}
function call(method: string, args: BrokerParams = {}): Promise<Reply> {
  const conn = net.connect(socket); clients.add(conn); conn.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let buffer = ''; const id = crypto.randomUUID();
    const timer = setTimeout(() => { conn.destroy(); reject(new Error('redaction fixture RPC timeout')); }, 10000);
    conn.once('connect', () => conn.write(JSON.stringify({ id, method, params: { caller: 'redaction-test', ...args } }) + '\n'));
    conn.once('error', error => { clearTimeout(timer); reject(error); });
    conn.on('data', chunk => { buffer += chunk; const end = buffer.indexOf('\n'); if (end < 0) return;
      clearTimeout(timer); conn.destroy(); resolve(JSON.parse(buffer.slice(0, end)) as Reply); });
  });
}
async function result(method: string, args: BrokerParams = {}) {
  const reply = await call(method, args); assert.equal(reply.error, undefined, `fixture ${method} must succeed`); return reply.result;
}
async function approved(method: string, args: BrokerParams) {
  let reply = await call(method, args);
  assert.equal(reply.error?.code, 'held', 'protected navigation must require signed approval');
  if (reply.error?.code === 'held') {
    const list = await result('approvals.list'); assert.ok(isRecord(list) && Array.isArray(list.pending));
    const approval = list.pending.find(a => isRecord(a) && a.id === reply.error!.approval!.id); assert.ok(isRecord(approval));
    const ts = Date.now(), sig = crypto.sign('sha256', Buffer.from(approvalMessage('grant', approval, ts, false)), privateKey).toString('base64');
    await result('approval.grant', { id: String(approval.id), proof: { ts, sig } });
    const changed = await call(method, { ...args, url: String(args.url) + '&page=99', approval: String(approval.id) });
    assert.equal(changed.error?.code, 'approval-mismatch', 'display redaction must not weaken exact query binding');
    reply = await call(method, { ...args, approval: String(approval.id) });
  }
  assert.equal(reply.error, undefined, `approved ${method}`); return reply.result;
}
try {
  for (let n = 0; n < 300 && !fs.existsSync(socket) && daemon.exitCode === null; n++) await pause(20);
  assert.ok(fs.existsSync(socket), 'fixture broker must start');
  bridge = net.connect(socket); bridge.setEncoding('utf8'); let buffer = '';
  const attached = new Promise<void>((resolve, reject) => {
    bridge!.once('error', reject);
    bridge!.on('connect', () => bridge!.write(JSON.stringify({ id: 'attach', method: 'bridge.attach', params: { kind: 'chrome' } }) + '\n'));
    bridge!.on('data', chunk => { buffer += chunk; let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const request = JSON.parse(buffer.slice(0, end)) as ChromeRequest; buffer = buffer.slice(end + 1);
        if (request.id === 'attach') { resolve(); continue; }
        forwarded.push(request);
        const tab = { id: 7, url: callback, title: `Callback ${callback}`, active: true, windowId: 1 };
        if (evalError && request.method === 'chrome.eval') {
          bridge!.write(JSON.stringify({ id: request.id, error: { message: `navigation failed ${callback}` } }) + '\n'); continue;
        }
        let value: unknown;
        switch (request.method) {
          case 'chrome.tabs': value = { tabs: [tab] }; break;
          case 'chrome.active': value = tab; break;
          case 'chrome.bookmarks': value = { bookmarks: [{ path: 'OAuth', title: callback, url: callback }] }; break;
          case 'chrome.approvalCapture': value = {}; break;
          case 'chrome.read': value = { ...tab, tab: 7, text: 'Origin/path only', outline: `a ${callback}`, frames: [{ frameId: 42, url: callback }] }; break;
          case 'chrome.eval': value = { tab: 7, url: callback, title: tab.title, value: { origin: 'https://fixture.example', path: '/callback' } }; break;
          case 'chrome.goto': case 'chrome.back': case 'chrome.wait': value = { tab: 7, url: callback, title: tab.title, met: true }; break;
          case 'chrome.html': value = { tab: 7, url: callback, html: '<p>origin/path only</p>' }; break;
          case 'chrome.click': bridge!.write(JSON.stringify({ id: request.id, error: { message: `navigation failed ${callback}` } }) + '\n'); continue;
          default: value = {};
        }
        bridge!.write(JSON.stringify({ id: request.id, result: value }) + '\n');
      }
    });
  });
  await attached;
  await check('legacy state, interrupted state write and both audit generations are scrubbed on startup', () => {
    for (const name of ['state.json', 'state.json.tmp', 'audit.jsonl', 'audit.jsonl.1']) {
      const file = path.join(home, name); safe(fs.readFileSync(file, 'utf8'));
      assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'migrated files must remain private');
    }
  });
  for (const method of ['tabs', 'bookmarks', 'look', 'eval', 'back', 'wait', 'html']) await check(`${method} envelope and nested URLs redact callback credentials`, async () => {
    const value = await result(method, method === 'eval' ? { tab: 7, expression: '({origin:location.origin,path:location.pathname})' } : method === 'wait' ? { tab: 7, url: '/callback', timeout: 0 } : { tab: 7 }); safe(value);
    if (method === 'eval') { assert.ok(isRecord(value) && isRecord(value.value)); assert.equal(value.value.path, '/callback'); }
  });
  await check('signed navigation retains exact URL internally but redacts its result', async () => {
    const target = callback.replace('/callback?', '/security/callback?');
    safe(await approved('goto', { tab: 7, url: target }));
    const request = forwarded.findLast(item => item.method === 'chrome.goto');
    assert.ok(request && request.params.url === target, 'navigation authority must keep the exact original URL');
  });
  await check('bridge error envelopes redact callback URLs', async () => {
    evalError = true;
    try { const reply = await call('eval', { tab: 7, expression: 'location.pathname' }); assert.ok(reply.error); safe(reply); }
    finally { evalError = false; }
  });
  await check('output.redact covers decoded extractor text', async () => {
    safe(await result('output.redact', { text: `extractor ${callback}` }));
  });
  await check('MCP eval/tab/look/goto/read envelopes contain no callback credentials', async () => {
    mcp = new Client({ name: 'redaction-fixture', version: '1' });
    await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(repo, 'mcp/server.mjs')], env }));
    for (const [name, args] of [['browser_tabs', {}], ['browser_eval', { tab: 7, expression: '({origin:location.origin,path:location.pathname})' }],
      ['browser_look', { tab: 7 }], ['browser_goto', { tab: 7, url: callback }], ['browser_read', { tab: 7 }]] as const) {
      const value = await mcp.callTool({ name, arguments: args }); safe(value);
    }
  });
  await check('CLI JSON output redacts callback URLs', async () => {
    const child = spawn(process.execPath, [path.join(repo, 'cli/gaddi'), '--json', 'eval', '7', '({origin:location.origin,path:location.pathname})'], { env });
    let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.resume();
    const [code] = await once(child, 'close'); assert.equal(code, 0); safe(output);
  });
  await check('approval events and persisted caller metadata redact URL credentials', async () => {
    const sub = net.connect(socket); clients.add(sub); sub.setEncoding('utf8'); let pending = '';
    sub.on('data', chunk => { pending += chunk; let end; while ((end = pending.indexOf('\n')) >= 0) {
      const event: unknown = JSON.parse(pending.slice(0, end)); pending = pending.slice(end + 1); events.push(event);
    } });
    await once(sub, 'connect'); sub.write(JSON.stringify({ id: 'subscribe', method: 'events.subscribe' }) + '\n');
    for (let n = 0; n < 100 && !events.length; n++) await pause(10);
    const reply = await call('goto', { tab: 7, url: 'https://fixture.example/security?code=' + markers[0], caller: `caller ${callback}` });
    assert.equal(reply.error?.code, 'held');
    for (let n = 0; n < 100 && !events.some(e => isRecord(e) && e.event === 'approval.pending'); n++) await pause(10);
    assert.ok(events.some(e => isRecord(e) && e.event === 'approval.pending'), 'approval event must arrive');
    safe(events); safe(await result('approvals.list')); safe(fs.readFileSync(path.join(home, 'state.json'), 'utf8'));
  });
  await check('audit records and audit.tail remain redacted, including legacy entries', async () => {
    await result('tabs', { caller: `audit caller ${callback}` });
    safe(await result('audit.tail', { n: 100 }));
    safe(fs.readFileSync(path.join(home, 'audit.jsonl'), 'utf8')); safe(stderr);
  });
} finally {
  await mcp?.close(); for (const conn of clients) conn.destroy(); bridge?.destroy();
  const exited = once(daemon, 'close'); daemon.kill('SIGTERM'); await exited;
}
console.log(`== URL redaction: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
