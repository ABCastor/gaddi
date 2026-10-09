// Real broker/MCP/CLI with fake op and a bridge modelling local HTML fixtures. No browser.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { isRecord } from '../../shared/protocol.ts';
import type { BrokerParams, ChromeRequest, Reply, SigninResult } from '../../shared/protocol.ts';
import { approvalMessage, signinRevokeMessage } from '../../daemon/proof.ts';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gaddi-signin-broker-'));
const socket = path.join(home, 'broker.sock');
const repo = path.resolve(import.meta.dirname, '../..');
const username = 'signin-user@example.test', password = 'SIGNIN_FAKE_PASSWORD_33';
const opCalls = path.join(home, 'op-calls.jsonl'), itemsPath = path.join(home, 'items.json');
const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
fs.writeFileSync(path.join(home, 'approver.pub'), publicKey.export({ type: 'spki', format: 'pem' }));
fs.writeFileSync(path.join(home, 'op'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.SIGNIN_OP_CALLS, JSON.stringify({args,opEnv:Object.keys(process.env).filter(k=>/^OP_/i.test(k))})+'\\n');
if (args[1] === 'list') console.log(fs.readFileSync(process.env.SIGNIN_ITEMS,'utf8'));
else console.log(JSON.stringify([{label:'username',value:'${username}'},{label:'password',value:'${password}'}]));
`, { mode: 0o700 });
const env = { ...process.env, PATH: `${home}:${process.env.PATH}`, OP_SERVICE_ACCOUNT_TOKEN: 'FAKE_MACHINE_TOKEN', OP_SESSION_test: 'FAKE_SESSION',
  SIGNIN_OP_CALLS: opCalls, SIGNIN_ITEMS: itemsPath, GADDI_HOME: home, GADDI_SOCKET: socket,
  GADDI_AUDIT: path.join(home, 'audit.jsonl'), GADDI_STATE: path.join(home, 'state.json'),
  GADDI_APPROVER_PUB: path.join(home, 'approver.pub'), GADDI_APP_LAUNCHER: '/usr/bin/true', GADDI_POLICY_OFF: '0',
  OMNIREAD_BIN: path.join(home, 'missing-omniread') };
const daemon = spawn(process.execPath, [path.join(repo, 'daemon/daemon.mjs')], { env });
let stderr = '', passed = 0;
daemon.stderr.on('data', chunk => { stderr += chunk; });
daemon.stdout.resume();
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const clients = new Set<net.Socket>();
let mcp: Client | undefined;
const noSecrets = (value: unknown) => {
  const text = JSON.stringify(value);
  assert.ok(!text.includes(username), 'Username leaked');
  assert.ok(!text.includes(password), 'Password leaked');
};
const pass = (name: string) => { passed++; console.log(`PASS ${name}`); };
function connect() {
  const connection = net.connect(socket); clients.add(connection); connection.setEncoding('utf8');
  connection.on('error', () => {});
  return connection;
}
function call(method: string, params: BrokerParams = {}): Promise<Reply> {
  const connection = connect(), id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => { connection.destroy(); reject(new Error('Test broker timeout')); }, 35000);
    connection.on('connect', () => connection.write(JSON.stringify({ id, method, params: { caller: 'signin-test', ...params } }) + '\n'));
    connection.on('error', error => { clearTimeout(timer); reject(error); });
    connection.on('data', chunk => {
      buffer += chunk;
      const end = buffer.indexOf('\n'); if (end < 0) return;
      clearTimeout(timer); connection.destroy();
      const reply: unknown = JSON.parse(buffer.slice(0, end));
      assert.ok(isRecord(reply) && reply.id === id); noSecrets(reply);
      resolve(reply as unknown as Reply);
    });
  });
}
async function result(method: string, params: BrokerParams = {}) {
  const reply = await call(method, params); assert.equal(reply.error, undefined); return reply.result;
}
const site = 'http://127.0.0.1:18999';
let url = site + '/login', phase = 'one-step', filled = new Map<string, string>();
let leakError = false;
const bridgeCalls: ChromeRequest[] = [];
const fixture = () => phase === 'complete' ? '<title>Welcome</title>' : fs.readFileSync(path.join(import.meta.dirname, 'fixtures', phase + '.html'), 'utf8');
function reset(two = false) { url = site + '/login'; phase = two ? 'two-step' : 'one-step'; filled = new Map(); }
function setItems(items: { id: string; title: string; urls: { href: string }[] }[]) { fs.writeFileSync(itemsPath, JSON.stringify(items)); }
const item = { id: 'test-login', title: 'Local fixture', urls: [{ href: site }] };
const signin = async (params: BrokerParams = {}) => {
  const value = await result('signin', { tab: 7, ...params });
  assert.ok(isRecord(value));
  assert.ok(Object.keys(value).every(key => ['outcome', 'site', 'item_title', 'step', 'reason'].includes(key)));
  return value as unknown as SigninResult;
};
async function grant(remember = false) {
  const list = await result('approvals.list'); assert.ok(isRecord(list) && Array.isArray(list.pending));
  const approval = list.pending.at(-1); assert.ok(isRecord(approval));
  assert.equal(approval.kind, 'signin'); assert.equal(approval.detail, item.title); assert.equal(approval.url, site + '/login');
  const ts = Date.now();
  const message = approvalMessage('grant', approval, ts, remember);
  const proof = { ts, sig: crypto.sign('sha256', Buffer.from(message), privateKey).toString('base64') };
  await result('approval.grant', { id: String(approval.id), proof, remember });
  return String(approval.id);
}
async function cli(args: string[]) {
  const child = spawn(process.execPath, [path.join(repo, 'cli/gaddi'), '--json', ...args], { env });
  let out = '', err = ''; child.stdout.on('data', chunk => { out += chunk; }); child.stderr.on('data', chunk => { err += chunk; });
  const [code] = await once(child, 'close');
  noSecrets(out + err); assert.equal(code, 0, 'CLI exited unsuccessfully'); return JSON.parse(out) as { result: SigninResult };
}
try {
  for (let n = 0; n < 100 && !fs.existsSync(socket) && daemon.exitCode === null; n++) await delay(20);
  if (!fs.existsSync(socket) && /EPERM|operation not permitted/i.test(stderr)) {
    console.log('SKIP signin broker: sandbox refused private Unix socket listen (EPERM)'); process.exitCode = 77;
  } else {
    assert.ok(fs.existsSync(socket), 'Fake broker did not start');
    const bridge = connect(); let buffer = '';
    bridge.on('connect', () => bridge.write(JSON.stringify({ id: 'attach', method: 'bridge.attach', params: { kind: 'chrome' } }) + '\n'));
    bridge.on('data', chunk => {
      buffer += chunk; let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const request = JSON.parse(buffer.slice(0, end)) as ChromeRequest; buffer = buffer.slice(end + 1);
        if (request.id === 'attach') {
          const reply = request as unknown as Reply;
          assert.equal(reply.error, undefined, 'Fake bridge attach must succeed');
          assert.ok(isRecord(reply.result) && reply.result.connected === true);
          continue;
        }
        bridgeCalls.push(request);
        let value: unknown;
        if (request.method === 'chrome.active') value = { id: 7, url, title: 'Local fixture' };
        else if (request.method === 'chrome.tabs') value = { tabs: [{ id: 7, url, title: 'Local fixture' }] };
        else if (request.method === 'chrome.signinProbe') value = { url, signature: phase,
          ...(fixture().includes('id="username"') ? { username: '@abcdef:1' } : {}),
          ...(fixture().includes('id="password"') ? { password: '@abcdef:2' } : {}) };
        else if (request.method === 'chrome.signinType') {
          assert.equal(request.params.tab, 7); assert.equal(request.params.signin?.site, site);
          const kind = request.params.signin?.kind; assert.ok(kind);
          assert.ok(fixture().includes(`id="${kind}"`));
          assert.equal(request.params.text, kind === 'username' ? username : password);
          filled.set(kind, request.params.text); value = { typed: true };
        } else if (request.method === 'chrome.signinSubmit') {
          if (phase === 'two-step') { assert.equal(filled.get('username'), username); phase = 'password-step'; url = site + '/password'; }
          else { assert.equal(filled.get('password'), password); phase = 'complete'; url = site + '/signed-in'; }
          value = { pressed: true };
        } else if (request.method === 'chrome.eval') {
          if (leakError) { bridge.write(JSON.stringify({ id: request.id, error: { message: `${username} ${password}` } }) + '\n'); continue; }
          value = { tab: 7, url, value: { [password]: `${username} ${password}` } };
        } else if (request.method === 'chrome.html') value = { html: `<main>${username} ${password}</main>` };
        else if (request.method === 'chrome.read') value = { text: `${username} ${password}`, outline: `${password}`, title: username };
        else throw new Error('Unexpected bridge call');
        bridge.write(JSON.stringify({ id: request.id, result: value }) + '\n');
      }
    });
    for (let n = 0; n < 100; n++) { const state = await result('bridge.status'); if (isRecord(state) && state.connected) break; await delay(10); }
    setItems([item]);
    const held = await signin(); assert.equal(held.outcome, 'needs_you'); assert.equal(held.step, 'approval');
    assert.ok(fs.readFileSync(opCalls, 'utf8').split('\n').filter(Boolean).every(line => (JSON.parse(line) as { args: string[] }).args[1] === 'list'));
    assert.equal(bridgeCalls.some(call => call.method === 'chrome.signinType'), false);
    pass('default approval hold names site/item and fetches no credentials');
    const id = await grant();
    const completed = await signin({ approval: id }); assert.equal(completed.outcome, 'signed_in');
    assert.equal(filled.get('username'), username); assert.equal(filled.get('password'), password);
    pass('one-step local fixture fills correct values and submits after signed approval');
    reset(true); await signin(); const secondId = await grant();
    assert.equal((await signin({ approval: secondId })).outcome, 'signed_in');
    pass('two-step local fixture submits username, waits and submits password');
    const replay = await signin({ approval: secondId }); assert.equal(replay.outcome, 'failed');
    reset(); url = 'https://phishing.example';
    assert.equal((await signin({ item: item.id })).outcome, 'failed');
    pass('approval is single use and a selected mismatched login is refused');
    reset(); setItems([item, { ...item, id: 'second-login', title: 'Other fixture' }]);
    const choice = await signin(); assert.equal(choice.outcome, 'choose'); assert.deepEqual(JSON.parse(choice.reason!), ['Local fixture', 'Other fixture']);
    setItems([]); assert.equal((await signin()).outcome, 'no_login');
    setItems([item]);
    pass('multiple matches expose titles only and missing login returns no_login');
    for (const method of ['eval', 'html', 'look']) {
      const value = await result(method, { tab: 7, ...(method === 'eval' ? { expression: 'document.querySelector("input").value' } : {}) });
      assert.ok(JSON.stringify(value).includes('[redacted]')); noSecrets(value);
    }
    leakError = true; const error = await call('eval', { tab: 7, expression: 'throw new Error("test")' }); assert.ok(error.error?.message.includes('[redacted]')); leakError = false;
    pass('follow-up eval/html/look and bridge errors redact values and object keys');
    mcp = new Client({ name: 'signin-test', version: '0' });
    await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(repo, 'mcp/server.mjs')], env }));
    const tools = await mcp.listTools(); const tool = tools.tools.find(tool => tool.name === 'browser_signin'); assert.ok(tool);
    assert.deepEqual(Object.keys(tool.inputSchema.properties!).sort(), ['approval', 'item', 'tab']);
    const read = await mcp.callTool({ name: 'browser_read', arguments: { tab: 7 } }); noSecrets(read); assert.ok(JSON.stringify(read).includes('[redacted]'));
    setItems([]); const mcpSignin = await mcp.callTool({ name: 'browser_signin', arguments: { tab: 7 } }); noSecrets(mcpSignin); assert.ok(JSON.stringify(mcpSignin).includes('no_login'));
    assert.equal((await cli(['signin', '7', '--item', item.title])).result.outcome, 'failed');
    assert.equal((await cli(['signin', '--tab', '7'])).result.outcome, 'no_login');
    pass('MCP signin/read and positional/explicit-tab CLI expose safe metadata');
    setItems([item]); reset(); await signin();
    let list = await result('approvals.list'); assert.ok(isRecord(list) && Array.isArray(list.pending));
    const rememberHold = list.pending.at(-1); assert.ok(isRecord(rememberHold));
    const before = fs.existsSync(path.join(home, 'policy.json')) ? fs.readFileSync(path.join(home, 'policy.json'), 'utf8') : undefined;
    assert.equal((await call('approval.grant', { id: String(rememberHold.id), remember: true })).error?.code, 'proof-invalid');
    assert.equal((await call('signin.revoke', { site })).error?.code, 'proof-invalid');
    assert.equal(fs.existsSync(path.join(home, 'policy.json')) ? fs.readFileSync(path.join(home, 'policy.json'), 'utf8') : undefined, before);
    const rememberId = await grant(true);
    assert.equal((await signin({ approval: rememberId })).outcome, 'signed_in');
    reset(); assert.equal((await signin()).outcome, 'signed_in');
    const remembered = await result('signin.remembered'); assert.deepEqual(remembered, { sites: [site] });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'policy.json'), 'utf8')).signin.remember, [site]);
    reset(); url = 'http://127.0.0.1:19000/login';
    setItems([{ ...item, urls: [{ href: 'http://127.0.0.1:19000' }] }]);
    assert.equal((await signin()).step, 'approval');
    setItems([item]); reset();
    const revokeTs = Date.now();
    const revokeProof = { ts: revokeTs, sig: crypto.sign('sha256', Buffer.from(signinRevokeMessage(site, revokeTs)), privateKey).toString('base64') };
    assert.equal((await call('signin.revoke', { site: 'http://127.0.0.1:19000', proof: revokeProof })).error?.code, 'proof-invalid');
    await result('signin.revoke', { site, proof: revokeProof });
    assert.deepEqual(await result('signin.remembered'), { sites: [] });
    assert.equal((await call('signin.revoke', { site, proof: revokeProof })).error?.code, 'proof-invalid');
    assert.equal((await signin()).step, 'approval');
    // browser_grant only asks; the owner's signed decision in the app is what grants (tests/gates/session-grant).
    assert.equal(tools.tools.some(tool => tool.name !== 'browser_grant' && /remember|revoke|grant/.test(tool.name)), false);
    pass('signed Always skips the next hold on its exact origin; signed Revoke restores it; unsigned RPCs and replay fail');
    const calls = fs.readFileSync(opCalls, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { opEnv: string[] });
    assert.ok(calls.every(call => call.opEnv.length === 0));
    const audit = fs.readFileSync(env.GADDI_AUDIT, 'utf8'); noSecrets(audit); noSecrets(stderr);
    const rows = audit.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
    const signinRows = rows.filter(row => 'site' in row);
    assert.ok(signinRows.length > 0 && signinRows.every(row => Object.keys(row).sort().join(',') === 'item_title,outcome,site,ts'));
    pass('op child has no OP_* variables; audit/log output has no credentials');
    console.log(`== signin broker: ${passed} passed, 0 failed`);
  }
} finally {
  await mcp?.close();
  for (const client of clients) client.destroy();
  daemon.kill('SIGTERM');
  if (daemon.exitCode === null && daemon.signalCode === null) await once(daemon, 'exit');
  fs.rmSync(home, { recursive: true, force: true }); // Only this test's temporary fixture.
}
