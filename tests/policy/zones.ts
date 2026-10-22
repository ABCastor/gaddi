// TEST-ZONE policy rules: which sites may be zones, and that a zone signs in by itself.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadPolicy, checkSignin, zoneSite, setZone } from '../../daemon/policy.ts';

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
fs.rmSync(dir, { recursive: true, force: true });
console.log(`== zones policy: ${passed} passed, 0 failed`);
