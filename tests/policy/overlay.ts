import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadPolicy, checkEval, checkNavigation, checkClick, checkPress, checkType } from '../../daemon/policy.ts';

const root = path.resolve('tests/.state');
fs.mkdirSync(root, { recursive: true });
const home = fs.mkdtempSync(path.join(root, 'policy-'));
const overlay = path.join(home, 'policy.json');
const socket = path.join('/tmp', `gaddi-policy-${process.pid}.sock`);
let count = 0;
const pass = (name: string) => { count++; console.log(`PASS ${name}`); };
const write = (value: unknown) => fs.writeFileSync(overlay, JSON.stringify(value));
const expressions = ['API.LMSSetValue("x", "y")', 'API.LMSCommit()'];
const password = "document.querySelector('[type=password]').value";
try {
  const base = loadPolicy({ overlay, off: false });
  assert.equal(base.sources.length, 1);
  for (const expression of expressions) assert.equal(checkEval(base, expression).outcome, 'allow');
  assert.equal(checkEval(base, password).outcome, 'deny');
  pass('absent-overlay-uses-defaults');

  fs.copyFileSync('tests/fixtures/eval-overlay.json', overlay);
  const policy = loadPolicy({ overlay, off: false });
  assert.equal(policy.sources.at(-1), overlay);
  for (const expression of expressions) assert.equal(checkEval(policy, expression).outcome, 'deny');
  assert.equal(checkEval(policy, 'API.LMSGetValue("x")').outcome, 'allow');
  assert.equal(checkEval(policy, password).outcome, 'deny');
  assert.equal(checkNavigation(policy, 'https://example.test/checkout').outcome, 'hold');
  assert.equal(checkClick(policy, 'mail.google.com', 'Send').outcome, 'deny');
  assert.equal(checkPress(policy, 'mail.google.com', 'Meta+Enter').outcome, 'hold');
  assert.equal(checkType(policy, { tag: 'input', type: 'password' }).outcome, 'deny');
  assert.equal(checkType(policy, { tag: 'input', autocomplete: 'current-password' }).outcome, 'deny');
  pass('overlay-adds-expression-denies-and-preserves-default-gates');

  write({ hold: { verbs: ['submit record'] }, approvals: { ttl_minutes: 2 }, deny: { eval_patterns: [] } });
  const merged = loadPolicy({ overlay, off: false });
  assert.deepEqual(merged.hold.verbs, ['submit record']);
  assert.deepEqual(merged.hold.url_patterns, base.hold.url_patterns);
  assert.equal(merged.approvals.ttl_minutes, 2);
  assert.equal(checkEval(merged, password).outcome, 'deny');
  pass('partial-objects-merge-arrays-replace-password-patterns-remain');

  const invalid = ['{', 'null', '[]', '{"__proto__":{}}', ...[
    { deny: null }, { deny: { eval_pattern: ['x'] } }, { deny: { eval_patterns: 'x' } },
    { deny: { eval_patterns: [7] } }, { deny: { eval_patterns: ['['] } }, { deny: { type_into: [false] } },
    { deny: { verbs_on_hosts: [{ host: 'example' }] } }, { hold: { keys: [{ keys: ['Enter'] }] } },
    { hold: { url_patterns: ['('] } }, { hold: { keys: [{ url: '[', keys: ['Enter'] }] } },
    { deny: { verbs_on_hosts: [{ host: '[', verbs: ['Send'] }] } }, { hold: { verbs: [null] } },
    { approvals: { ttl_minutes: '10' } }, { approvals: { ttl_minutes: 0 } }, { version: 999 },
  ].map(value => JSON.stringify(value))];
  for (const body of invalid) {
    fs.writeFileSync(overlay, body);
    assert.throws(() => loadPolicy({ overlay, off: false }), /Invalid policy overlay/);
    // Start the actual broker: invalid user policy must fail before binding any socket,
    // even with the test-only gate bypass set. No live service or browser is involved.
    const child = spawnSync(process.execPath, ['daemon/daemon.ts'], {
      encoding: 'utf8', timeout: 5000,
      env: { ...process.env, GADDI_HOME: home, GADDI_SOCKET: socket, GADDI_POLICY_OFF: '1' },
    });
    assert.ifError(child.error);
    assert.equal(child.status, 1, child.stderr);
    assert.ok(child.stderr.includes(`Invalid policy overlay ${overlay}:`), child.stderr);
    assert.equal(fs.existsSync(socket), false);
  }
  pass(`${invalid.length}-invalid-overlays-stop-broker-startup-with-clear-errors`);

  fs.unlinkSync(overlay);
  fs.symlinkSync(path.join(home, 'missing-policy'), overlay);
  assert.throws(() => loadPolicy({ overlay, off: false }), /Invalid policy overlay.*ENOENT/);
  fs.unlinkSync(overlay);
  fs.mkdirSync(overlay);
  assert.throws(() => loadPolicy({ overlay, off: false }), /Invalid policy overlay/);
  pass('unreadable-overlay-paths-fail-closed');
  console.log(`== policy overlay: ${count} passed, 0 failed`);
} finally {
  fs.rmSync(home, { recursive: true, force: true }); // This suite's scratch state only.
}
