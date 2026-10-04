import assert from 'node:assert/strict';
import { manageExtensions } from '../../extension/extensions.ts';
import { extensionParams } from '../../shared/protocol.ts';
import { checkExtension, loadPolicy } from '../../daemon/policy.ts';
import type { ChromeParams } from '../../shared/protocol.ts';

const self = 'a'.repeat(32), other = 'b'.repeat(32);
let passed = 0, scheduled = 0, failEnable = 0;
const calls: string[] = [];
const items = new Map<string, chrome.management.ExtensionInfo>([
  [self, { id: self, name: 'Gaddi', version: '1', enabled: true, installType: 'development', mayDisable: true, type: 'extension', description: '', optionsUrl: '', shortName: '', isApp: false, offlineEnabled: false, permissions: [], hostPermissions: [] }],
  [other, { id: other, name: 'Fixture', version: '1', enabled: true, installType: 'development', mayDisable: true, type: 'extension', description: '', optionsUrl: '', shortName: '', isApp: false, offlineEnabled: false, permissions: [], hostPermissions: [] }],
]);
Object.assign(globalThis, { chrome: {
  runtime: { id: self },
  management: {
    get: async (id: string) => { const item = items.get(id); if (!item) throw new Error('missing extension'); return { ...item }; },
    getAll: async () => [...items.values()].map(item => ({ ...item })),
    setEnabled: async (id: string, enabled: boolean) => {
      calls.push(`${id}:${enabled}`);
      if (enabled && failEnable-- > 0) throw new Error('enable failed');
      items.get(id)!.enabled = enabled;
    },
    uninstall: async (id: string) => { calls.push(`uninstall:${id}`); items.delete(id); },
  },
} });
const run = (params: ChromeParams, check = () => {}) => manageExtensions(params, check, async () => ({ scheduled: ++scheduled > 0 }));
function pass(label: string) { console.log(`PASS ${label}`); passed++; }

assert.deepEqual((await run({}) as { extensions: unknown[] }).extensions.length, 2);
pass('list identifies installed extensions');
await run({ operation: 'reload', extensionId: 'self' });
assert.equal(scheduled, 1); assert.equal(calls.length, 0);
pass('self reload uses bounded recovery instead of disabling the bridge');
for (const operation of ['disable', 'uninstall'] as const) {
  await assert.rejects(run({ operation, extensionId: self }), /cannot disable or uninstall itself/);
}
assert.equal(calls.length, 0); pass('Gaddi cannot remove its own control path');
await run({ operation: 'reload', extensionId: other });
assert.deepEqual(calls.splice(0), [`${other}:false`, `${other}:true`]);
pass('other extension reload disables then re-enables');
failEnable = 1;
await run({ operation: 'reload', extensionId: other });
assert.equal(items.get(other)!.enabled, true); assert.equal(calls.splice(0).length, 3);
pass('restart restores enabled state when first enable fails');
failEnable = 2;
await assert.rejects(run({ operation: 'reload', extensionId: other }), /could not re-enable/);
assert.equal(items.get(other)!.enabled, false); calls.splice(0);
pass('failed restart reports disabled state honestly');
await assert.rejects(run({ operation: 'reload', extensionId: other }), /disabled; use enable/);
assert.equal(calls.length, 0); pass('reload cannot silently enable a disabled extension');
await run({ operation: 'enable', extensionId: other });
items.get(other)!.mayDisable = false;
await assert.rejects(run({ operation: 'disable', extensionId: other }), /Chrome policy/);
items.get(other)!.mayDisable = true;
pass('management respects Chrome managed-extension restrictions');
const removal = await run({ operation: 'uninstall', extensionId: other });
assert.ok(removal && typeof removal === 'object' && 'uninstalled' in removal && removal.uninstalled === false);
assert.ok(items.has(other)); assert.ok(!calls.some(call => call.startsWith('uninstall:')));
pass('uninstall reports required Chrome gesture rather than pretending removal succeeded');
for (const params of [{ operation: 'eval' }, { operation: 'list', extensionId: other }, { operation: 'install', path: '/tmp/a', extensionId: other },
  { operation: 'disable', extensionId: 'bad' }, { operation: 'reload', extensionId: other, path: '/tmp/a' }]) assert.throws(() => extensionParams(params));
pass('broker and extension share strict operation validation');
const policy = loadPolicy();
assert.equal(checkExtension(policy, 'disable').outcome, 'hold');
assert.equal(checkExtension(policy, 'uninstall').outcome, 'hold');
assert.equal(checkExtension(policy, 'reload').outcome, 'allow');
assert.equal(checkExtension(policy, 'enable').outcome, 'allow');
assert.equal(checkExtension(policy, 'install', true).outcome, 'allow');
assert.equal(checkExtension({ ...policy, off: true }, 'install', false).outcome, 'hold');
assert.equal(checkExtension({ ...policy, hold: { ...policy.hold, extensions: { disable: false } } }, 'disable').outcome, 'allow');
pass('policy holds removal and outside-repo install, reload stays unheld');
console.log(`== extension management: ${passed} passed, 0 failed`);
