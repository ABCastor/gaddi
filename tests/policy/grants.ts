// Pure checks of daemon/grants.ts: what a rule may name, which holds a grant may waive, who may use
// one, and how one ends. No daemon, socket or browser. Every ASSERT_GRANT_* name is falsified by a
// mutation in tests/policy/grants.falsify.ts; the broker wiring around these rules is tested in
// tests/gates/session-grant.test.sh.
import assert from 'node:assert/strict';
import { checkGrant, createGrants, durationText, grantDetail, isGrantSpec, parseGrantRequest, parseGrantRules, permissionFor, ruleString } from '../../daemon/grants.ts';
import type { Grant, GrantScope } from '../../daemon/grants.ts';
import { loadPolicy } from '../../daemon/policy.ts';
import type { Policy, PolicyCheck } from '../../daemon/policy.ts';

const mode = process.argv[2] ?? 'normal';
const policy = loadPolicy({ overlay: '/nonexistent/gaddi-policy-overlay.json', off: false });
let passed = 0, failed = 0;
function check(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`PASS ${name}`); }
  catch (error) {
    failed++; process.exitCode = 1;
    console.log(`FAIL ASSERTION grants: ${name}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
  }
}

const NOW = 1_000_000;
const ACCOUNT = 'https://shop.example/account';
const grant = (id: string, rules: string[], session = 'session:a', minutes = 60): Grant =>
  ({ id, session, caller: 'agent', rules: parseGrantRules(rules, policy), minutes, createdAt: NOW, expiresAt: NOW + minutes * 60000 });
const hold = (reason: string): PolicyCheck => ({ outcome: 'hold', reason });
const decide = (grants: Grant[], page: string, reason: string, scope: GrantScope, using: Policy = policy) =>
  checkGrant(grants, using, page, hold(reason), scope);
const shop = [grant('g1', [`upload ${ACCOUNT}`, `post ${ACCOUNT}`, `delete ${ACCOUNT}/items`])];
const upload = { kind: 'upload' } as const;
const click = (name: string, destination = ''): GrantScope => ({ kind: 'click', name, destination });
const enter = (name: string): GrantScope => ({ kind: 'press', name });

// ---------------------------------------------------------------- what a rule may name
check('ASSERT_GRANT_RULES', () => {
  assert.deepEqual(parseGrantRules(['upload https://GitHub.com/settings/', 'post https://github.com:443/Profile', 'UPLOAD https://github.com/settings'], policy).map(ruleString),
    ['post https://github.com/Profile', 'upload https://github.com/settings'], 'canonical, deduplicated, one order');
  assert.equal(ruleString(parseGrantRules(['post https://www.linkedin.com'], policy)[0]), 'post https://www.linkedin.com/');
  assert.equal(ruleString(parseGrantRules(['upload http://localhost:3000/app'], policy)[0]), 'upload http://localhost:3000/app');
  assert.equal(ruleString(parseGrantRules(['upload http://127.0.0.1:8080/'], policy)[0]), 'upload http://127.0.0.1:8080/');
});

check('ASSERT_GRANT_NEVER', () => {
  for (const word of ['send', 'pay', 'signin', 'buy', 'purchase', 'checkout', 'transfer', 'unsubscribe', 'password', 'Send', '']) {
    assert.throws(() => parseGrantRules([`${word} https://shop.example/`], policy), /can never be granted/, JSON.stringify(word));
  }
});

check('ASSERT_GRANT_ADDRESS', () => {
  const refuse = (rule: unknown, pattern: RegExp) => assert.throws(() => parseGrantRules([rule], policy), pattern, String(rule));
  refuse('upload http://shop.example/x', /https/);
  refuse('upload https://user:pw@shop.example/x', /username/);
  refuse('upload https://shop.example/x?y=1', /plain address prefix/);
  refuse('upload https://shop.example/x#frag', /plain address prefix/);
  refuse('upload https://shop.example/a/../b', /segments/);
  refuse('upload https://shop.example/a/./b', /segments/);
  refuse('upload https://shop.example/a//b', /empty path segments/);
  for (const encoded of ['%2e%2e', '%2E', '%2f', '%5C']) refuse(`upload https://shop.example/a${encoded}b`, /plain address prefix/);
  refuse('upload https://shop.example\\x', /plain address prefix/);
  refuse(`upload https://shop.example/${'a'.repeat(200)}`, /longer than/);
  refuse('upload', /must look like/);
  refuse('upload a b', /must look like/);
  refuse('upload shop.example/x', /full address/);
  refuse('upload javascript:alert(1)', /https/);
  refuse(`upload https://shop.example/${'a'.repeat(300)}`, /at most 300/);
  refuse(42, /text of at most/);
});

