// TEST-ZONE policy rules: which sites may be zones, and that a zone signs in by itself.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadPolicy, checkSignin, zoneSite, setZone, setSandbox, githubOwnPrefix } from '../../daemon/policy.ts';
import { sandboxCovers, githubOwnCovers } from '../../daemon/grants.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaddi-zones-'));
const overlay = path.join(dir, 'policy.json');
let passed = 0;
const check = (name: string, fn: () => void) => { fn(); passed++; console.log(`PASS ${name}`); };

check('ASSERT_ZONE_SITE', () => {
  assert.equal(zoneSite('https://ticktick.com'), 'https://ticktick.com');
  assert.equal(zoneSite('http://localhost:3000'), 'http://localhost:3000');
  for (const site of ['https://mail.google.com', 'https://accounts.google.com', 'https://tasks.google.com', 'https://appleid.apple.com',
    'https://www.icloud.com', 'https://login.live.com', 'https://my.1password.com', 'https://github.com', 'http://example.com', 'https://google.com.', 'https://ticktick.com.']) {
    assert.equal(zoneSite(site), undefined, `${site} can never be a zone`);
  }
});
check('ASSERT_ZONE_SIGNIN', () => {
  fs.writeFileSync(overlay, '{}\n');
  let policy = loadPolicy({ overlay });
  assert.equal(checkSignin(policy, 'https://ticktick.com').outcome, 'hold', 'sign-in asks before the site is a zone');
  policy = setZone(overlay, 'https://ticktick.com', true);
  assert.deepEqual(checkSignin(policy, 'https://ticktick.com'), { outcome: 'allow', reason: 'test zone' }, 'a zone signs in by itself');
  assert.equal(checkSignin(policy, 'https://todoist.com').outcome, 'hold', 'another site still asks');
  const owned = JSON.parse(fs.readFileSync(overlay, 'utf8'));
  fs.writeFileSync(overlay, JSON.stringify({ ...owned, deny: { verbs_on_hosts: [{ host: 'ticktick\\.com', verbs: ['archive'] }], type_into: [], eval_patterns: [] } }));
  assert.equal(checkSignin(loadPolicy({ overlay }), 'https://ticktick.com').outcome, 'hold', "the owner's own refused host wins over the zone");
  fs.writeFileSync(overlay, JSON.stringify(owned));
  policy = loadPolicy({ overlay });
  policy = setZone(overlay, 'https://ticktick.com', false);
  assert.equal(checkSignin(policy, 'https://ticktick.com').outcome, 'hold', 'removing the zone makes sign-in ask again');
  assert.throws(() => setZone(overlay, 'https://accounts.google.com', true), /invalid test zone/, 'an identity provider is refused');
  fs.writeFileSync(overlay, JSON.stringify({ zones: { sites: ['https://accounts.google.com'] } }));
  assert.throws(() => loadPolicy({ overlay }), /invalid test zone/, 'a hand-edited identity zone stops the broker');
});
check('ASSERT_SANDBOX_SITE', () => {
  fs.writeFileSync(overlay, '{}\n');
  assert.throws(() => setSandbox(overlay, 'https://ticktick.com', true), /only a test zone/, 'a site must be a zone before it is a sandbox');
  setZone(overlay, 'https://ticktick.com', true);
  setZone(overlay, 'https://staging.example.com', true);
  let policy = setSandbox(overlay, 'https://ticktick.com', true);
  assert.deepEqual(policy.zones, { sites: ['https://ticktick.com', 'https://staging.example.com'], sandbox: ['https://ticktick.com'] });
  assert.equal(sandboxCovers(policy, new URL('https://ticktick.com/checkout')), 'https://ticktick.com', 'a sandbox covers its own payment page');
  assert.equal(sandboxCovers(policy, new URL('https://staging.example.com/checkout')), undefined, 'a plain zone is not a sandbox');
  assert.equal(sandboxCovers(policy, new URL('https://checkout.stripe.com/c/pay/cs_test_abc123')), 'https://checkout.stripe.com', 'a Stripe test session counts');
  for (const other of ['https://checkout.stripe.com/c/pay/cs_live_abc123', 'https://checkout.stripe.com/c/pay/cs_test_abc123/../cs_live_x',
    'https://checkout.stripe.com:8443/c/pay/cs_test_abc123', 'https://user@checkout.stripe.com/c/pay/cs_test_abc123', 'https://pay.stripe.com/c/pay/cs_test_abc123']) {
    assert.equal(sandboxCovers(policy, new URL(other)), undefined, `${other} is not a test session`);
  }
  policy = setZone(overlay, 'https://staging.example.com', false);
  assert.deepEqual(policy.zones?.sandbox, ['https://ticktick.com'], 'removing another zone keeps the sandbox');
  policy = setSandbox(overlay, 'https://ticktick.com', false);
  assert.deepEqual(policy.zones, { sites: ['https://ticktick.com'] }, 'turning a sandbox off keeps its zone');
  assert.equal(sandboxCovers(policy, new URL('https://checkout.stripe.com/c/pay/cs_test_abc123')), undefined, 'no sandbox, no Stripe test mode');
  setSandbox(overlay, 'https://ticktick.com', true);
  policy = setZone(overlay, 'https://ticktick.com', false);
  assert.equal(policy.zones?.sandbox, undefined, 'removing the zone ends its sandbox');
  assert.throws(() => setSandbox(overlay, 'https://github.com', true), /invalid sandbox/, 'GitHub can never be a sandbox');
  fs.writeFileSync(overlay, JSON.stringify({ zones: { sites: [], sandbox: ['https://ticktick.com'] } }));
  assert.throws(() => loadPolicy({ overlay }), /invalid sandbox/, 'a hand-edited sandbox that is not a zone stops the broker');
  fs.writeFileSync(overlay, JSON.stringify({ zones: { sites: ['https://ticktick.com'], sandbox: ['https://ticktick.com'] },
    hold: { url_patterns: ['/checkout', 'ticktick\\.com/billing'] } }));
  policy = loadPolicy({ overlay });
  assert.equal(sandboxCovers(policy, new URL('https://ticktick.com/billing')), undefined, "an address the user protected still wins");
  assert.equal(sandboxCovers(policy, new URL('https://ticktick.com/checkout')), 'https://ticktick.com');
});
check('ASSERT_GITHUB_OWN_PREFIX', () => {
  fs.writeFileSync(overlay, '{}\n');
  const policy = loadPolicy({ overlay });
  assert.deepEqual(policy.allowances?.github_own, ['https://github.com/ABCastor/', 'https://github.com/Anneo22/'], 'the defaults name the two accounts');
  for (const good of ['https://github.com/ABCastor/', 'https://github.com/a-b/']) assert.ok(githubOwnPrefix(good), good);
  for (const bad of ['https://github.com/', 'https://github.com/settings/x/', 'https://github.com/ABCastor', 'http://github.com/ABCastor/',
    'https://gist.github.com/ABCastor/', 'https://github.com.evil.example/ABCastor/', 'https://github.com/AB Castor/', 'https://github.com/-x/']) {
    assert.ok(!githubOwnPrefix(bad), `${bad} is not an account prefix`);
  }
  fs.writeFileSync(overlay, JSON.stringify({ allowances: { github_own: ['https://github.com/'] } }));
  assert.throws(() => loadPolicy({ overlay }), /allowances/, 'an overlay cannot widen the allowance to all of GitHub');
  assert.ok(githubOwnCovers(policy, new URL('https://github.com/Anneo22/notes/issues/1')));
  assert.ok(!githubOwnCovers(policy, new URL('https://github.com/Anneo22/notes/settings/access')));
  fs.writeFileSync(overlay, JSON.stringify({ allowances: { github_own: [] } }));
  assert.ok(!githubOwnCovers(loadPolicy({ overlay }), new URL('https://github.com/Anneo22/notes/issues/1')), 'the user can turn it off');
});
fs.rmSync(dir, { recursive: true, force: true });
console.log(`== zones policy: ${passed} passed, 0 failed`);
