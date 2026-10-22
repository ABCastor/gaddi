// APPROVAL-CONTEXT: who asked and why is shown on every card, and is never part of what the owner signs.
import assert from 'node:assert/strict';
import { approvalContext, contextText, harnessName, createApprovals, remoteDigest } from '../../daemon/approvals.ts';
import { approvalMessage } from '../../daemon/proof.ts';

assert.equal(harnessName('pi'), 'Pi');
assert.equal(harnessName('claude-code'), 'Claude Code');
assert.equal(harnessName('my-harness'), 'my-harness');
assert.equal(harnessName(undefined), 'unknown');
// One plain line: control, direction-changing and zero-width characters go, addresses lose their queries.
assert.equal(contextText('Delete\u202e old\u200b items\n\tnow https://example.test/a?token=secret#x', 200), 'Delete old items now https://example.test/a');
assert.equal(contextText('   ', 10), undefined);
assert.equal(contextText(42, 10), undefined);
assert.equal([...contextText('x'.repeat(500), 160)!].length, 160);
assert.ok(contextText('x'.repeat(500), 160)!.endsWith('\u2026'));
assert.deepEqual(approvalContext('pi', { why: 'Tidy test courses', context: { chat: 'Garmin cleanup', project: 'Fitness App' } }),
  { agent: 'Pi', chat: 'Garmin cleanup', project: 'Fitness App', why: 'Tidy test courses' });
assert.deepEqual(approvalContext('pi', { context: 'not an object' }), { agent: 'Pi' });
console.log('PASS APPROVAL-CONTEXT text');

// Two otherwise identical records that differ only in context sign the same message and the same phone digest.
const store = createApprovals({ ttlMinutes: 10 });
try {
  const action = { method: 'click', caller: 'pi', url: 'https://example.test/notes', tab: 7, selector: '#delete' };
  const a = store.hold({ kind: 'click', caller: 'pi', url: action.url, detail: 'Delete note', reason: 'verb:delete', action, context: approvalContext('pi', { why: 'one reason' }) });
  const same = { ...a, context: approvalContext('pi', { why: 'a completely different reason', context: { chat: 'Other chat' } }) };
  assert.equal(approvalMessage('grant', a, 1), approvalMessage('grant', same, 1));
  assert.equal(remoteDigest(a), remoteDigest(same));
  assert.throws(() => { (a.context as Record<string, unknown>).why = 'rewritten'; }, TypeError, 'context is frozen once held');
  // The same action asked again keeps the card and the words it first showed.
  assert.equal(store.hold({ kind: 'click', caller: 'pi', url: action.url, detail: 'Delete note', reason: 'verb:delete', action, context: approvalContext('pi', { why: 'later words' }) }).id, a.id);
  const listed = store.list().pending[0];
  assert.deepEqual(listed.context, { agent: 'Pi', why: 'one reason' });
  assert.equal(listed.allows, 'This one action, once, within 10 minutes at most.');
  console.log('PASS APPROVAL-CONTEXT is display only');
} finally { store.stop(); }