check('ASSERT_GRANT_PROTECTED_RULE', () => {
  for (const address of ['https://shop.example/checkout', 'https://shop.example/payment/new', 'https://shop.example/settings/security',
    'https://shop.example/delete-account', 'https://accounts.google.com/x/password', 'https://shop.example/unsubscribe']) {
    assert.throws(() => parseGrantRules([`post ${address}`], policy), /protected/, address);
  }
  // The owner's own protected address counts too, and an overlay that replaces the list cannot drop the built-in ones.
  const mine: Policy = { ...policy, hold: { ...policy.hold, url_patterns: ['/private'] } };
  assert.throws(() => parseGrantRules(['upload https://shop.example/private'], mine), /protected/);
  assert.throws(() => parseGrantRules(['upload https://shop.example/checkout'], mine), /protected/);
  assert.doesNotThrow(() => parseGrantRules(['upload https://shop.example/account'], mine));
});

check('ASSERT_GRANT_GMAIL_RULE', () => {
  for (const rule of ['post https://mail.google.com/', 'upload https://mail.google.com/mail/u/0', 'delete https://MAIL.google.com/']) {
    assert.throws(() => parseGrantRules([rule], policy), /protected site/, rule);
  }
});

check('ASSERT_GRANT_COUNT', () => {
  assert.throws(() => parseGrantRules([], policy), /rules must list/);
  assert.throws(() => parseGrantRules('upload https://shop.example/x', policy), /rules must list/);
  const many = Array.from({ length: 21 }, (_, n) => `upload https://shop.example/p${n}`);
  assert.throws(() => parseGrantRules(many, policy), /rules must list/);
  assert.equal(parseGrantRules(many.slice(0, 20), policy).length, 20);
});

check('ASSERT_GRANT_REQUEST', () => {
  const rules = ['upload https://shop.example/x'];
  for (const minutes of [4, 721, 5.5, '60', Number.NaN, undefined, null]) {
    assert.throws(() => parseGrantRequest({ rules, minutes }, policy), /minutes/, String(minutes));
  }
  for (const minutes of [5, 720]) assert.equal(parseGrantRequest({ rules, minutes }, policy).minutes, minutes);
  for (const label of ['x'.repeat(61), 'two\nlines', 'bell\u0007', 'flip' + String.fromCharCode(0x202e) + 'ed', 'zero' + String.fromCharCode(0x200b) + 'width', 123, {}]) {
    assert.throws(() => parseGrantRequest({ rules, minutes: 60, label }, policy), /label/, String(label));
  }
  assert.equal(parseGrantRequest({ rules, minutes: 60, label: '  Update my profile  ' }, policy).label, 'Update my profile');
  assert.equal(parseGrantRequest({ rules, minutes: 60, label: '   ' }, policy).label, undefined);
  assert.equal(parseGrantRequest({ rules, minutes: 60 }, policy).label, undefined);
  assert.equal(parseGrantRequest({ rules, minutes: 60, label: 'x'.repeat(60) }, policy).label?.length, 60);
});

check('ASSERT_GRANT_DETAIL', () => {
  const rules = parseGrantRules(['upload https://github.com/settings', 'post http://localhost:3000/app'], policy);
  assert.equal(grantDetail(rules, 180, 'Update my profile'),
    'post on http://localhost:3000/app\nupload on github.com/settings\nfor 3 hours\n“Update my profile”');
  assert.equal(grantDetail(rules, 45), 'post on http://localhost:3000/app\nupload on github.com/settings\nfor 45 minutes');
  assert.deepEqual([5, 59, 60, 90, 150, 720].map(minutes => durationText(minutes)),
    ['5 minutes', '59 minutes', '1 hour', '1 hour 30 minutes', '2 hours 30 minutes', '12 hours']);
});

