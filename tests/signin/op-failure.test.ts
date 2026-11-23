// OP-DIAGNOSTICS: every way 1Password can fail a sign-in is named by a fixed category, with a fake op only.
// Never runs the real op, never reads a real token or item. Canary values stand in for every secret and
// for op's raw output; none of them may reach a reply or the audit.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { spawn } from 'node:child_process';
import { stripTypeScriptTypes } from 'node:module';
import { isRecord, parseJSON, errorMessage, hasErrorCode, versionParam, waitParams, FRAME_TOOLS } from '../../shared/protocol.ts';
import type { BrokerParams, BrokerResult, ChromeParams, Reply, SigninResult } from '../../shared/protocol.ts';
import { loadPolicy, checkNavigation, checkClick, checkPress, checkType, checkEval, checkUpload, checkSignin, hostOf } from '../../daemon/policy.ts';
import { createApprovals, GateError, approvalRef, cleanURL, cleanDetail, approvalContext } from '../../daemon/approvals.ts';
import { createProofVerifier, approvalMessage } from '../../daemon/proof.ts';
import { readUpload, UPLOAD_CHUNK } from '../../daemon/uploads.ts';
import { signinSite, listLogins, chooseLogin, runSignin, createLogin, getPassword, opDiagnostic, PASSWORD_UNAVAILABLE } from '../../daemon/signin.ts';
import type { LoginItem } from '../../daemon/signin.ts';
import { createSigninSecrets } from '../../daemon/signin-secrets.ts';
import { wakeApprovalApp } from '../../daemon/approval-wake.ts';
import { createGrants, checkGrant, parseGrantRequest, grantDetail, isGrantSpec, ruleString } from '../../daemon/grants.ts';
import { createRemote } from '../../daemon/remote.ts';
import { redactURLs, redactURLText } from '../../shared/url-redaction.ts';

const LAUNCHD_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gaddi-op-failure-'));
const fakeDir = path.join(home, 'bin'), receipt = path.join(home, 'op-calls.jsonl'), tokenFile = path.join(home, 'agent-value');
const CANARY = { password: 'CANARY_PW_7781', old: 'CANARY_OLDPW_2290', username: 'canary-user@example.test', token: 'CANARY_TOKEN_5521',
  stderr: 'CANARY_STDERR_9913', stdout: 'CANARY_STDOUT_6634', note: 'CANARY_NOTE_4410' };
const site = 'https://example.test';
const item: LoginItem = { id: 'fixture-item', title: 'Fixture login', urls: [site] };
const oldEnvironment = { ...process.env };
let passed = 0;
const pass = (line: string) => { passed++; console.log(`PASS ${line}`); };

