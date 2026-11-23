// OWNER-NEEDED through the real broker: a sign-in that hands back needs_you because only the user can act emits one
// owner.needed event with fixed fields, rate-limited per tab and step, withdrawn when the tab closes (through Gaddi or
// in Chrome), the agent's session ends, the same tab later signs in, Chrome reattaches or the notice expires; ordinary
// work emits nothing. Fake op and a fake bridge only: no browser, no real login, no real 1Password. Canary strings
// stand in for the username, password, item title, op output and the page's URL path and query; none may reach an event.
// GADDI_OWNER_ROOT runs a disposable (mutated) copy of the broker instead of this tree.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { isRecord } from '../../shared/protocol.ts';
import type { BrokerParams, ChromeRequest, Reply, SigninResult } from '../../shared/protocol.ts';
import { approvalMessage } from '../../daemon/proof.ts';
import { PASSWORD_UNAVAILABLE } from '../../daemon/signin.ts';
import type * as OwnerNeeded from '../../daemon/owner-needed.ts';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gaddi-owner-needed-'));
const socket = path.join(home, 'broker.sock');
const repo = path.resolve(import.meta.dirname, '../..');
const root = process.env.GADDI_OWNER_ROOT ? path.resolve(process.env.GADDI_OWNER_ROOT) : repo;
const { ownerReason } = await import(path.join(root, 'daemon/owner-needed.ts')) as typeof OwnerNeeded;
const CANARY = { username: 'canary-owner@example.test', password: 'CANARY_OWNER_PW_4471', title: 'CANARY_TITLE_Ledger',
  stderr: 'CANARY_OP_STDERR_8812', query: 'CANARY_QUERY_5530', path: 'canary-path-2fa' };