check('ASSERT_GRANT_SPEC', () => {
  const spec = { session: 'session:a', rules: parseGrantRules(['upload https://shop.example/x'], policy), minutes: 60, label: 'x' };
  assert.equal(isGrantSpec(spec), true);
  assert.equal(isGrantSpec({ ...spec, label: undefined }), true);
  assert.equal(isGrantSpec({ ...spec, session: 1 }), false);
  assert.equal(isGrantSpec({ ...spec, rules: [{ permission: 'send', origin: 'https://x.example', path: '/' }] }), false);
  assert.equal(isGrantSpec({ ...spec, minutes: '60' }), false);
  assert.equal(isGrantSpec(null), false);
});

// ---------------------------------------------------------------- which holds a grant may waive
check('ASSERT_GRANT_TABLE', () => {
  const mapped = policy.hold.verbs.filter(verb => permissionFor('click', `verb:${verb}`) !== undefined).sort();
  assert.deepEqual(mapped, ['cancella', 'condividi', 'delete', 'delete forever', 'delete permanently', 'elimina',
    'elimina definitivamente', 'post', 'pubblica', 'publish', 'remove', 'rimuovi', 'share'], 'the whole of what can be waived');
  for (const verb of ['pay', 'pay now', 'send', 'buy', 'checkout', 'transfer', 'withdraw', 'unsubscribe', 'close account', 'delete account',
    'change password', 'remove phone', 'cancel subscription', 'ricarica', 'x-overlay-verb']) {
    assert.equal(permissionFor('click', `verb:${verb}`), undefined, verb);
  }
  assert.equal(permissionFor('click', 'verb:Publish'), 'post');
  assert.equal(permissionFor('click', 'verb:Elimina definitivamente'), 'delete');
  assert.equal(permissionFor('press', 'enter-submits:post'), 'post');
  assert.equal(permissionFor('press', 'enter-submits:pay'), undefined);
  assert.equal(permissionFor('press', 'verb:post'), undefined, 'a click reason is not a press reason');
  assert.equal(permissionFor('click', 'enter-submits:post'), undefined, 'and a press reason is not a click reason');
  assert.equal(permissionFor('upload', 'upload of a local file'), 'upload');
  for (const reason of ['verb:post', 'key:Meta+Enter on mail.google.com', 'url-pattern:/checkout', 'sign-in needs owner approval', 'extension:disable', undefined]) {
    assert.equal(permissionFor('upload', reason), undefined, String(reason));
  }
  for (const reason of ['key:Meta+Enter on mail.google.com', 'url-pattern:/checkout', 'upload of a local file', 'sign-in needs owner approval', undefined]) {
    for (const kind of ['click', 'press'] as const) assert.equal(permissionFor(kind, reason), undefined, `${kind} ${String(reason)}`);
  }
});

check('ASSERT_GRANT_SCOPE', () => {
  for (const [page, reason, scope] of [
    [ACCOUNT, 'upload of a local file', upload], [`${ACCOUNT}/profile?tab=1#x`, 'upload of a local file', upload],
    [ACCOUNT, 'verb:post', click('Post')], [ACCOUNT, 'enter-submits:post', enter('Post')],
    [`${ACCOUNT}/items/5`, 'verb:delete', click('Delete')], [`${ACCOUNT}/`, 'verb:publish', click('Publish')],
  ] as const) {
    const decision = decide(shop, page, reason, scope);
    assert.equal(decision.outcome, 'allow', `${reason} on ${page}`);
    assert.equal(decision.grant, 'g1');
  }
});

check('ASSERT_GRANT_ORIGIN', () => {
  for (const page of ['https://other.example/account', 'http://shop.example/account', 'https://shop.example:8443/account', 'https://sub.shop.example/account']) {
    assert.equal(decide(shop, page, 'upload of a local file', upload).outcome, 'hold', page);
  }
});

