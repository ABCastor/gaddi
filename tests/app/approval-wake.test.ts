import assert from 'node:assert/strict';
import { ChildProcess } from 'node:child_process';
import { wakeApprovalApp } from '../../daemon/approval-wake.ts';
import { createApprovals } from '../../daemon/approvals.ts';

let passed = 0;
function check(label: string, body: () => void) { body(); passed++; console.log(`PASS ${label}`); }
const now = Date.now();
const pending = { id: 'pending_1', status: 'pending', expiresAt: new Date(now + 60_000).toISOString() };
const calls: { command: string; args: string[]; options: { stdio: 'ignore' } }[] = [];
const errors: unknown[][] = [];
let unrefs = 0;
const child = new ChildProcess();
child.unref = () => { unrefs++; };
const options = { now, launcher: '/isolated/fake-open', log: (...args: unknown[]) => errors.push(args),
  launch: (command: string, args: string[], options: { stdio: 'ignore' }) => { calls.push({ command, args, options }); return child; } };

check('idle, granted, expired, malformed and stale requests never launch', () => {
  for (const rows of [[], [null], [{ ...pending, status: 'granted' }], [{ ...pending, expiresAt: new Date(now).toISOString() }],
    [{ ...pending, expiresAt: 'invalid' }], [{ ...pending, id: 'bad|id' }], [{ ...pending, status: undefined }]]) {
    assert.equal(wakeApprovalApp(rows, options), false);
  }
  assert.equal(calls.length, 0);
});
check('genuine pending holds wake the app in the background without authorization arguments', () => {
  assert.equal(wakeApprovalApp([pending], options), true);
  assert.deepEqual(calls, [{ command: '/isolated/fake-open', args: ['-g', '-b', 'com.abcastor.gaddi'], options: { stdio: 'ignore' } }]);
  assert.equal(unrefs, 1);
});
check('multiple pending approvals need only one background launch', () => {
  assert.equal(wakeApprovalApp([pending, { ...pending, id: 'pending_2' }], options), true);
  assert.equal(calls.length, 2);
});
check('broker pending events and restored grants both wake for a fresh decision', () => {
  const stored = createApprovals({ emit: (event, data) => {
    if (event === 'approval.pending') {
      assert(data !== null && typeof data === 'object' && 'approval' in data);
      assert.equal(wakeApprovalApp([data.approval], options), true);
    }
  } });
  const restored = createApprovals({});
  try {
    const held = stored.hold({ kind: 'click', tab: null, caller: 'fixture', url: 'https://fixture.test',
      detail: 'Delete fixture', reason: 'verb:delete', action: { method: 'browser.click', caller: 'fixture', url: 'https://fixture.test' } });
    const rows = stored.persistable().map(row => ({ ...row, status: 'granted' }));
    restored.restore(rows);
    assert.equal(restored.list().pending[0]?.status, 'pending');
    assert.equal(wakeApprovalApp(restored.list().pending, options), true);
    assert.equal(calls.length, 4);
    stored.cancel(held.id);
    assert.equal(wakeApprovalApp(stored.list().pending, options), false);
  } finally { stored.stop(); restored.stop(); }
});
check('failed OS launch reports an error without leaking request text', () => {
  child.emit('error', Object.assign(new Error('private request text'), { code: 'ENOENT' }));
  child.emit('exit', 1, null);
  assert(errors.some(row => row[0] === 'approval app launch failed:' && row[1] === 'ENOENT'));
  assert(errors.some(row => row[0] === 'approval app launcher exited:' && row[1] === 1));
  assert(!JSON.stringify(errors).includes('private request text'));
});
check('synchronous launcher failure is contained', () => {
  assert.equal(wakeApprovalApp([pending], { ...options, launch: () => { throw Object.assign(new Error('private'), { code: 'EACCES' }); } }), false);
  assert.deepEqual(errors.at(-1), ['approval app launch failed:', 'EACCES']);
});
console.log(`== approval app wake: ${passed} passed, 0 failed`);