const TTL_MS = 5000;
const lockFlag = path.join(home, 'op-locked'), launches = path.join(home, 'launches.txt');
const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
fs.writeFileSync(path.join(home, 'approver.pub'), publicKey.export({ type: 'spki', format: 'pem' }));
// The fake op: lists one login; reading it fails (a locked or unreachable 1Password) while the lock flag exists.
fs.writeFileSync(path.join(home, 'op'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[1] === 'list') { console.log(JSON.stringify([{ id: 'owner-login', title: ${JSON.stringify(CANARY.title)}, urls: [{ href: process.env.OWNER_SITE }] }])); process.exit(0); }
if (fs.existsSync(${JSON.stringify(lockFlag)})) { process.stderr.write(${JSON.stringify(CANARY.stderr)}); process.exit(1); }
console.log(JSON.stringify([{ label: 'username', value: ${JSON.stringify(CANARY.username)} }, { label: 'password', value: ${JSON.stringify(CANARY.password)} }]));
`, { mode: 0o700 });
fs.writeFileSync(path.join(home, 'launcher'), `#!/bin/sh\necho "$@" >> ${JSON.stringify(launches)}\n`, { mode: 0o700 });
fs.writeFileSync(path.join(home, 'agent-cred'), 'agent-value-from-file\n', { mode: 0o600 });
const site = 'http://127.0.0.1:18997';
const env = { ...process.env, PATH: `${home}:${process.env.PATH}`, OWNER_SITE: site, GADDI_OP_TOKEN_FILE: path.join(home, 'agent-cred'),
  GADDI_OP_HOME: path.join(home, 'op-home'), GADDI_HOME: home, GADDI_SOCKET: socket, GADDI_AUDIT: path.join(home, 'audit.jsonl'),
  GADDI_STATE: path.join(home, 'state.json'), GADDI_APPROVER_PUB: path.join(home, 'approver.pub'), GADDI_APP_LAUNCHER: path.join(home, 'launcher'),
  GADDI_POLICY_OFF: '0', GADDI_OWNER_NOTICE_MS: String(TTL_MS), GADDI_SESSION_SWEEP_MS: '250', OMNIREAD_BIN: path.join(home, 'missing-omniread') };
const daemon = spawn(process.execPath, [path.join(root, 'daemon/daemon.mjs')], { env });
let stderr = '', passed = 0;
daemon.stderr.on('data', chunk => { stderr += chunk; });
daemon.stdout.resume();
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const clients = new Set<net.Socket>();
const pass = (name: string) => { passed++; console.log(`PASS ${name}`); };
function connect() {
  const connection = net.connect(socket); clients.add(connection); connection.setEncoding('utf8');
  connection.on('error', () => {});
  return connection;
}
function call(method: string, params: BrokerParams = {}, connection = connect(), keep = false): Promise<Reply> {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => { connection.destroy(); reject(new Error(`Test broker timeout: ${method}`)); }, 35000);
    const send = () => connection.write(JSON.stringify({ id, method, params: { caller: 'owner-test', ...params } }) + '\n');
    if (connection.connecting) connection.once('connect', send); else send();
    const onData = (chunk: string) => {
      buffer += chunk;
      const end = buffer.indexOf('\n'); if (end < 0) return;
      clearTimeout(timer); connection.off('data', onData);
      if (!keep) connection.destroy();
      resolve(JSON.parse(buffer.slice(0, end)) as Reply);
    };
    connection.on('data', onData);
  });
}
async function result(method: string, params: BrokerParams = {}) {
  const reply = await call(method, params); assert.equal(reply.error, undefined, `${method}: ${reply.error?.message}`); return reply.result;
}
// Fake Chrome: one page per tab. 'key' asks for a security key after the password; 'ok' signs in.
type Mode = 'key' | 'ok';
const tabs = new Map<number, { mode: Mode; phase: 'form' | 'after' }>();
const shows: number[] = [];
const pageURL = (tab: number) => {
  const state = tabs.get(tab)!;
  if (state.phase === 'form') return `${site}/login`;
  return state.mode === 'key' ? `${site}/${CANARY.path}?user=${CANARY.query}&tab=${tab}` : `${site}/home`;
};
function probe(tab: number) {
  const state = tabs.get(tab)!;
  if (state.phase === 'form') return { url: pageURL(tab), signature: 'form', username: '@abcdef:1', password: '@abcdef:2', passwordPresent: true };
  return state.mode === 'key' ? { url: pageURL(tab), signature: 'key', challenge: true } : { url: pageURL(tab), signature: 'home', passwordPresent: false };
}
function serveBridge(bridge: net.Socket) {
  let buffer = '';
  bridge.write(JSON.stringify({ id: 'attach', method: 'bridge.attach', params: { kind: 'chrome' } }) + '\n');
  bridge.on('data', chunk => {
    buffer += chunk; let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const request = JSON.parse(buffer.slice(0, end)) as ChromeRequest; buffer = buffer.slice(end + 1);
      if (request.id === 'attach') continue;
      const tab = Number(request.params?.tab);
      let value: unknown;
      if (request.method === 'chrome.tabs') value = { tabs: [...tabs.keys()].map(id => ({ id, url: pageURL(id), title: 'Fixture' })) };
      else if (request.method === 'chrome.cleanup') value = { tabs: [], closed: [] };
      else if (request.method === 'chrome.active') value = { id: 7, url: pageURL(7), title: 'Fixture' };
      else if (request.method === 'chrome.signinProbe') value = probe(tab);
      else if (request.method === 'chrome.signinType') value = { typed: true };
      else if (request.method === 'chrome.signinSubmit') {
        if (request.params.signin?.kind === 'password') tabs.get(tab)!.phase = 'after';
        value = { pressed: true };
      }
      else if (request.method === 'chrome.read') value = { tab, url: pageURL(tab), text: 'Security key needed', outline: '', scroll: { y: 0, height: 1 } };
      else if (request.method === 'chrome.show') { shows.push(tab); value = { id: tab, windowId: 1, index: 0, active: true, title: 'Fixture', url: pageURL(tab) }; }
      else if (request.method === 'chrome.close') {
        const closed = (request.params.tabs ?? []).filter(id => tabs.delete(id));
        value = { closed, failed: [] };
      }
      else { bridge.write(JSON.stringify({ id: request.id, error: { message: `unexpected ${request.method}` } }) + '\n'); continue; }
      bridge.write(JSON.stringify({ id: request.id, result: value }) + '\n');
    }
  });
}
// Every owner.* event the broker published, in order.
type OwnerEvent = { event: string; data: Record<string, unknown> };
const events: OwnerEvent[] = [];
const allEvents: string[] = [];
const needed = (tab?: number) => events.filter(e => e.event === 'owner.needed' && (tab === undefined || e.data.tab === tab));
const withdrawn = (id: unknown) => events.filter(e => e.event === 'owner.withdrawn' && e.data.id === id);
const reset = (tab: number, mode: Mode) => tabs.set(tab, { mode, phase: 'form' });
const signin = async (tab: number, params: BrokerParams = {}) => {
  const value = await result('signin', { tab, ...params }); assert.ok(isRecord(value)); return value as unknown as SigninResult;
};
async function grantRemember() {
  const list = await result('approvals.list'); assert.ok(isRecord(list) && Array.isArray(list.pending));
  const approval = list.pending.at(-1); assert.ok(isRecord(approval) && approval.kind === 'signin');
  const ts = Date.now(), message = approvalMessage('grant', approval, ts, true);
  const proof = { ts, sig: crypto.sign('sha256', Buffer.from(message), privateKey).toString('base64') };
  await result('approval.grant', { id: String(approval.id), proof, remember: true });
  return String(approval.id);
}
const settle = () => delay(150);
try {
  // Answers the agent handles itself never ask the user, whatever the outcome or reason.
  const quiet: SigninResult[] = [
    { outcome: 'no_login', site, reason: 'No matching login' }, { outcome: 'choose', site, reason: '["a","b"]' },
    { outcome: 'failed', site, reason: 'Sign-in unavailable or site refused' }, { outcome: 'filled', site }, { outcome: 'submitted', site },
    { outcome: 'needs_you', site, step: 'approval', reason: 'held: approve x in Gaddi, then retry with approval=x' },
    { outcome: 'needs_you', site, step: 'username', reason: 'Login form changed' },
    { outcome: 'needs_you', site, reason: 'No supported signup form. No item created.' },
    { outcome: 'needs_you', site, step: 'submit', reason: 'Additional verification required' }];
  for (const answer of quiet) assert.equal(ownerReason(answer), undefined, `ASSERT_OWNER_QUIET: ${JSON.stringify(answer)} asks nothing of the owner`);
  pass(`${quiet.length} agent-side answers (no login, choice, failure, fill, approval card, changed form) ask nothing of the owner`);
  for (let n = 0; n < 150 && !fs.existsSync(socket) && daemon.exitCode === null; n++) await delay(20);
  if (!fs.existsSync(socket) && /EPERM|operation not permitted/i.test(stderr)) {
    console.log('SKIP owner-needed: sandbox refused private Unix socket listen (EPERM)'); process.exitCode = 77;
  } else {
    assert.ok(fs.existsSync(socket), `broker did not start: ${stderr.slice(-400)}`);
    let bridge = connect(); serveBridge(bridge);
    const subscriber = connect(); let feed = '';
    subscriber.on('data', chunk => {
      feed += chunk; let end;
      while ((end = feed.indexOf('\n')) >= 0) {
        const line = feed.slice(0, end); feed = feed.slice(end + 1);
        const message = JSON.parse(line) as Record<string, unknown>;
        if (typeof message.event !== 'string') continue;
        allEvents.push(line);
        if (message.event.startsWith('owner.')) events.push({ event: message.event, data: message.data as Record<string, unknown> });
      }
    });
    await call('events.subscribe', {}, subscriber, true);
    for (let n = 0; n < 100; n++) { const state = await result('bridge.status'); if (isRecord(state) && state.connected) break; await delay(10); }
    reset(7, 'key');

    // Ordinary work and answers the agent handles itself make no notice: a look, an approval hold, no login, a choice.
    await result('look', { tab: 7 });
    const held = await signin(7); assert.equal(held.outcome, 'needs_you'); assert.equal(held.step, 'approval');
    const approval = await grantRemember();
    void approval;
    await settle();
    assert.equal(needed().length, 0, 'ASSERT_OWNER_QUIET: look and an approval hold emit no owner notice');
    pass('ordinary look and a held sign-in (the card already asks) emit no owner notice');

    // A security key after the password: the agent hears needs_you, the user gets one notice with fixed fields.
    const keyed = await signin(7);
    assert.equal(keyed.outcome, 'needs_you'); assert.equal(keyed.reason, 'Additional verification required');
    await settle();
    assert.equal(needed(7).length, 1, 'ASSERT_OWNER_NEEDED_EMITTED: a needs_you the owner must act on emits owner.needed');
    const first = needed(7)[0].data;
    for (const [name, canary] of Object.entries(CANARY))
      assert.ok(!JSON.stringify(first).includes(canary), `ASSERT_OWNER_NO_LEAK: the notice carries the ${name} canary`);
    assert.deepEqual(Object.keys(first).sort(), ['expiresAt', 'id', 'origin', 'reason', 'step', 'tab'], 'ASSERT_OWNER_NEEDED_EMITTED: fixed fields only');
    assert.equal(first.tab, 7, 'ASSERT_OWNER_NEEDED_EMITTED: the tab');
    assert.equal(first.origin, site, 'ASSERT_OWNER_NEEDED_EMITTED: the site origin');
    assert.equal(first.step, 'password', 'ASSERT_OWNER_NEEDED_EMITTED: the step');
    assert.equal(first.reason, 'a verification step needs you (security key, passkey, code or puzzle)', 'ASSERT_OWNER_NEEDED_EMITTED: a fixed reason');
    assert.ok(Math.abs(Date.parse(String(first.expiresAt)) - Date.now() - TTL_MS) < 2000, 'ASSERT_OWNER_NEEDED_EMITTED: expiresAt names the bound');
    assert.ok(fs.existsSync(launches) && fs.readFileSync(launches, 'utf8').includes('com.abcastor.gaddi'), 'ASSERT_OWNER_WAKES_APP: the app is woken to show it');
    pass('security key after the password: one owner.needed {id, tab, origin, step, reason, expiresAt}; the app is woken');

    // A polling agent cannot repeat the banner.
    for (let n = 0; n < 3; n++) { reset(7, 'key'); assert.equal((await signin(7)).outcome, 'needs_you'); }
    await settle();
    assert.equal(needed(7).length, 1, 'ASSERT_OWNER_RATE_LIMIT: repeated needs_you on the same tab and step emit no second notice');
    pass('three more polls on the same tab and step: still one notice');

    // Clicking the notice shows the tab through browser_show's path. It is no consent: the page still decides.
    const listed = await result('owner.notices');
    assert.ok(isRecord(listed) && Array.isArray(listed.notices) && listed.notices.length === 1 && isRecord(listed.notices[0]) && listed.notices[0].id === first.id);
    const shown = await result('owner.show', { id: String(first.id) });
    assert.ok(isRecord(shown) && shown.id === 7);
    assert.deepEqual(shows, [7], 'ASSERT_OWNER_SHOW: a click shows exactly the notice\'s tab');
    reset(7, 'key');
    assert.equal((await signin(7)).outcome, 'needs_you', 'ASSERT_OWNER_ACK_NOT_SUCCESS: showing the tab is not signing in');
    await settle();
    assert.equal(withdrawn(first.id).length, 0, 'ASSERT_OWNER_ACK_NOT_SUCCESS: the click does not end the notice');
    pass('owner.show shows the notice\'s tab; the next signin still judges the page (needs_you), the notice stays');

    // The user touched the key: the same tab now signs in, and the notice is withdrawn.
    reset(7, 'ok');
    assert.equal((await signin(7)).outcome, 'signed_in');
    await settle();
    assert.equal(withdrawn(first.id).length, 1, 'ASSERT_OWNER_WITHDRAW_SIGNED_IN: signed_in on the same tab withdraws the notice');
    assert.equal(withdrawn(first.id)[0].data.why, 'signed_in');
    const ended = await call('owner.show', { id: String(first.id) });
    assert.match(String(ended.error?.message), /that notice has ended/, 'ASSERT_OWNER_SHOW_ENDED: an ended notice shows nothing');
    assert.deepEqual(shows, [7], 'ASSERT_OWNER_SHOW_ENDED: no further show');
    assert.deepEqual((await result('owner.notices') as { notices: unknown[] }).notices, []);
    pass('signed_in withdraws the notice; clicking it afterwards shows nothing');

    // A locked 1Password on another tab: its own notice; closing that tab through Gaddi withdraws it.
    reset(8, 'key'); fs.writeFileSync(lockFlag, '1');
    const locked = await signin(8);
    fs.rmSync(lockFlag);
    assert.equal(locked.outcome, 'needs_you'); assert.equal(locked.reason, PASSWORD_UNAVAILABLE);
    await settle();
    assert.equal(needed(8).length, 1, 'ASSERT_OWNER_NEEDED_EMITTED: a locked 1Password emits owner.needed');
    const lockNotice = needed(8)[0].data;
    assert.equal(lockNotice.step, 'credentials'); assert.equal(lockNotice.reason, '1Password is locked or unreachable');
    await result('close', { tabs: [8] });
    await settle();
    assert.ok(withdrawn(lockNotice.id).length <= 1, 'ASSERT_OWNER_WITHDRAW_CLOSED: withdrawn once');
    assert.equal(withdrawn(lockNotice.id)[0]?.data.why, 'closed', 'ASSERT_OWNER_WITHDRAW_CLOSED: withdrawn by the close itself, not a later sweep');
    pass('locked 1Password: notice on its tab with step credentials; closing the tab through Gaddi withdraws it');

    // The user closes the tab in Chrome itself: the broker's sweep notices and withdraws.
    reset(9, 'key');
    await signin(9); await settle();
    const gone = needed(9)[0]?.data;
    assert.ok(gone, 'ASSERT_OWNER_NEEDED_EMITTED: tab 9 noticed');
    tabs.delete(9);
    for (let n = 0; n < 40 && !withdrawn(gone.id).length; n++) await delay(100);
    assert.equal(withdrawn(gone.id).length, 1, 'ASSERT_OWNER_WITHDRAW_GONE: a tab closed in Chrome withdraws its notice');
    assert.equal(withdrawn(gone.id)[0].data.why, 'gone', 'ASSERT_OWNER_WITHDRAW_GONE: withdrawn because Chrome no longer has the tab');
    pass('a tab the owner closed in Chrome: the sweep withdraws its notice');

    // The agent's session ends: its notices go.
    const lifetime = connect();
    const session = 'owner-session-' + crypto.randomUUID();
    assert.equal((await call('session.begin', { session }, lifetime, true)).error, undefined);
    reset(10, 'key');
    await signin(10, { session }); await settle();
    const sessional = needed(10)[0]?.data;
    assert.ok(sessional, 'ASSERT_OWNER_NEEDED_EMITTED: tab 10 noticed');
    lifetime.destroy();
    for (let n = 0; n < 40 && !withdrawn(sessional.id).length; n++) await delay(50);
    assert.equal(withdrawn(sessional.id).length, 1, 'ASSERT_OWNER_WITHDRAW_SESSION: the agent\'s session ending withdraws its notice');
    assert.equal(withdrawn(sessional.id)[0].data.why, 'session-ended');
    pass('the agent\'s session ends: its notice is withdrawn');

    // An unanswered notice expires.
    reset(11, 'key');
    await signin(11); await settle();
    const stale = needed(11)[0]?.data;
    assert.ok(stale, 'ASSERT_OWNER_NEEDED_EMITTED: tab 11 noticed');
    for (let n = 0; n < (TTL_MS + 2000) / 100 && !withdrawn(stale.id).length; n++) await delay(100);
    assert.equal(withdrawn(stale.id).length, 1, 'ASSERT_OWNER_EXPIRES: an unanswered notice is withdrawn at its bound');
    assert.equal(withdrawn(stale.id)[0].data.why, 'expired');
    pass(`an unanswered notice expires after ${TTL_MS} ms (10 minutes by default)`);

    // Chrome reattached (a restart may reuse tab numbers): every notice goes.
    reset(12, 'key');
    await signin(12); await settle();
    const before = needed(12)[0]?.data;
    assert.ok(before, 'ASSERT_OWNER_NEEDED_EMITTED: tab 12 noticed');
    const replacement = connect(); serveBridge(replacement);
    for (let n = 0; n < 40 && !withdrawn(before.id).length; n++) await delay(50);
    assert.equal(withdrawn(before.id).length, 1, 'ASSERT_OWNER_WITHDRAW_REATTACH: a reattached Chrome withdraws every notice');
    bridge = replacement;
    pass('Chrome reattached: every notice is withdrawn (tab numbers may be reused)');

    // Privacy: no event carries a credential, the item title, op output, or the page's path or query.
    // The approval card and the sign-in audit line name the item already (by design); owner notices never do.
    const owner = JSON.stringify(events), text = allEvents.join('\n') + fs.readFileSync(env.GADDI_AUDIT, 'utf8');
    for (const [name, canary] of Object.entries(CANARY)) assert.ok(!owner.includes(canary), `ASSERT_OWNER_NO_LEAK: an owner event carries the ${name} canary`);
    for (const name of ['username', 'password', 'stderr'] as const) assert.ok(!text.includes(CANARY[name]), `ASSERT_OWNER_NO_LEAK: an event or audit line carries the ${name} canary`);
    for (const event of events) assert.ok(!JSON.stringify(event).includes('?'), 'ASSERT_OWNER_NO_LEAK: no URL query in a notice');
    assert.ok(!stderr.includes(CANARY.password) && !stderr.includes(CANARY.username), 'ASSERT_OWNER_NO_LEAK: broker log');
    pass('no owner event carries the username, password, item title, op output, URL path or query');
    console.log(`== owner-needed: ${passed} passed, 0 failed`);
  }
} finally {
  for (const client of clients) client.destroy();
  daemon.kill('SIGTERM');
  if (daemon.exitCode === null && daemon.signalCode === null) await once(daemon, 'exit');
  fs.rmSync(home, { recursive: true, force: true }); // Only this test's temporary fixture.
}