check('ASSERT_GRANT_BOUNDARY', () => {
  for (const page of [`${ACCOUNT}X`, `${ACCOUNT}-old/x`, 'https://shop.example/', 'https://shop.example/acc', `${ACCOUNT}%2Fadmin`]) {
    assert.equal(decide(shop, page, 'upload of a local file', upload).outcome, 'hold', page);
  }
  for (const page of [`${ACCOUNT}/`, `${ACCOUNT}/a/b/c`]) assert.equal(decide(shop, page, 'upload of a local file', upload).outcome, 'allow', page);
});

check('ASSERT_GRANT_PERMISSION', () => {
  assert.equal(decide(shop, ACCOUNT, 'verb:delete', click('Delete')).outcome, 'hold', 'delete is granted only under /items');
  const postOnly = [grant('p', [`post ${ACCOUNT}`])];
  assert.equal(decide(postOnly, ACCOUNT, 'upload of a local file', upload).outcome, 'hold');
  assert.equal(decide(postOnly, ACCOUNT, 'verb:delete', click('Delete')).outcome, 'hold');
  const deleteOnly = [grant('d', [`delete ${ACCOUNT}`])];
  assert.equal(decide(deleteOnly, ACCOUNT, 'verb:post', click('Post')).outcome, 'hold');
  assert.equal(decide(postOnly, ACCOUNT, 'verb:post', click('Post')).outcome, 'allow');
});

check('ASSERT_GRANT_MIXED', () => {
  const both = [grant('b', [`post ${ACCOUNT}`, `delete ${ACCOUNT}`])];
  for (const [reason, scope] of [['verb:post', click('Post and pay')], ['verb:publish', click('Pay and publish')], ['verb:delete', click('Delete and send')],
    ['verb:remove phone', click('Share and remove phone')], ['verb:change password', click('Publish and change password')],
    ['enter-submits:post', enter('Post and pay')]] as const) {
    assert.equal(decide(both, ACCOUNT, reason, scope).outcome, "hold", String(scope.name));
  }
  const postOnly = [grant('p', [`post ${ACCOUNT}`])];
  assert.equal(decide(postOnly, ACCOUNT, 'verb:post', click('Post and delete')).outcome, 'hold', 'a delete the grant does not cover');
  assert.equal(decide(both, ACCOUNT, 'verb:post', click('Post and delete')).outcome, 'allow', 'but both are granted here');
  assert.equal(decide(both, ACCOUNT, 'verb:delete forever', click('Delete forever')).outcome, 'allow');
  // An overlay that thins the verb list cannot make "Post and pay" look like "Post".
  const thin: Policy = { ...policy, hold: { ...policy.hold, verbs: ['post'] } };
  assert.equal(decide(both, ACCOUNT, 'verb:post', click('Post and pay'), thin).outcome, 'hold');
});

check('ASSERT_GRANT_DESTINATION', () => {
  for (const [destination, expected] of [[`${ACCOUNT}/next`, 'allow'], [`${ACCOUNT}#section`, 'allow'],
    ['https://elsewhere.example/account/next', 'hold'], ['https://shop.example/other', 'hold'], [`${ACCOUNT}/checkout`, 'hold'],
    ['javascript:alert(1)', 'hold'], ['mailto:a@b.example', 'hold']] as const) {
    assert.equal(decide(shop, ACCOUNT, 'verb:post', click('Post', destination)).outcome, expected, destination);
  }
  // A delete that leads outside the delete prefix is held even though the site's post prefix covers it.
  assert.equal(decide(shop, `${ACCOUNT}/items/5`, 'verb:delete', click('Delete', `${ACCOUNT}/other`)).outcome, 'hold');
  assert.equal(decide(shop, `${ACCOUNT}/items/5`, 'verb:delete', click('Delete', `${ACCOUNT}/items/6`)).outcome, 'allow');
});

