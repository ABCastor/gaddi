// Pure checks of daemon/remote.ts: how a key becomes the trusted one, which requests can ever be answered from
// another device, and what makes one decision valid. No daemon, socket or browser. Every ASSERT_REMOTE_* name
// here is falsified by a mutation in tests/policy/remote.falsify.ts; the broker wiring around these rules is
// tested in tests/gates/remote-approver.test.sh.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GateError } from '../../daemon/approvals.ts';
import type { RemoteFacts, StoredApproval } from '../../daemon/approvals.ts';
import { parseGrantRules } from '../../daemon/grants.ts';
import type { GrantScope } from '../../daemon/grants.ts';
import { loadPolicy } from '../../daemon/policy.ts';
import { createRemote, REMOTE_GRANT_MINUTES } from '../../daemon/remote.ts';

const mode = process.argv[2] ?? 'normal';
const policy = loadPolicy({ overlay: '/nonexistent/gaddi-policy-overlay.json', off: false });
let passed = 0, failed = 0;
function check(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`PASS ${name}`); }
  catch (error) {
    failed++; process.exitCode = 1;
    console.log(`FAIL ASSERTION remote: ${name}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaddi-remote-unit-'));
process.on('exit', () => { fs.rmSync(dir, { recursive: true, force: true }); }); // Only this test's disposable folder.
const bot = crypto.generateKeyPairSync('ed25519'), stranger = crypto.generateKeyPairSync('ed25519');
const owner = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pem = (key: KeyObject) => String(key.export({ type: 'spki', format: 'pem' }));
const fingerprintOf = (key: KeyObject) => crypto.createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex');
const refusedWith = (code: string) => (error: unknown) => error instanceof GateError && error.code === code;

// The owner's Touch ID proof and the single-use journal, stood in for: the proof is good only if it says `owner`.
function fakeProofs() {
  const verified: string[] = [], journal = new Set<string>();
  return {
    verified,
    verify: (proof: unknown, message: string): undefined => {
      verified.push(message);
      if (typeof proof !== 'object' || proof === null || !('sig' in proof) || proof.sig !== 'owner') throw new GateError('proof-invalid', 'not the owner');
    },
    spend: (entries: string[]) => {
      if (entries.some(entry => journal.has(entry))) throw new GateError('proof-invalid', 'signature or nonce already used');
      for (const entry of entries) journal.add(entry);
    },
  };
}
function open(home: string) {
  const events: [string, unknown][] = [], logs: string[] = [], proofs = fakeProofs();
  const statePath = path.join(home, 'remote.json'), keyPath = path.join(home, 'remote-approver.pub');
  const remote = createRemote({ statePath, keyPath, proofs, emit: (event, data) => { events.push([event, data]); },
    log: (...args) => { logs.push(args.map(String).join(' ')); } });
  return { home, remote, proofs, events, logs, statePath, keyPath };
}
let sequence = 0;
function fresh() {
  const home = path.join(dir, `home-${++sequence}`);
  fs.mkdirSync(home);
  return open(home);
}

// ---------------------------------------------------------------- a key becomes the trusted one
check('ASSERT_REMOTE_KEYS', () => {
  const { home, remote, proofs, events, statePath, keyPath } = fresh();
  assert.deepEqual(remote.status(), { enabled: false, candidate: null }, 'off, and no key, to begin with');
  const fp = fingerprintOf(bot.publicKey);
  fs.writeFileSync(keyPath, pem(bot.publicKey));
  assert.deepEqual(remote.status(), { enabled: false, candidate: { fingerprint: fp } }, 'a dropped key is only a candidate');
  for (const [why, text] of [['another kind of key', pem(owner.publicKey)], ['a private key', String(bot.privateKey.export({ type: 'pkcs8', format: 'pem' }))],
    ['junk', 'not a key'], ['too large', pem(bot.publicKey) + ' '.repeat(5000)]] as const) {
    fs.writeFileSync(keyPath, text);
    assert.equal(remote.status().candidate, null, `${why} is not a candidate`);
  }
  fs.writeFileSync(keyPath, pem(bot.publicKey));
  assert.throws(() => remote.enable('nope', { sig: 'owner' }), refusedWith('approval-invalid'));
  assert.deepEqual(proofs.verified, [], 'a malformed fingerprint never reaches the proof');
  assert.throws(() => remote.enable(fp, undefined), refusedWith('proof-invalid'), 'no proof, no key');
  assert.throws(() => remote.enable(fingerprintOf(stranger.publicKey), { ts: 1, sig: 'owner' }), refusedWith('approval-invalid'), 'the owner signed another key');
  assert.equal(remote.enabled(), false, 'none of that turned it on');
  assert.ok(!fs.existsSync(statePath), 'and none of it saved anything');
  const on = remote.enable(fp, { ts: 1234, sig: 'owner' });
  assert.equal(on.enabled, true); assert.equal(on.fingerprint, fp);
  assert.equal(proofs.verified.at(-1), `remote.enable|${fp}|1234`, 'the owner signs the fingerprint and the time');
  assert.equal(fs.statSync(statePath).mode & 0o777, 0o600, 'the saved choice is private');
  assert.deepEqual(events.at(-1), ['remote.changed', { enabled: true, fingerprint: fp }]);
  fs.writeFileSync(keyPath, pem(stranger.publicKey));
  assert.equal(remote.status().fingerprint, fp, 'a swapped file changes nothing');
  assert.equal(remote.status().candidate?.fingerprint, fingerprintOf(stranger.publicKey), 'it is only a candidate');
  const back = open(home);
  assert.equal(back.remote.enabled(), true, 'the choice is read back after a restart');
  assert.equal(back.remote.status().fingerprint, fp);
  const now = new Date().toISOString();
  for (const [why, text] of [
    ['not JSON', 'not json'],
    ['a key of another kind', JSON.stringify({ publicKey: pem(owner.publicKey), fingerprint: fingerprintOf(owner.publicKey), enabledAt: now })],
    ['a fingerprint that is not the key\'s', JSON.stringify({ publicKey: pem(bot.publicKey), fingerprint: fingerprintOf(stranger.publicKey), enabledAt: now })],
    ['a missing field', JSON.stringify({ publicKey: pem(bot.publicKey), fingerprint: fp })],
    ['an unreadable date', JSON.stringify({ publicKey: pem(bot.publicKey), fingerprint: fp, enabledAt: 'someday' })],
  ] as const) {
    fs.writeFileSync(statePath, text);
    const broken = open(home);
    assert.equal(broken.remote.enabled(), false, `${why}: off`);
    assert.ok(broken.logs.some(line => /invalid/.test(line)), `${why}: logged`);
  }
  const off = remote.disable();
  assert.equal(off.enabled, false); assert.ok(!fs.existsSync(statePath), 'turning it off removes the saved choice');
  assert.deepEqual(events.at(-1), ['remote.changed', { enabled: false }]);
  const announced = events.length;
  remote.disable();
  assert.equal(events.length, announced, 'turning it off twice says nothing the second time');
});

// ---------------------------------------------------------------- which requests can ever be answered remotely
check('ASSERT_REMOTE_KINDS', () => {
  const { remote, keyPath } = fresh();
  fs.writeFileSync(keyPath, pem(bot.publicKey));
  const record = (fields: Record<string, unknown>): StoredApproval => ({ id: 'a1', status: 'pending', caller: 'agent', detail: 'x', ...fields });
  const facts = (reason: string, scope: GrantScope, pageURL = 'https://shop.example/account'): RemoteFacts => ({ pageURL, reason, scope });
  const post = facts('verb:post', { kind: 'click', name: 'Post' });
  assert.equal(remote.eligible(record({ kind: 'click' }), post, policy), false, 'off means no');
  remote.enable(fingerprintOf(bot.publicKey), { ts: 1, sig: 'owner' });
  assert.equal(remote.eligible(record({ kind: 'click' }), post, policy), true, 'an in-scope hold while on');
  assert.equal(remote.eligible(record({ kind: 'press' }), facts('enter-submits:post', { kind: 'press', name: 'Post' }), policy), true);
  assert.equal(remote.eligible(record({ kind: 'upload' }), facts('upload of a local file', { kind: 'upload' }), policy), true);
  for (const status of ['granted', 'used', 'denied', 'cancelled', 'expired', undefined]) {
    assert.equal(remote.eligible(record({ kind: 'click', status }), post, policy), false, `a request that is ${String(status)} is not waiting`);
  }
  assert.equal(remote.eligible(record({ kind: 'click' }), undefined, policy), false, 'no facts, no remote answer');
  assert.equal(remote.eligible(record({ kind: 'click' }), facts('upload of a local file', { kind: 'upload' }), policy), false, 'facts of another kind');
  // Whatever the facts say, none of these is ever answered from another device.
  for (const kind of ['signin', 'goto', 'open', 'eval', 'type', 'hover', 'select', 'scroll', 'extension.disable', 'extension.uninstall',
    'extension.install', 'bookmarks', 'nonsense']) {
    assert.equal(remote.eligible(record({ kind }), post, policy), false, kind);
  }
  assert.equal(remote.eligible(record({}), post, policy), false, 'a record with no kind');
  for (const [reason, name] of [['verb:pay now', 'Pay now'], ['verb:send', 'Send'], ['verb:buy', 'Buy'], ['verb:change password', 'Change password'],
    ['verb:post', 'Post and pay'], ['url-pattern:/checkout', 'Read more']]) {
    assert.equal(remote.eligible(record({ kind: 'click' }), facts(reason, { kind: 'click', name }), policy), false, name);
  }
  assert.equal(remote.eligible(record({ kind: 'click' }), facts('verb:post', { kind: 'click', name: 'Post' }, 'https://shop.example/checkout'), policy), false, 'a protected page');
  assert.equal(REMOTE_GRANT_MINUTES, 120, 'two hours');
  const spec = (minutes: number) => ({ session: 'session:a', rules: parseGrantRules(['upload https://shop.example/account'], policy), minutes });
  for (const [minutes, expected] of [[5, true], [60, true], [120, true], [121, false], [720, false]] as const) {
    assert.equal(remote.eligible(record({ kind: 'grant', grant: spec(minutes) }), undefined, policy), expected, `a session grant of ${minutes} minutes`);
  }
  assert.equal(remote.eligible(record({ kind: 'grant' }), undefined, policy), false, 'a grant request without its spec');
  assert.equal(remote.eligible(record({ kind: 'grant', grant: { minutes: 60 } }), undefined, policy), false, 'or with a broken one');
});

// ---------------------------------------------------------------- what makes one decision valid
check('ASSERT_REMOTE_DECISION', () => {
  const { remote, keyPath } = fresh();
  fs.writeFileSync(keyPath, pem(bot.publicKey));
  const target: StoredApproval = { id: 'abc123', kind: 'click', status: 'pending', detail: 'Post' };
  const digest = crypto.createHash('sha256').update('click|abc123|Post').digest('hex');
  const sign = (verb: string, nonce: string, ts: number, key: KeyObject = bot.privateKey, over = digest) =>
    crypto.sign(null, Buffer.from(`gaddi-remote|${verb}|abc123|click|${over}|${nonce}|${ts}`), key).toString('base64');
  const now = Date.now();
  let n = 0;
  const nonce = () => `nonce-${String(++n).padStart(12, '0')}`;
  const request = (verb: string, tweak: { nonce?: string; ts?: number; key?: KeyObject; over?: string } = {}) => {
    const value = tweak.nonce ?? nonce(), ts = tweak.ts ?? now;
    return { verb, nonce: value, ts, sig: sign(verb, value, ts, tweak.key, tweak.over) };
  };
  assert.throws(() => remote.verify(target, request('grant')), refusedWith('denied'), 'off means no');
  remote.enable(fingerprintOf(bot.publicKey), { ts: 1, sig: 'owner' });
  const first = request('grant');
  assert.equal(remote.verify(target, first), 'grant', 'a good decision');
  assert.throws(() => remote.verify(target, first), refusedWith('proof-invalid'), 'is good once');
  // A different decision (so a different signature) under the same nonce: only the nonce can refuse it.
  assert.throws(() => remote.verify(target, request('deny', { nonce: first.nonce })), refusedWith('proof-invalid'), 'a nonce is used once');
  assert.equal(remote.verify(target, request('deny')), 'deny', 'a denial is a decision too');
  const bad: [string, Record<string, unknown>][] = [
    ['another key', request('grant', { key: stranger.privateKey })],
    ['another request\'s text', request('grant', { over: crypto.createHash('sha256').update('click|abc123|Delete').digest('hex') })],
    ['an unknown verb', { ...request('grant'), verb: 'approve' }],
    ['the other verb', { ...request('grant'), verb: 'deny' }],
    ['a short nonce', request('grant', { nonce: 'short' })],
    ['a nonce with odd characters', request('grant', { nonce: 'bad nonce bad nonce!' })],
    ['a nonce that is too long', request('grant', { nonce: 'n'.repeat(129) })],
    ['a time two minutes ago', request('grant', { ts: now - 130000 })],
    ['a time two minutes ahead', request('grant', { ts: now + 130000 })],
    ['a time with a fraction', request('grant', { ts: now + 0.5 })],
    ['a time written as text', { ...request('grant'), ts: String(now) }],
    ['no signature', { ...request('grant'), sig: undefined }],
    ['a signature of the wrong length', { ...request('grant'), sig: 'AAAA' }],
    ['a signature that is not base64', { ...request('grant'), sig: '!'.repeat(88) }],
  ];
  for (const [why, params] of bad) assert.throws(() => remote.verify(target, params), refusedWith('proof-invalid'), why);
  assert.equal(remote.verify(target, request('grant', { ts: now - 100000 })), 'grant', 'a phone may be slower than a fingerprint reader');
});

console.log(`== remote (${mode}): ${passed} passed, ${failed} failed`);
