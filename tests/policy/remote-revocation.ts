// AUTH-PHONE: remote-off must remove all authority even when storage/reporting fails.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApprovals } from '../../daemon/approvals.ts';
import { createGrants } from '../../daemon/grants.ts';
import { createRemote, enableMessage } from '../../daemon/remote.ts';
import { approvalMessage, createProofVerifier } from '../../daemon/proof.ts';

// Execute the actual RPC handler with actual stores, without starting the live daemon.
// The failure is after legitimate authority exists; this does not test Telegram issuance.
const source = fs.readFileSync(fileURLToPath(new URL('../../daemon/daemon.ts', import.meta.url)), 'utf8');
const match = source.match(/'remote\.disable': (\(\) => \{[\s\S]*?\n  \}),\n  'approval\.remote'/);
assert.ok(match, 'the remote.disable RPC handler must be available to this boundary check');
const originalNow = Date.now;
let clock = originalNow();
Date.now = () => clock;
for (const fault of ['write', 'rename', 'overdue-sweep', 'grant-event'] as const) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaddi-revocation-'));
  const state = path.join(dir, 'state.json');
  const owner = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const bot = crypto.generateKeyPairSync('ed25519');
  const pub = path.join(dir, 'owner.pub');
  const remoteKey = path.join(dir, 'remote.pub');
  fs.writeFileSync(pub, owner.publicKey.export({ type: 'spki', format: 'pem' }));
  fs.writeFileSync(remoteKey, bot.publicKey.export({ type: 'spki', format: 'pem' }));
  const proofs = createProofVerifier({ publicKeyPath: pub, usedPath: path.join(dir, 'used') });
  const remote = createRemote({ statePath: path.join(dir, 'remote.json'), keyPath: remoteKey, proofs });
  const fingerprint = crypto.createHash('sha256').update(bot.publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
  const turnOn = () => {
    const ts = ++clock;
    remote.enable(fingerprint, { ts, sig: crypto.sign('sha256', Buffer.from(enableMessage(fingerprint, ts)), owner.privateKey).toString('base64') });
  };
  let eventFault = false;
  const grants = createGrants({ now: () => clock, emit: () => { if (eventFault) throw new Error('fixture event failure'); } });
  const approvals: ReturnType<typeof createApprovals> = createApprovals({ ttlMinutes: 10,
    onChange: () => {
      fs.writeFileSync(state + '.tmp', JSON.stringify({ approvals: approvals.persistable() }), { mode: 0o600 });
      fs.renameSync(state + '.tmp', state);
    } });
  const action = (n: number) => ({ method: 'click', tab: 7, caller: 'fixture', url: 'https://example.test/posts', selector: '#post-' + n });
  const hold = (n: number) => approvals.hold({ kind: 'click', caller: 'fixture', url: action(n).url, detail: 'Post fixture ' + n, action: action(n) });
  try {
    turnOn();
    if (fault === 'overdue-sweep') { hold(0); clock += 9 * 60000; }
    const first = hold(1), second = hold(2), native = hold(3);
    approvals.resolveRemote(first.id, 'grant'); approvals.resolveRemote(second.id, 'grant');
    const ts = ++clock;
    approvals.signed(native.id, 'grant', { ts, sig: crypto.sign('sha256', Buffer.from(approvalMessage('grant', native, ts)), owner.privateKey).toString('base64') }, proofs, approvalMessage);
    const spec = { caller: 'fixture', session: 'fixture-chat', minutes: 60,
      rules: [{ permission: 'post' as const, origin: 'https://example.test', path: '/posts' }] };
    grants.activate({ ...spec, approver: 'remote' }); grants.activate({ ...spec, approver: 'remote' });
    const nativeGrant = grants.activate(spec);
    if (fault === 'overdue-sweep') clock += 2 * 60000;
    if (fault === 'write' || fault === 'overdue-sweep') fs.mkdirSync(state + '.tmp');
    if (fault === 'rename') { fs.renameSync(state, state + '.saved'); fs.mkdirSync(state); }
    if (fault === 'grant-event') eventFault = true;
    const disable = new Function('remote', 'grants', 'approvals', `return (${match[1]});`)(remote, grants, approvals) as () => unknown;
    assert.throws(disable, /EISDIR|ENOTDIR|fixture event failure/, fault + ': the real persistence/reporting fault is reported');
    assert.equal(remote.enabled(), false, fault + ': signer is off despite the error');
    assert.equal(fs.existsSync(path.join(dir, 'remote.json')), false);
    // Recover storage/reporting before testing actual use, not only status.
    eventFault = false;
    if (fault === 'write' || fault === 'overdue-sweep') fs.rmdirSync(state + '.tmp');
    if (fault === 'rename') { fs.rmdirSync(state); fs.renameSync(state + '.saved', state); }
    for (const [record, n] of [[first, 1], [second, 2]] as const) {
      assert.throws(() => approvals.consume(record.id, action(n)), /is cancelled/, fault + ': every remote one-shot must be revoked after recovery');
    }
    assert.deepEqual(grants.active('fixture-chat').map(g => g.id), [nativeGrant.id], fault + ': all remote grants end and native scope remains');
    turnOn();
    for (const [record, n] of [[first, 1], [second, 2]] as const) assert.throws(() => approvals.consume(record.id, action(n)), /is cancelled/, 're-enable cannot revive a revoked record');
    assert.equal(approvals.consume(native.id, action(3)).status, 'used', fault + ': native one-shot positive control still works');
    console.log('PASS remote-off fault recovery: ' + fault);
  } finally {
    approvals.stop(); grants.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
Date.now = originalNow;