check('ASSERT_GRANT_PROTECTED', () => {
  const root = [grant('r', ['upload https://shop.example/', 'post https://shop.example/'])];
  for (const page of ['https://shop.example/checkout', 'https://shop.example/account/payment', 'https://shop.example/account?next=/checkout',
    'https://shop.example/settings/security', 'https://shop.example/delete-account']) {
    assert.equal(decide(root, page, 'upload of a local file', upload).outcome, 'hold', page);
    assert.equal(decide(root, page, 'verb:post', click('Post')).outcome, 'hold', page);
  }
  assert.equal(decide(root, ACCOUNT, 'upload of a local file', upload).outcome, 'allow');
  const mine: Policy = { ...policy, hold: { ...policy.hold, url_patterns: ['/private'] } };
  assert.equal(decide(root, 'https://shop.example/private/x', 'upload of a local file', upload, mine).outcome, 'hold', 'the owner\'s own protected address');
  assert.equal(decide(root, 'https://shop.example/checkout', 'upload of a local file', upload, mine).outcome, 'hold', 'built-in ones stay');
  const gmail: Grant = { ...root[0], rules: [{ permission: 'upload', origin: 'https://mail.google.com', path: '/' }] };
  assert.equal(decide([gmail], 'https://mail.google.com/mail', 'upload of a local file', upload).outcome, 'hold', 'a refused site is held even if a grant names it');
});

check('ASSERT_GRANT_FINAL', () => {
  const deny: PolicyCheck = { outcome: 'deny', reason: 'verb:post' };
  assert.deepEqual(checkGrant(shop, policy, ACCOUNT, deny, click('Post')), deny, 'a deny is never changed');
  const allow: PolicyCheck = { outcome: 'allow', reason: 'ok' };
  assert.deepEqual(checkGrant(shop, policy, ACCOUNT, allow, click('Read more')), allow, 'an allow needs no grant and names none');
  assert.equal(decide([], ACCOUNT, 'upload of a local file', upload).outcome, 'hold', 'no grants, no change');
  const unknown = decide(shop, ACCOUNT, 'manual-review:script', click('Run'));
  assert.equal(unknown.outcome, 'hold', 'an unknown reason stays held');
});

// ---------------------------------------------------------------- the store: who holds a grant, and how it ends
function store(minuteMs = 1000) {
  const clock = { now: NOW }, events: [string, unknown][] = [], audits: Record<string, unknown>[] = [];
  const grants = createGrants({ minuteMs, now: () => clock.now, emit: (event, data) => { events.push([event, data]); }, audit: entry => { audits.push(entry); } });
  return { clock, events, audits, grants };
}
const rulesA = parseGrantRules(['upload https://shop.example/account'], policy);

check('ASSERT_GRANT_BINDING', () => {
  const { grants } = store();
  const a = grants.activate({ session: 'session:a', caller: 'agent-a', rules: rulesA, minutes: 5 });
  const b = grants.activate({ session: 'session:b', caller: 'agent-b', rules: rulesA, minutes: 5 });
  assert.deepEqual(grants.active('session:a').map(g => g.id), [a.id]);
  assert.deepEqual(grants.active('session:b').map(g => g.id), [b.id]);
  assert.deepEqual(grants.active('session:c'), []);
  assert.deepEqual(grants.active(undefined), [], 'a CLI call has no session and no grant');
  grants.stop();
});

check('ASSERT_GRANT_NO_SESSION_LEAK', () => {
  const { grants, events } = store();
  grants.activate({ session: 'session:secret-chat', caller: 'agent', rules: rulesA, minutes: 5, label: 'one' });
  const listed = grants.list('session:secret-chat');
  assert.equal(listed.length, 1);
  assert.equal(listed[0].mine, true);
  assert.equal(grants.list('session:other')[0].mine, false);
  assert.equal(grants.list()[0].mine, false);
  assert.deepEqual(Object.keys(listed[0]).sort(), ['caller', 'createdAt', 'expiresAt', 'id', 'label', 'mine', 'rules']);
  assert.equal(listed[0].label, 'one');
  assert.deepEqual(listed[0].rules, ['upload https://shop.example/account']);
  assert.ok(!JSON.stringify([listed, events]).includes('secret-chat'), 'the chat\'s key is in neither the list nor an event');
  grants.stop();
});

