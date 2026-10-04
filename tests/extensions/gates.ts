import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { extensionCall } from '../../daemon/extensions.ts';
import { createApprovals, GateError } from '../../daemon/approvals.ts';
import { loadPolicy } from '../../daemon/policy.ts';
import { createProofVerifier, approvalMessage } from '../../daemon/proof.ts';
import type { ChromeParams, ExtensionInfo } from '../../shared/protocol.ts';

const root = path.resolve('tests/.state/extensions'); fs.mkdirSync(root, { recursive: true });
const state = fs.mkdtempSync(path.join(root, 'gates-'));
const keys = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pub = path.join(state, 'approver.pub'); fs.writeFileSync(pub, keys.publicKey.export({ type: 'spki', format: 'pem' }));
const proofs = createProofVerifier({ publicKeyPath: pub, usedPath: path.join(state, 'used-proofs.log') });
const approvals = createApprovals({});
const policy = loadPolicy();
const self = 'a'.repeat(32), other = 'b'.repeat(32);
const target: ExtensionInfo = { id: other, name: 'Fixture', version: '1', enabled: true, installType: 'development', mayDisable: true, type: 'extension', self: false };
let writes = 0, held = '', changeOnSecondRead = false, reads = 0, passed = 0;
const pass = (label: string) => { passed++; console.log(`PASS ${label}`); };
const request = async (params: ChromeParams): Promise<unknown> => {
  if (params.operation === 'list') return { extensions: [target] };
  if (params.operation === 'get') {
    const info = { ...target, ...(params.extensionId === 'self' || params.extensionId === self ? { id: self, self: true } : {}) };
    if (changeOnSecondRead && ++reads === 2) info.version = 'replaced';
    return info;
  }
  writes++; return { ok: true };
};
type Gate = Parameters<typeof extensionCall>[4];
const gate: Gate = async ({ action, check, approval, ...display }) => {
  if (approval) { approvals.consume(approval, action); return; }
  if (check.outcome === 'allow') return;
  const record = approvals.hold({ ...display, ...display.meta, action, reason: check.reason });
  held = String(record.id); throw new GateError('held', 'held');
};
function grant() {
  const record = approvals.get(held), ts = Date.now();
  const sig = crypto.sign('sha256', Buffer.from(approvalMessage('grant', record, ts)), keys.privateKey).toString('base64');
  approvals.signed(held, 'grant', { ts, sig }, proofs, approvalMessage);
}
const call = (params: Parameters<typeof extensionCall>[0]) => extensionCall(params, 'test', policy, request, gate);
try {
  await call({}); assert.equal(writes, 0); pass('list performs no mutation or gate');
  await call({ operation: 'reload', extensionId: other }); assert.equal(writes, 1);
  await call({ operation: 'enable', extensionId: other }); assert.equal(writes, 2); pass('reload and enable use normal authorization');
  await assert.rejects(call({ operation: 'disable', extensionId: other }), error => error instanceof GateError && error.code === 'held');
  assert.equal(writes, 2); grant(); const id = held;
  await call({ operation: 'disable', extensionId: other, approval: id }); assert.equal(writes, 3);
  await assert.rejects(call({ operation: 'disable', extensionId: other, approval: id })); assert.equal(writes, 3);
  pass('disable gate precedes mutation, signed grant authorizes one exact retry');
  await assert.rejects(call({ operation: 'uninstall', extensionId: other })); grant(); target.version = '2';
  await assert.rejects(call({ operation: 'uninstall', extensionId: other, approval: held })); assert.equal(writes, 3);
  pass('replacement metadata invalidates signed uninstall decision');
  for (const operation of ['disable', 'uninstall'] as const) await assert.rejects(call({ operation, extensionId: 'self' }), error => error instanceof GateError && error.code === 'denied');
  assert.equal(writes, 3); pass('self lockout is denied without approval path');
  changeOnSecondRead = true; reads = 0;
  await assert.rejects(call({ operation: 'reload', extensionId: other }), /extension changed/); assert.equal(writes, 3);
  pass('post-gate recheck rejects target changed before mutation');
  changeOnSecondRead = false;
  const source = path.join(state, 'source'); fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Local', version: '1' }));
  await assert.rejects(call({ operation: 'install', path: source }), error => error instanceof GateError && error.code === 'held');
  grant(); fs.writeFileSync(path.join(source, 'code.js'), 'const changed = true;');
  await assert.rejects(call({ operation: 'install', path: source, approval: held })); assert.equal(writes, 3);
  pass('whole-folder edit invalidates installation approval');
  const forged = await extensionCall({ operation: 'list' }, 'test', policy,
    async () => ({ extensions: [{ ...target, self: 'forged' }] }), gate).then(() => false, () => true);
  assert.equal(forged, true); pass('malformed Chrome metadata is refused before becoming authority');
} finally { approvals.stop(); }
console.log(`== extension gates: ${passed} passed, 0 failed`);
