// AUTH-WAIT and AUTH-LARGE-GRANT: docs/authorization.md, optional approval settings.
// Consumer flow with actual P-256 signatures and an isolated proof journal.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApprovals } from '../../daemon/approvals.ts';
import { approvalMessage, createProofVerifier } from '../../daemon/proof.ts';
import { loadPolicy } from '../../daemon/policy.ts';
import { parseGrantRules, parseGrantRequest, createGrants, isGrantSpec } from '../../daemon/grants.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaddi-wait-'));
const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pub = path.join(dir, 'approver.pub');
fs.writeFileSync(pub, publicKey.export({ type: 'spki', format: 'pem' }));
const verifier = createProofVerifier({ publicKeyPath: pub, usedPath: path.join(dir, 'used') });
const realNow = Date.now;
const perfDescriptor = Object.getOwnPropertyDescriptor(performance, 'now');
let now = realNow();
Date.now = () => now;
const stores: ReturnType<typeof createApprovals>[] = [];
const store = (waitMinutes?: number) => {
  const a = createApprovals({ ttlMinutes: 10, ...(waitMinutes === undefined ? {} : { waitMinutes }) });
  stores.push(a); return a;
};
const action = { method: 'click', caller: 'test-owner', url: 'https://example.test/notes', tab: 7, selector: '#publish' };
function hold(a: ReturnType<typeof createApprovals>, extendedWait = false) {
  return a.hold({ kind: 'click', caller: action.caller, url: action.url, detail: 'Publish note',
    reason: 'verb:publish', action, extendedWait });
}
function approve(a: ReturnType<typeof createApprovals>, id: unknown) {
  const ts = now;
  const sig = crypto.sign('sha256', Buffer.from(approvalMessage('grant', a.get(id), ts)), privateKey).toString('base64');
  a.signed(id, 'grant', { ts, sig }, verifier, approvalMessage);
}
try {
  const legacy = store();
  const first = hold(legacy, true);
  now += 11 * 60000;
  assert.equal(legacy.get(first.id).status, 'expired', 'default must retain ten-minute wait');
  const a = store(720);
  const extended = hold(a, true);
  const restricted = a.hold({ kind: 'signin', caller: action.caller, url: action.url,
    detail: 'Sign in', action: { ...action, method: 'signin' } });
  now += 2 * 60 * 60000;
  assert.equal(a.get(extended.id).status, 'pending', 'eligible request survives hours while unapproved');
  assert.equal(a.get(restricted.id).status, 'expired', 'restricted requests keep their original wait');
  assert.throws(() => a.consume(extended.id, action), /still pending/);
  approve(a, extended.id);
  assert.equal(Date.parse(String(a.get(extended.id).expiresAt)), now + 10 * 60000, 'approval does not create hours of authority');
  assert.throws(() => a.consume(extended.id, { ...action, tab: 8 }), /different action/, 'long wait must not weaken exact action binding');
  assert.equal(a.consume(extended.id, action).status, 'used');
  assert.throws(() => a.consume(extended.id, action), /is used/, 'one use only');
  const expired = hold(a, true);
  approve(a, expired.id);
  now += 11 * 60000;
  assert.equal(a.get(expired.id).status, 'expired', 'unused authority ends after ten minutes');
  const restart = hold(a, true);
  approve(a, restart.id);
  const restored = store(720);
  restored.restore(JSON.parse(JSON.stringify(a.persistable())));
  assert.equal(restored.get(restart.id).status, 'pending', 'restart must not restore signed authority');
  assert.throws(() => restored.consume(restart.id, action), /still pending/);
  now += 721 * 60000;
  const waiting = hold(a, true);
  now += 721 * 60000;
  assert.equal(a.get(waiting.id).status, 'expired', 'pending request has a finite end');

  const policy = loadPolicy({ overlay: path.join(dir, 'missing'), off: false });
  const rules = Array.from({ length: 24 }, (_, i) => `post https://app${i}.example.test/projects`);
  assert.throws(() => parseGrantRules(rules, policy), /rules/, 'larger grants default off');
  const overlay = path.join(dir, 'policy.json');
  fs.writeFileSync(overlay, JSON.stringify({ approvals: { wait_minutes: 720, grant_rules_max: 100 } }));
  const opted = loadPolicy({ overlay, off: false });
  for (const count of [20, 21, 24, 100]) {
    const batch = Array.from({ length: count }, (_, i) => `post https://app${i}.example.test/projects`);
    assert.equal(parseGrantRules(batch, opted).length, count);
  }
  assert.equal(parseGrantRules([...rules, ...rules], opted).length, 24, 'duplicate rules do not add authority');
  assert.throws(() => parseGrantRules(Array(101).fill(rules[0]), opted), /rules/);
  assert.throws(() => parseGrantRules(['pay https://example.test'], opted), /cannot be granted/);
  assert.throws(() => parseGrantRules(['post https://example.test/checkout'], opted), /protected/);
  assert.throws(() => parseGrantRequest({ rules, minutes: 721 }, opted), /minutes/);
  for (const approvals of [{ wait_minutes: 721 }, { wait_minutes: 0 }, { wait_minutes: '720' },
    { grant_rules_max: 101 }, { grant_rules_max: 0 }, { grant_rules_max: 24.5 }]) {
    fs.writeFileSync(overlay, JSON.stringify({ approvals }));
    assert.throws(() => loadPolicy({ overlay, off: false }), /invalid/i);
  }
  const corrupt = store(720);
  const saved = JSON.parse(JSON.stringify(a.persistable()));
  corrupt.restore(saved.map((record: object) => ({ ...record, id: 'bad-timestamps', createdAt: 'broken', expiresAt: 'broken' })));
  assert.throws(() => corrupt.get('bad-timestamps'), /unknown/, 'malformed dates cannot create an immortal pending record');
  const late = store(720);
  const delayed = hold(late, true);
  const ts = now;
  const sig = crypto.sign('sha256', Buffer.from(approvalMessage('grant', late.get(delayed.id), ts)), privateKey).toString('base64');
  const delayedVerifier = { ...verifier, verify: (proof: unknown, message: string) => {
    verifier.verify(proof, message); now += 721 * 60000; return undefined;
  } };
  assert.throws(() => late.signed(delayed.id, 'grant', { ts, sig }, delayedVerifier, approvalMessage), /not pending/);
  assert.equal(late.get(delayed.id).status, 'expired', 'verification crossing the deadline grants nothing');
  let mono = 1000;
  Object.defineProperty(performance, 'now', { configurable: true, value: () => mono });
  const rollback = store(720);
  const beforeClockChange = hold(rollback, true);
  approve(rollback, beforeClockChange.id);
  now -= 60 * 60000; mono += 11 * 60000;
  assert.equal(rollback.get(beforeClockChange.id).status, 'expired', 'a backward wall clock cannot extend authority');
  const bounded = store(720);
  for (let i = 0; i < 100; i++) bounded.hold({ kind: 'click', caller: 'test', url: action.url, detail: 'Post fixture', action: { ...action, n: i }, extendedWait: true });
  assert.throws(() => bounded.hold({ kind: 'click', caller: 'test', url: action.url, detail: 'Post fixture', action: { ...action, n: 101 }, extendedWait: true }), /100 requests/);
  assert.equal(bounded.list().pending.length, 100, 'capacity never evicts an existing request');
  const legacyOverflow = store(720);
  legacyOverflow.restore([...bounded.persistable(), { ...bounded.persistable()[0], id: 'ffffffffffffffff' }]);
  assert.equal(legacyOverflow.list().pending.length, 101, 'legacy overflow is retained, never silently discarded');
  assert.throws(() => hold(legacyOverflow, true), /100 requests/, 'legacy overflow refuses new admission until capacity is available');
  const grants = createGrants();
  try {
    const mutable = { session: 'fixture', caller: 'test', rules: parseGrantRules([rules[0]], opted), minutes: 60 };
    const granted = grants.activate(mutable);
    mutable.rules[0].path = '/broader';
    assert.equal(grants.active('fixture')[0].rules[0].path, '/projects', 'input reference cannot change approved scope');
    assert.throws(() => granted.rules.push({ ...granted.rules[0] }), TypeError, 'returned rule array is immutable');
    assert.throws(() => { granted.rules[0].path = '/'; }, TypeError);
    assert.equal(isGrantSpec({ ...mutable, rules: [] }), false);
    assert.equal(isGrantSpec({ ...mutable, minutes: Number.NaN }), false);
  } finally { grants.stop(); }
  console.log('PASS optional waiting and large grants: signed authority stays short, one use, exact action and disabled by default');
} finally {
  Date.now = realNow;
  if (perfDescriptor) Object.defineProperty(performance, 'now', perfDescriptor);
  else Reflect.deleteProperty(performance, 'now');
  for (const a of stores) a.stop();
  // Only this process-created scratch directory, outside the owner folders.
  fs.rmSync(dir, { recursive: true, force: true });
}
