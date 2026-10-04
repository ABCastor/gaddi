// Exercise the production broker handler without opening a socket or browser.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { spawn } from 'node:child_process';
import { isRecord, parseJSON, errorMessage, hasErrorCode, versionParam, waitParams } from '../../shared/protocol.ts';
import type { BrokerParams, BrokerResult, Reply } from '../../shared/protocol.ts';
import { loadPolicy, checkNavigation, checkClick, checkPress, checkType, checkEval, checkUpload, checkSignin, hostOf } from '../../daemon/policy.ts';
import { createApprovals, GateError, approvalRef, cleanURL, cleanDetail } from '../../daemon/approvals.ts';
import { createProofVerifier, approvalMessage } from '../../daemon/proof.ts';
import { readUpload, UPLOAD_CHUNK } from '../../daemon/uploads.ts';
import { signinSite, listLogins, chooseLogin, runSignin } from '../../daemon/signin.ts';
import { createSigninSecrets } from '../../daemon/signin-secrets.ts';
import { wakeApprovalApp } from '../../daemon/approval-wake.ts';
import { readBrowser } from '../../mcp/reader.ts';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gaddi-signin-output-'));
const password = 'FAKE_OUTPUT_PASSWORD_43', username = 'fake&review@example.test';
const site = 'https://example.com';
let bridgeError = false, phase = 'complete', pageURL = site + '/home';
const filled = new Map<string, string>();
const keys = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
fs.writeFileSync(path.join(home, 'unused.pub'), keys.publicKey.export({ type: 'spki', format: 'pem' }));
const bridge = {
  connection: () => ({}), status: () => ({ connected: true }),
  request: async (method: string, params: BrokerParams = {}) => {
    if (method === 'chrome.tabs') return { tabs: [{ id: 7, url: pageURL }] };
    if (method === 'chrome.signinProbe') return { url: pageURL, signature: phase, passwordPresent: phase === 'password',
      ...(phase === 'username' || phase === 'password' ? { username: '@abcdef:1' } : {}),
      ...(phase === 'password' ? { password: '@abcdef:2' } : {}) };
    if (method === 'chrome.signinType') {
      assert.equal(params.tab, 7); assert.equal(params.signin?.site, site);
      const kind = params.signin?.kind; assert.ok(kind);
      assert.equal(params.text, kind === 'username' ? username : password);
      filled.set(kind, params.text); return { typed: true };
    }
    if (method === 'chrome.signinSubmit') {
      if (phase === 'username') { assert.equal(filled.get('username'), username); phase = 'password'; pageURL = site + '/password'; }
      else { assert.equal(filled.get('password'), password); phase = 'complete'; pageURL = site + '/home'; }
      return { pressed: true };
    }
    if (method === 'chrome.eval') {
      if (bridgeError) throw new Error(`${password} ${username}`);
      return { tab: 7, url: site + '/home', value: { [password]: { id: 'id', result: 'result', user: username, password } } };
    }
    if (method === 'chrome.html') return { html: '<main>fake&amp;review@example.test</main>' };
    if (method === 'chrome.read') return { text: `${username} ${password}`, outline: `${password}`, title: username };
    throw new Error('Unexpected fake bridge call');
  },
};
const server = { on: () => server, listen: () => {}, close: (done: () => void) => done() };
const context = vm.createContext({
  net: { createServer: () => server }, fs, path, os, crypto, spawn, Buffer,
  process: { env: { GADDI_HOME: home, GADDI_SOCKET: path.join(home, 'unused.sock'), GADDI_APPROVER_PUB: path.join(home, 'unused.pub') },
    pid: 123, on: () => {}, exit: () => { throw new Error('Unexpected broker exit'); } },
  console: { error: () => {} }, setInterval: () => ({ unref: () => {} }), clearInterval: () => {},
  loadPolicy, checkNavigation, checkClick, checkPress, checkType, checkEval, checkUpload, checkSignin, hostOf,
  createApprovals, GateError, approvalRef, cleanURL, cleanDetail, createProofVerifier, approvalMessage,
  readUpload, UPLOAD_CHUNK, signinSite, listLogins, chooseLogin, runSignin, createSigninSecrets,
  createBridge: () => bridge, isRecord, parseJSON, errorMessage, hasErrorCode, versionParam, waitParams,
  wakeApprovalApp: (pending: readonly unknown[]) => wakeApprovalApp(pending, { launcher: '/usr/bin/true' }),
});
const source = stripTypeScriptTypes(fs.readFileSync(new URL('../../daemon/daemon.ts', import.meta.url), 'utf8'))
  .replace(/^#!.*\n/, '').replace(/^import .*;\n/gm, '');
vm.runInContext(source, context);
let serial = 0;
async function reply(method: string, params: BrokerParams = {}): Promise<Reply> {
  const lines: string[] = [];
  const id = ++serial;
  context.input = { id, method, params: { caller: 'output-test', ...params } };
  context.conn = { destroyed: false, write: (line: string) => lines.push(line) };
  await vm.runInContext('handle(input, conn)', context);
  assert.equal(lines.length, 1);
  const response = JSON.parse(lines[0]) as Reply;
  assert.equal(response.id, id, 'Broker correlation ID must survive redaction');
  return response;
}
async function rpc<M extends string>(method: M, params: BrokerParams = {}): Promise<BrokerResult<M>> {
  const response = await reply(method, params);
  assert.equal(response.error, undefined);
  return response.result as BrokerResult<M>;
}
const oldExtractor = process.env.OMNIREAD_BIN;
const oldEnvironment = { ...process.env };
try {
  context.values = [password, username, 'id', 'result'];
  vm.runInContext('signinSecrets.remember(7, values)', context);
  const evaluated = await rpc('eval', { tab: 7, expression: 'document.querySelector("input").value' });
  assert.ok(isRecord(evaluated) && isRecord(evaluated.value));
  assert.ok('[redacted]' in evaluated.value);
  const nested = evaluated.value['[redacted]']; assert.ok(isRecord(nested));
  assert.equal(nested.user, '[redacted]'); assert.equal(nested.password, '[redacted]');
  assert.ok(Object.values(nested).every(value => value === '[redacted]'));
  // Known broker keys stay intact even when usernames collide with their names.
  assert.ok('value' in evaluated && 'tab' in evaluated && 'url' in evaluated);
  context.collision = ['7', 'signed_in', 'username'];
  vm.runInContext('signinSecrets.remember(7, collision)', context);
  const html = await rpc('html', { tab: 7 }); assert.equal(html.tab, 7);
  const metadata = vm.runInContext('signinSecrets.redact({id:"7",tab:7,outcome:"signed_in",step:"username",text:"7 signed_in username"}, undefined, false)', context) as Record<string, unknown>;
  assert.deepEqual([metadata.id, metadata.tab, metadata.outcome, metadata.step], ['7', 7, 'signed_in', 'username']);
  assert.equal(metadata.text, '[redacted] [redacted] [redacted]');
  console.log('PASS production handler preserves correlation/contract keys and redacts arbitrary eval keys');
  const looked = await rpc('look', { tab: 7 });
  assert.ok(looked.text.includes('[redacted]') && looked.outline?.includes('[redacted]'));
  bridgeError = true;
  const error = await reply('eval', { tab: 7, expression: 'throw new Error("test")' });
  assert.ok(error.error && error.error.message === '[redacted] [redacted]');
  bridgeError = false;
  console.log('PASS production look and exception output contain no remembered values');

  const extractor = path.join(home, 'fake-extractor');
  fs.writeFileSync(extractor, `#!${process.execPath}
const fs = require('node:fs');
const html = fs.readFileSync(process.argv[4], 'utf8');
console.log(JSON.stringify({result:{content:html.replace(/&amp;/g,'&')}}));
`, { mode: 0o700 });
  process.env.OMNIREAD_BIN = extractor;
  const article = await readBrowser({ tab: 7 }, rpc);
  const text = article.content[0].text;
  assert.ok(text.includes('[redacted]'));
  assert.ok(!text.includes(username) && !text.includes(password));
  console.log('PASS final browser_read output redacts credentials reconstructed by entity decoding');
  const audit = fs.readFileSync(path.join(home, 'audit.jsonl'), 'utf8');
  assert.ok(!audit.includes(username) && !audit.includes(password));
  assert.ok(audit.trim().split('\n').every(line => 'method' in (JSON.parse(line) as object)));
  console.log('PASS production audit preserves schema without credential values');
  assert.equal(checkSignin(loadPolicy({ overlay: path.join(home, 'missing.json'), off: true }), site).outcome, 'hold');
  fs.writeFileSync(path.join(home, 'policy.json'), JSON.stringify({ signin: { remember: [site] } }));
  const policy = loadPolicy({ overlay: path.join(home, 'policy.json') });
  assert.equal(checkSignin(policy, site).outcome, 'allow');
  assert.equal(checkSignin(policy, 'https://sub.example.com').outcome, 'hold');
  console.log('PASS owner remember policy is exact-origin and POLICY_OFF cannot bypass sign-in');

  // Drive the actual approval, op, sign-in runner and reply boundary with fake input.
  vm.runInContext('signinSecrets.clear()', context);
  const receipt = path.join(home, 'op-calls.jsonl');
  fs.writeFileSync(path.join(home, 'op'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.SIGNIN_OUTPUT_RECEIPT, JSON.stringify({args,env:Object.keys(process.env).filter(k=>/^OP_/i.test(k))})+'\\n');
if(args[1]==='list') console.log(JSON.stringify([{id:'fixture-item',title:'Fixture login',urls:[{href:'http://example.com'}]}]));
else console.log(JSON.stringify([{label:'username',value:'${username}'},{label:'password',value:'${password}'}]));
`, { mode: 0o700 });
  process.env.PATH = `${home}:${process.env.PATH}`;
  process.env.SIGNIN_OUTPUT_RECEIPT = receipt;
  process.env.OP_SERVICE_ACCOUNT_TOKEN = 'FAKE_SERVICE_TOKEN'; process.env.OP_SESSION_fake = 'FAKE_SESSION';
  // The approval app is replaced by a no-op; no real app or Touch ID prompt.
  vm.runInContext('process.env.GADDI_APP_LAUNCHER = "/usr/bin/true"', context);
  async function heldAndGrant(two: boolean) {
    phase = two ? 'username' : 'password'; pageURL = site + '/login'; filled.clear();
    const held = await rpc('signin', { tab: 7 });
    assert.equal(held.outcome, 'needs_you'); assert.equal(held.step, 'approval');
    assert.equal(filled.size, 0);
    const pending = await rpc('approvals.list'); assert.ok(isRecord(pending) && Array.isArray(pending.pending));
    const approval = pending.pending.at(-1); assert.ok(isRecord(approval));
    assert.equal(approval.kind, 'signin'); assert.equal(approval.detail, 'Fixture login'); assert.equal(approval.url, pageURL);
    const ts = Date.now();
    const message = `grant|${approval.id}|${approval.kind}|${approval.tab}|${crypto.createHash('sha256').update(String(approval.detail)).digest('hex')}|${ts}`;
    await rpc('approval.grant', { id: String(approval.id), proof: { ts, sig: crypto.sign('sha256', Buffer.from(message), keys.privateKey).toString('base64') } });
    return String(approval.id);
  }
  const id = await heldAndGrant(false);
  const beforeCredentials = fs.readFileSync(receipt, 'utf8').trim().split('\n').map(line => JSON.parse(line) as {args:string[]});
  assert.ok(beforeCredentials.every(call => call.args[1] === 'list'));
  assert.equal((await rpc('signin', { tab: 7, approval: id })).outcome, 'signed_in');
  assert.equal(filled.get('username'), username); assert.equal(filled.get('password'), password);
  console.log('PASS production held approval, signed grant and fake op one-step sign-in');
  const second = await heldAndGrant(true);
  assert.equal((await rpc('signin', { tab: 7, approval: second })).outcome, 'signed_in');
  phase = 'password'; pageURL = site + '/login';
  assert.equal((await rpc('signin', { tab: 7, approval: second })).outcome, 'failed');
  pageURL = 'https://evil.example/login';
  assert.equal((await rpc('signin', { tab: 7, item: 'fixture-item' })).outcome, 'failed');
  console.log('PASS production two-step sign-in, single-use approval and phishing refusal');
  const after = await rpc('eval', { tab: 7, expression: 'document.querySelector("input").value' });
  assert.ok(!JSON.stringify(after).includes(username) && !JSON.stringify(after).includes(password));
  console.log('PASS production sign-in automatically retains credentials for following eval redaction');
  const records = fs.readFileSync(receipt, 'utf8').trim().split('\n').map(line => JSON.parse(line) as {env:string[]});
  assert.ok(records.every(call => call.env.length === 0));
  const finalAudit = fs.readFileSync(path.join(home, 'audit.jsonl'), 'utf8');
  assert.ok(!finalAudit.includes(username) && !finalAudit.includes(password));
  const signinRows = finalAudit.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>).filter(row => 'site' in row);
  assert.ok(signinRows.length > 0 && signinRows.every(row => Object.keys(row).sort().join(',') === 'item_title,outcome,site,ts'));
  console.log('PASS production sign-in audit has four metadata fields and op has no OP_* env');
  console.log('== signin output: 9 passed, 0 failed');
} finally {
  process.env = oldEnvironment;
  if (oldExtractor === undefined) delete process.env.OMNIREAD_BIN; else process.env.OMNIREAD_BIN = oldExtractor;
  vm.runInContext('approvals.stop(); signinSecrets.stop()', context);
  fs.rmSync(home, { recursive: true, force: true }); // Only this test's temporary fixture.
}