check('ASSERT_GRANT_EXPIRY', () => {
  const { clock, grants, audits, events } = store(1000);
  const g = grants.activate({ session: 'session:a', caller: 'agent', rules: rulesA, minutes: 5 });
  assert.equal(g.expiresAt, NOW + 5000);
  assert.match(g.id, /^[a-f0-9]{16}$/);
  clock.now = NOW + 4999;
  assert.equal(grants.active('session:a').length, 1, 'one tick before the deadline');
  clock.now = NOW + 5000;
  assert.equal(grants.active('session:a').length, 0, 'at the deadline');
  assert.equal(grants.list().length, 0);
  assert.deepEqual(audits.filter(a => a.method === 'grant.end').map(a => [a.grant, a.reason]), [[g.id, 'expired']]);
  assert.equal(events.filter(([name]) => name === 'grants.changed').length, 2, 'start and end are announced');
  grants.stop();
});

check('ASSERT_GRANT_REVOKE', () => {
  const { grants, audits } = store();
  const g = grants.activate({ session: 'session:a', caller: 'agent', rules: rulesA, minutes: 5 });
  assert.equal(grants.revoke(g.id), true);
  assert.equal(grants.revoke(g.id), false, 'a second end finds nothing');
  assert.equal(grants.active('session:a').length, 0);
  assert.deepEqual(audits.filter(a => a.method === 'grant.end').map(a => a.reason), ['revoked']);
  grants.stop();
});

check('ASSERT_GRANT_SESSION_END', () => {
  const { grants, audits } = store();
  grants.activate({ session: 'session:c', caller: 'agent', rules: rulesA, minutes: 5 });
  grants.activate({ session: 'session:c', caller: 'agent', rules: rulesA, minutes: 10 });
  const d = grants.activate({ session: 'session:d', caller: 'agent', rules: rulesA, minutes: 5 });
  assert.equal(grants.endSession('session:c'), 2);
  assert.deepEqual(grants.active('session:d').map(g => g.id), [d.id], 'another chat keeps its grant');
  assert.deepEqual(audits.filter(a => a.method === 'grant.end').map(a => a.reason), ['session-ended', 'session-ended']);
  grants.stop();
});

check('ASSERT_GRANT_AUDIT_START', () => {
  const { grants, audits } = store();
  const g = grants.activate({ session: 'session:a', caller: 'agent', rules: rulesA, minutes: 5, label: 'agent words' });
  const start = audits.find(a => a.method === 'grant.start');
  assert.ok(start);
  assert.equal(start.grant, g.id); assert.equal(start.caller, 'agent'); assert.equal(start.outcome, 'allow');
  assert.equal(start.tab, null); assert.equal(start.url, '');
  assert.deepEqual(start.rules, ['upload https://shop.example/account']);
  assert.equal(start.expiresAt, new Date(NOW + 5000).toISOString());
  assert.ok(!JSON.stringify(audits).includes('session:a'), 'the audit never names the chat key');
  grants.stop();
});

check('ASSERT_GRANT_AUDIT_FAILURE', () => {
  const logged: unknown[][] = [];
  let failing = false;
  const grants = createGrants({ minuteMs: 1000, now: () => NOW, audit: () => { if (failing) throw new Error('disk full'); }, log: (...args) => { logged.push(args); } });
  const kept = grants.activate({ session: 'session:a', caller: 'agent', rules: rulesA, minutes: 5 });
  failing = true;
  assert.equal(grants.revoke(kept.id), true, 'an end that cannot be audited still ends the grant');
  assert.equal(grants.active('session:a').length, 0);
  assert.equal(logged.length, 1, 'and says so in the log');
  assert.throws(() => grants.activate({ session: 'session:a', caller: 'agent', rules: rulesA, minutes: 5 }), /disk full/, 'a start that cannot be audited does not happen');
  assert.equal(grants.active('session:a').length, 0);
  grants.stop();
});

console.log(`== grants (${mode}): ${passed} passed, ${failed} failed`);