// The fake op. FAKE_OP_MODE picks the answer to `item get`; `item list` always lists the fixture item.
// Each failing mode prints canaries on stdout and stderr, so a leak of raw output is caught.
fs.mkdirSync(fakeDir);
fs.writeFileSync(path.join(fakeDir, 'op'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2), mode = process.env.FAKE_OP_MODE || 'ok';
const labelled = args.includes('--fields');
fs.appendFileSync(process.env.FAKE_OP_RECEIPT, JSON.stringify({ args, mode, tokenOk: process.env.OP_SERVICE_ACCOUNT_TOKEN === ${JSON.stringify(CANARY.token)} }) + '\\n');
const C = ${JSON.stringify(CANARY)};
const user = { id: 'username', type: 'STRING', purpose: 'USERNAME', label: 'username', value: C.username };
const pass = { id: 'password', type: 'CONCEALED', purpose: 'PASSWORD', label: 'password', value: C.password };
const note = { id: 'notesPlain', type: 'STRING', purpose: 'NOTES', label: 'notesPlain', value: C.note };
const full = fields => console.log(JSON.stringify({ id: 'fixture-item', title: 'Fixture login', category: 'LOGIN', fields }));
const loud = code => { process.stderr.write(C.stderr + ' ' + C.password); process.stdout.write(C.stdout + ' ' + C.note); process.exit(code); };
if (args[1] === 'list') { console.log(JSON.stringify([{ id: 'fixture-item', title: 'Fixture login', urls: [{ href: ${JSON.stringify(site)} }] }])); process.exit(0); }
if (mode === 'ok') labelled ? console.log(JSON.stringify([user, pass])) : full([user, pass, note]);
else if (mode === 'exit') loud(1);
else if (mode === 'timeout') setTimeout(() => console.log(JSON.stringify([user, pass])), 8000);
else if (mode === 'slow') setTimeout(() => console.log(JSON.stringify([user, pass])), 2500);
else if (mode === 'malformed') loud(0);
else if (mode === 'no-username') labelled ? console.log(JSON.stringify(pass)) : full([pass, note]);
else if (mode === 'no-password') labelled ? console.log(JSON.stringify(user)) : full([user, note]);
// Two purposeless fields labelled password: nothing says which one is the login's.
else if (mode === 'duplicate-password') { const twins = [{ label: 'username', value: C.username }, { label: 'password', value: C.password }, { label: 'password', value: C.old }]; labelled ? console.log(JSON.stringify(twins)) : full(twins); }
else if (mode === 'duplicate-username') { const twins = [{ label: 'username', value: C.username }, { label: 'username', value: C.old }, { label: 'password', value: C.password }]; labelled ? console.log(JSON.stringify(twins)) : full(twins); }
// Real Login shapes the old label-only parser refused: the owner renamed the username field to "email",
// and a custom field in another section is also labelled "password". Purpose identifies both built-ins.
// The labelled read answers with one object (op's shape for a single match) or exits (the other way op may
// report a missing label); both must reach the full read.
else if (mode === 'renamed-object' || mode === 'renamed-exit') {
  const fields = [{ ...user, label: 'email' }, pass, { id: 'abc', type: 'CONCEALED', label: 'password', section: { id: 'old' }, value: C.old }, note];
  if (!labelled) full(fields);
  else if (mode === 'renamed-exit') loud(1);
  else console.log(JSON.stringify([pass, fields[2]]));
}
else loud(2);
`, { mode: 0o700 });
fs.writeFileSync(tokenFile, CANARY.token + '\n', { mode: 0o600 });

function environment(mode: string, overrides: Record<string, string | undefined> = {}) {
  process.env = { ...oldEnvironment, PATH: `${fakeDir}:${LAUNCHD_PATH}`, GADDI_OP_FALLBACK_DIRS: '', FAKE_OP_MODE: mode, FAKE_OP_RECEIPT: receipt,
    GADDI_OP_TOKEN_FILE: tokenFile, GADDI_OP_HOME: path.join(home, 'op-home') };
  for (const [key, value] of Object.entries(overrides)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
}
function leakFree(value: unknown, where: string) {
  const text = JSON.stringify(value);
  for (const [name, canary] of Object.entries(CANARY)) assert.ok(!text.includes(canary), `ASSERT_NO_LEAK: ${where} carries the ${name} canary`);
  for (const word of ['stdout', 'stderr', home]) assert.ok(!text.includes(word), `ASSERT_NO_LEAK: ${where} carries "${word}"`);
}
const calls = () => fs.existsSync(receipt) ? fs.readFileSync(receipt, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { args: string[]; tokenOk: boolean }) : [];

// A fake page: one-step form, or a password-only "confirm your password" step.
function page(kind: 'login' | 'confirm') {
  let phase = 'form';
  const typed = new Map<string, string>();
  const request = async (name: string, args: ChromeParams): Promise<unknown> => {
    if (name === 'signinProbe') return phase === 'done' ? { url: site + '/home', signature: 'done', passwordPresent: false }
      : { url: site + '/login', signature: kind, passwordPresent: true, password: '@p', ...(kind === 'login' ? { username: '@u' } : {}) };
    const signin = { kind: String(args.signin?.kind) };
    if (name === 'signinType') { typed.set(signin.kind, String(args.text)); return { typed: true }; }
    if (name === 'signinSubmit') { if (signin.kind === 'password') phase = 'done'; return { pressed: true }; }
    throw new Error('Unexpected fake bridge call');
  };
  return { request, typed };
}
async function signin(mode: string, kind: 'login' | 'confirm' = 'login', overrides: Record<string, string | undefined> = {}, budgetMs?: number) {
  environment(mode, overrides);
  fs.rmSync(receipt, { force: true });
  const fake = page(kind), remembered: string[] = [];
  const started = Date.now();
  const result = await runSignin({ site, item, request: fake.request, remember: value => { remembered.push(value); }, ...(budgetMs ? { budgetMs } : {}) });
  return { result, typed: fake.typed, remembered, took: Date.now() - started };
}
function failedAt(result: SigninResult, category: string, where: string) {
  assert.equal(result.outcome, 'needs_you', where); assert.equal(result.step, 'credentials', where);
  assert.equal(result.reason, PASSWORD_UNAVAILABLE, `${where}: reason text stays PASSWORD_UNAVAILABLE for compatibility`);
  assert.equal(result.category, category, where);
  assert.ok(Number.isInteger(result.elapsed_ms) && result.elapsed_ms! >= 0, `${where}: elapsed_ms`);
  assert.deepEqual(Object.keys(result).sort(), ['category', 'elapsed_ms', 'item_title', 'outcome', 'reason', 'site', 'step'], where);
  leakFree(result, where);
}

try {
  for (const dir of LAUNCHD_PATH.split(':')) assert.ok(!fs.existsSync(path.join(dir, 'op')), `real op found in ${dir}: refusing to run`);

  {
    const { result, typed, remembered } = await signin('ok');
    assert.equal(result.outcome, 'signed_in'); assert.equal(result.category, undefined); assert.equal(result.elapsed_ms, undefined);
    assert.equal(typed.get('username'), CANARY.username); assert.equal(typed.get('password'), CANARY.password);
    assert.deepEqual(remembered, [CANARY.username, CANARY.password]);
    const made = calls();
    assert.deepEqual(made.map(call => call.args), [['item', 'get', 'fixture-item', '--fields', 'label=username,label=password', '--reveal', '--format', 'json']]);
    assert.ok(made.every(call => call.tokenOk));
    leakFree(result, 'valid pair');
    pass('valid labelled pair fills and signs in with one op read and no category');
  }
  {
    const { result } = await signin('exit');
    failedAt(result, 'credentials:get-exit', 'get exits nonzero');
    assert.equal(calls().length, 2, 'an exit gets one full re-read, no more');
    pass('list ok + get nonzero exit -> credentials:get-exit, stdout/stderr canaries absent');
  }
  {
    const { result, took } = await signin('timeout');
    failedAt(result, 'credentials:get-timeout', 'get times out');
    assert.ok(result.elapsed_ms! >= 4900 && took < 6500, `ASSERT_TIMEOUT_BOUND: ${result.elapsed_ms} ms`);
    assert.equal(calls().length, 1, 'a timeout never re-reads');
    pass(`list ok + get timeout -> credentials:get-timeout after ${result.elapsed_ms} ms, no retry`);
  }
  {
    const { result } = await signin('malformed');
    failedAt(result, 'credentials:get-malformed', 'malformed JSON');
    pass('get returns malformed JSON -> credentials:get-malformed');
  }
  for (const [mode, category] of [['no-username', 'schema-missing-username'], ['no-password', 'schema-missing-password'],
    ['duplicate-username', 'schema-duplicate-username'], ['duplicate-password', 'schema-duplicate-password']]) {
    const { result, typed, remembered } = await signin(mode);
    failedAt(result, `credentials:${category}`, mode);
    assert.equal(typed.size, 0, `${mode}: nothing typed`); assert.equal(remembered.length, 0, `${mode}: nothing kept`);
    pass(`valid JSON, ${mode} -> credentials:${category}, nothing typed`);
  }
  {
    const { result, typed } = await signin('no-username', 'confirm');
    assert.equal(result.outcome, 'signed_in', 'password-only page needs no username');
    assert.equal(typed.get('password'), CANARY.password); assert.equal(typed.has('username'), false);
    pass('password-only confirm page fills from an item without a username');
  }
  for (const mode of ['renamed-object', 'renamed-exit']) {
    const { result, typed } = await signin(mode);
    assert.equal(result.outcome, 'signed_in', mode);
    assert.equal(typed.get('username'), CANARY.username, `${mode}: username chosen by purpose USERNAME, not label`);
    assert.equal(typed.get('password'), CANARY.password, `${mode}: the login's password chosen by purpose, not a second "password" field`);
    assert.deepEqual(calls().map(call => call.args.includes('--fields')), [true, false]);
    pass(`username labelled "email" and a second "password" field (${mode}) fill by purpose after one full read`);
  }
  {
    const { result } = await signin('ok', 'login', { PATH: LAUNCHD_PATH });
    failedAt(result, 'credentials:binary-missing', 'binary missing');
    assert.equal(calls().length, 0);
    pass('op absent from a launchd-like PATH -> credentials:binary-missing');
  }
  {
    const { result } = await signin('ok', 'login', { GADDI_OP_TOKEN_FILE: path.join(home, 'absent') });
    failedAt(result, 'credentials:token-missing', 'token missing');
    fs.chmodSync(tokenFile, 0o000);
    const unreadable = await signin('ok');
    fs.chmodSync(tokenFile, 0o600);
    failedAt(unreadable.result, 'credentials:token-unreadable', 'token unreadable');
    const empty = path.join(home, 'empty'); fs.writeFileSync(empty, '\n', { mode: 0o600 });
    failedAt((await signin('ok', 'login', { GADDI_OP_TOKEN_FILE: empty })).result, 'credentials:token-empty', 'token empty');
    assert.equal(calls().length, 0, 'op never starts without a token');
    pass('token file missing, unreadable or empty -> credentials:token-missing / token-unreadable / token-empty');
  }
  {
    const { result, took } = await signin('slow', 'login', {}, 800);
    failedAt(result, 'credentials:budget', 'aggregate budget');
    assert.ok(took < 2000, `budget ended the wait: ${took} ms`);
    await new Promise(resolve => setTimeout(resolve, 2000)); // Let the slow fake finish on its own.
    pass('aggregate sign-in budget exhausted during get -> credentials:budget');
  }
  {
    environment('ok', { GADDI_OP_TOKEN_FILE: path.join(home, 'absent') });
    await assert.rejects(listLogins(), (error: unknown) => {
      const diagnostic = opDiagnostic('1password', error, 3.4, 'list-malformed');
      assert.deepEqual(diagnostic, { category: '1password:token-missing', elapsed_ms: 3 });
      return true;
    });
    pass('list stage failures carry their own 1password:<kind> category');
  }

  // The production handler: reply and audit carry step, category and elapsed ms, and no canary.
  environment('exit');
  const keys = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  fs.writeFileSync(path.join(home, 'unused.pub'), keys.publicKey.export({ type: 'spki', format: 'pem' }));
  fs.writeFileSync(path.join(home, 'policy.json'), JSON.stringify({ signin: { remember: [site] } }));
  let phase = 'form';
  const bridge = {
    connection: () => ({}), status: () => ({ connected: true }),
    request: async (method: string, params: BrokerParams = {}) => {
      if (method === 'chrome.tabs') return { tabs: [{ id: 7, url: site + '/login' }] };
      if (method === 'chrome.signinProbe') return phase === 'done' ? { url: site + '/home', signature: 'done', passwordPresent: false }
        : { url: site + '/login', signature: 'form', passwordPresent: true, username: '@u', password: '@p' };
      if (method === 'chrome.signinType') return { typed: true };
      if (method === 'chrome.signinSubmit') { if (params.signin?.kind === 'password') phase = 'done'; return { pressed: true }; }
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
    createApprovals, GateError, approvalRef, cleanURL, cleanDetail, approvalContext, createProofVerifier, approvalMessage,
    createGrants, checkGrant, parseGrantRequest, grantDetail, isGrantSpec, ruleString, createRemote,
    readUpload, UPLOAD_CHUNK, signinSite, listLogins, chooseLogin, runSignin, createLogin, getPassword, opDiagnostic, PASSWORD_UNAVAILABLE, createSigninSecrets,
    createBridge: () => bridge, isRecord, parseJSON, errorMessage, hasErrorCode, versionParam, waitParams, FRAME_TOOLS, redactURLs, redactURLText,
    createChromeHeal: () => ({ attached: () => {}, ensure: async () => null, status: () => ({}) }), chromeControls: () => ({}),
    wakeApprovalApp: (pending: readonly unknown[]) => wakeApprovalApp(pending, { launcher: '/usr/bin/true' }),
  });
  const source = stripTypeScriptTypes(fs.readFileSync(new URL('../../daemon/daemon.ts', import.meta.url), 'utf8'))
    .replace(/^#!.*\n/, '').replace(/^import .*;\n/gm, '');
  vm.runInContext(source, context);
  let serial = 0;
  async function rpc(params: BrokerParams): Promise<BrokerResult<'signin'>> {
    const lines: string[] = [], id = ++serial;
    context.input = { id, method: 'signin', params: { caller: 'op-failure-test', ...params } };
    context.conn = { destroyed: false, write: (line: string) => lines.push(line) };
    await vm.runInContext('handle(input, conn)', context);
    const response = JSON.parse(lines[0]) as Reply;
    assert.equal(response.error, undefined);
    leakFree(lines[0], 'broker reply');
    return response.result as BrokerResult<'signin'>;
  }
  try {
    const exit = await rpc({ tab: 7 });
    assert.equal(exit.category, 'credentials:get-exit'); assert.equal(exit.reason, PASSWORD_UNAVAILABLE); assert.equal(typeof exit.elapsed_ms, 'number');
    environment('ok', { GADDI_OP_TOKEN_FILE: path.join(home, 'absent') });
    const listed = await rpc({ tab: 7 });
    assert.equal(listed.step, '1password'); assert.equal(listed.category, '1password:token-missing'); assert.equal(listed.reason, PASSWORD_UNAVAILABLE);
    environment('ok'); phase = 'form';
    assert.equal((await rpc({ tab: 7 })).outcome, 'signed_in');
    const auditText = fs.readFileSync(path.join(home, 'audit.jsonl'), 'utf8');
    leakFree(auditText, 'audit');
    const rows = auditText.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>).filter(row => 'site' in row);
    assert.deepEqual(rows.map(row => [row.outcome, row.step, row.category, typeof row.elapsed_ms]), [
      ['needs_you', 'credentials', 'credentials:get-exit', 'number'], ['needs_you', '1password', '1password:token-missing', 'number'], ['signed_in', undefined, undefined, 'undefined']]);
    assert.equal(Object.keys(rows[2]).sort().join(','), 'item_title,outcome,site,ts', 'a successful sign-in keeps its four audit fields');
    pass('production broker reply and audit name step, category and elapsed ms, success rows unchanged, no canary');
  } finally { vm.runInContext('approvals.stop(); signinSecrets.stop()', context); }
} finally {
  process.env = oldEnvironment;
  try { fs.chmodSync(tokenFile, 0o600); } catch { /* already removed */ }
  fs.rmSync(home, { recursive: true, force: true }); // Only this test's temporary fixture.
}
console.log(`== signin op-failure: ${passed} passed, 0 failed`);
