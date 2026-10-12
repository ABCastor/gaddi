import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import type { Socket } from 'node:net';
import { isRecord } from '../../shared/protocol.ts';


const mutants: Record<string, [string, string]> = {
  RESTORE: ["await focus.activate(before).catch(() => {});", 'void before;'],
  EXISTING: ['created = isRecord(result) && result.windowCreated === true;', 'created = true;'],
  CHROME: ["before.bundle !== 'com.google.Chrome'", 'true'],
  USER_SWITCH: ["after?.bundle === 'com.google.Chrome'", '!!after'],
  OPEN_ERROR: ['created = isRecord(error) && error.windowCreated === true;', 'created = false;'],
  READ_FAILURE: ['const before = await focus.front().catch(() => undefined);', 'const before = await focus.front();'],
  ACTIVATE_FAILURE: ['await focus.activate(before).catch(() => {});', 'await focus.activate(before);'],
  ADAPTER: ["['setfront', app.asn]", "['setfront', 'com.google.Chrome']"],
  NON_MAC: ["if (platform !== 'darwin') return;", 'void platform;'],
  MALFORMED: ['if (!/^ASN:0x[\\da-f]+-0x[\\da-f]+:?$/i.test(asn)) return;', 'void asn;'],
};
const selected = process.argv[2];
let bridgeSource = fs.readFileSync(new URL('../../daemon/bridge.ts', import.meta.url), 'utf8');
if (selected === 'BRIDGE_ERROR') {
  const before = 'isRecord(msg.error) && msg.error.windowCreated === true ? { windowCreated: true } : {},';
  assert.equal(bridgeSource.split(before).length, 2);
  bridgeSource = bridgeSource.replace(before, '{},');
}
const bridgeWorld = vm.createContext({ crypto, isRecord, setTimeout, clearTimeout });
vm.runInContext(stripTypeScriptTypes(bridgeSource).replace(/^import .*;$/gm, '').replace(/^export /gm, ''), bridgeWorld);
const createBridge: typeof import('../../daemon/bridge.ts').createBridge = vm.runInContext('createBridge', bridgeWorld);
let source = fs.readFileSync(new URL('../../daemon/open-focus.ts', import.meta.url), 'utf8');
if (selected && mutants[selected]) {
  const [before, after] = mutants[selected];
  assert.equal(source.split(before).length, 2, `Unique mutant ${selected}`);
  source = source.replace(before, after);
}
const world = vm.createContext({ execFile, promisify, isRecord, process });
vm.runInContext(stripTypeScriptTypes(source).replace(/^import .*;$/gm, '').replace(/^export /gm, ''), world);
const preserve: typeof import('../../daemon/open-focus.ts').preserveOpenFocus = vm.runInContext('preserveOpenFocus', world);
const adapter: typeof import('../../daemon/open-focus.ts').macOpenFocus = vm.runInContext('macOpenFocus', world);
const owner = { asn: 'ASN:0x0-0x1001:', bundle: 'com.apple.Terminal' };
const chrome = { asn: 'ASN:0x0-0x1002:', bundle: 'com.google.Chrome' };
const other = { asn: 'ASN:0x0-0x1003:', bundle: 'com.apple.finder' };
function fixture(before = owner, after = chrome) {
  let reads = 0;
  const activated: typeof owner[] = [];
  return { activated, get reads() { return reads; },
    front: async () => ++reads === 1 ? before : after,
    activate: async (app: typeof owner) => { activated.push(app); } };
}
let passed = 0;
async function test(name: string, body: () => Promise<void>) {
  if (selected && selected !== name) return;
  try { await body(); passed++; console.log(`PASS ASSERT_OPEN_FOCUS_${name}`); }
  catch (error) { console.error(`FAIL ASSERT_OPEN_FOCUS_${name}: ${String(error)}`); throw error; }
}
await test('RESTORE', async () => {
  const focus = fixture(); const result = { id: 7, windowCreated: true };
  assert.equal(await preserve(async () => { assert.equal(focus.reads, 1); return result; }, focus), result);
  assert.deepEqual(focus.activated, [owner]); assert.equal(focus.reads, 2);
});
await test('EXISTING', async () => {
  for (const result of [{ id: 7 }, { id: 7, windowCreated: false }]) {
    const focus = fixture(); await preserve(async () => result, focus);
    assert.equal(focus.reads, 1); assert.deepEqual(focus.activated, []);
  }
});
await test('CHROME', async () => {
  const focus = fixture(chrome, { ...chrome, asn: 'ASN:0x0-0x1004:' });
  await preserve(async () => ({ windowCreated: true }), focus);
  assert.equal(focus.reads, 1); assert.deepEqual(focus.activated, []);
});
await test('USER_SWITCH', async () => {
  for (const after of [owner, other]) {
    const focus = fixture(owner, after); await preserve(async () => ({ windowCreated: true }), focus);
    assert.deepEqual(focus.activated, []);
  }
});
await test('OPEN_ERROR', async () => {
  const focus = fixture(); const error = Object.assign(new Error('navigation failed'), { windowCreated: true });
  await assert.rejects(preserve(async () => { throw error; }, focus), value => value === error);
  assert.deepEqual(focus.activated, [owner]);
  const existing = fixture();
  await assert.rejects(preserve(async () => { throw new Error('before creation'); }, existing), /before creation/);
  assert.deepEqual(existing.activated, []);
});
await test('READ_FAILURE', async () => {
  const activated: unknown[] = [];
  for (const failAt of [1, 2]) {
    let reads = 0;
    const focus = { front: async () => { if (++reads === failAt) throw new Error('probe failed'); return owner; },
      activate: async (app: unknown) => { activated.push(app); } };
    assert.equal(await preserve(async () => ({ id: 7, windowCreated: true }), focus).then(r => r.id), 7);
  }
  assert.deepEqual(activated, []);
});
await test('ACTIVATE_FAILURE', async () => {
  const focus = { ...fixture(), activate: async () => { throw new Error('application exited'); } };
  assert.equal((await preserve(async () => ({ id: 7, windowCreated: true }), focus)).id, 7);
});
await test('ADAPTER', async () => {
  const calls: string[][] = [];
  const focus = adapter('darwin', async args => {
    calls.push(Array.from(args));
    return args[0] === 'front' ? 'ASN:0x0-0x1001:\n' : '[ NULL ]  ASN:0x0-0x1001: (in front) \n    bundleID="com.apple.Terminal"\n    bundle path=[ NULL ] \n';
  });
  const front = await focus.front(); assert.ok(front);
  assert.equal(front.asn, owner.asn); assert.equal(front.bundle, owner.bundle); await focus.activate(front);
  assert.deepEqual(calls, [['front'], ['info', '-only', 'bundleid', owner.asn], ['setfront', owner.asn]]);
});
await test('NON_MAC', async () => {
  let calls = 0;
  const focus = adapter('linux', async () => { calls++; return ''; });
  assert.equal(await focus.front(), undefined); assert.equal(calls, 0);
});
await test('MALFORMED', async () => {
  for (const response of ['NULL', 'Terminal', 'ASN:0x0-0x1001:\nextra']) {
    let calls = 0;
    const focus = adapter('darwin', async () => { calls++; return response; });
    assert.equal(await focus.front(), undefined); assert.equal(calls, 1);
  }
});
await test('BRIDGE_ERROR', async () => {
  let id = '';
  const connection = Object.assign(new EventEmitter(), { destroyed: false, destroy() {},
    write(line: string) { id = JSON.parse(line).id; } }) as unknown as Socket;
  const bridge = createBridge(); bridge.attach(connection, 'chrome');
  const pending = bridge.request('chrome.open', {}, connection);
  bridge.receive(connection, { id, error: { message: 'navigation failed', windowCreated: true } });
  await assert.rejects(pending, error => isRecord(error) && error.windowCreated === true && error.message === 'navigation failed');
});
await test('BROKER_WIRING', async () => {
  // Execute the broker's actual open forwarding slice with fake bridge and focus adapters.
  const daemon = fs.readFileSync(new URL('../../daemon/daemon.ts', import.meta.url), 'utf8');
  let forwarding = daemon.slice(daemon.indexOf("    const open = () => request('open'"), daemon.indexOf('    meta.tab = tabId(tabObject(result));'));
  assert.ok(forwarding.includes('preserveOpenFocus'));
  if (selected === 'BROKER_WIRING') forwarding = forwarding.replace("policy.browser.window === 'own'", 'false');
  for (const policy of ['own', 'shared']) {
    let snapshots = 0, requests = 0;
    const context = vm.createContext({ policy: { browser: { window: policy } }, url: 'https://fixture.test/', group: 'Fixture', params: {}, isRecord,
      request: async (method: string) => { assert.equal(method, 'open'); requests++; return { id: 7, windowCreated: true }; },
      preserveOpenFocus: async (open: () => Promise<unknown>) => { snapshots++; return open(); } });
    const result = await vm.runInContext(`(async () => { ${forwarding}\nreturn result; })()`, context);
    assert.equal(result.id, 7); assert.equal(result.windowCreated, undefined); assert.equal(requests, 1); assert.equal(snapshots, policy === 'own' ? 1 : 0);
  }
});
console.log(`== open focus: ${passed} passed, 0 failed`);
