import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { isRecord } from '../../shared/protocol.ts';

// Run the actual broker sweep and forwarding code with a deterministic clock,
// synthetic bridge and tab inventory. No broker process, Chrome or owner files.
const source = fs.readFileSync(new URL('../../daemon/daemon.ts', import.meta.url), 'utf8');
const sweep = source.slice(source.indexOf('async function sweepSessions()'), source.indexOf('let sweepPending = false;'));
const browser = source.slice(source.indexOf('async function browserCall('), source.indexOf('// ---------------------------------------------------------------- session grants'));
const attach = source.slice(source.indexOf('  if (event === \'bridge.attach\') {'), source.indexOf("  if (event === 'approval.pending')"));
const mutations: Record<string, [string, string]> = {
  FIRST_SIGHT: ['tabActivity.set(id, now)', 'tabActivity.set(id, 0)'],
  ORPHAN_CLOSE: ['idle >= SESSION_IDLE_MS', 'false'],
  LIVE_SESSION: ['const live = owners.some(owner => !expired(owner));', 'const live = false;'],
  TAB_CLOCK: ["if (typeof args.tab === 'number') tabActivity.set(args.tab, Date.now());", 'void args.tab;'],
  OPEN_CLOCK: ['tabActivity.set(meta.tab, Date.now());', 'void meta.tab;'],
  REATTACH_CLOCK: ['tabActivity.clear();', 'void tabActivity;'],
  SHOWN: ["typeof id !== 'number' || shown.has(id)", "typeof id !== 'number'"],
  END_GRACE: ['now - session.endedAt >= SESSION_END_MS', 'true'],
  BATCH: ['offset += 100', 'offset += 101'],
  CLOSED_ONLY: ['forgetClosed(ids);', 'forgetClosed(chunk.map(tab => tab.tab));'],
  SHARED: ["if (policy.browser.window === 'shared') return sweepSharedSessions();", 'void policy;'],
};
const mutation = process.argv[2];
assert.ok(!mutation || mutations[mutation], 'known mutation');
let code = sweep + browser + '\nfunction reattach(event = "bridge.attach") {\n' + attach + '\n}';
if (mutation) {
  const [before, after] = mutations[mutation];
  assert.ok(code.includes(before), `mutation ${mutation} exists`);
  code = code.replaceAll(before, after);
}
code = stripTypeScriptTypes(code);
let passed = 0;
const test = async (name: string, fn: () => Promise<void>) => {
  if (mutation && mutation !== name) return;
  try { await fn(); passed++; console.log(`PASS ASSERT_IDLE_${name}`); }
  catch (error) { console.error(`FAIL ASSERT_IDLE_${name}: ${String(error)}`); throw error; }
};
function fixture() {
  let now = 10000000;
  const tabs = new Map<number, { id: number; url: string }>();
  const sessions = new Map<string, { caller: string; owned: Set<number>; lastActivity: number; endedAt?: number }>();
  const tabActivity = new Map<number, number>(), shown = new Set<number>();
  const calls: { method: string; params: any }[] = [], audits: any[] = [];
  let failClose = false, sharedCalls = 0;
  const policy = { browser: { window: 'own', show: 'attention' } };
  const bridge = {
    status: () => ({ connected: true }), connection: () => 'bridge',
    async request(method: string, params: any) {
      calls.push({ method, params });
      if (method === 'chrome.tabs' || method === 'chrome.cleanup' && !params.cleanup) return { tabs: [...tabs.values()] };
      if (method === 'chrome.cleanup') {
        assert.ok(params.tabs.length <= 100, 'bridge batch cap');
        if (failClose && params.cleanup === 'close') return { closed: [], failed: params.tabs };
        assert.equal(params.cleanup, 'close', 'idle maintenance only closes eligible tabs');
        for (const id of params.tabs) tabs.delete(id);
        return { closed: params.tabs, failed: [] };
      }
      if (method === 'chrome.open') { const tab = { id: 100, url: params.url }; tabs.set(100, tab); return tab; }
      if (method === 'chrome.eval') return { value: 1 };
      throw new Error(`unexpected ${method}`);
    },
  };
  const world = vm.createContext({
    Date: class extends Date { static now() { return now; } }, bridge, policy, sessions, tabActivity, shown, isRecord,
    SESSION_IDLE_MS: 900000, SESSION_END_MS: 120000, SESSION_TAB_LIMIT: 512,
    tabList: (result: any) => result.tabs, tabFields: (tab: any) => tab, tabId: (tab: any) => tab.id,
    tabURL: (tab: any) => tab.url, tabObject: (tab: any) => tab, cleanURL: (url: string) => url.split('?')[0],
    audit: (entry: any) => audits.push(entry), sweepSharedSessions: async () => { sharedCalls++; },
    forgetClosed: (ids: number[]) => { for (const id of ids) { tabActivity.delete(id); shown.delete(id); for (const session of sessions.values()) session.owned.delete(id); } },
    touchSession: () => { const session = { caller: 'agent', owned: new Set<number>(), lastActivity: now }; sessions.set('action', session); return session; },
    noEffects: new Map(), navigationURL: (url: string) => url, groupTitle: () => '● Fixture',
    requiredString: (value: string) => value, gate: async () => {}, checkNavigation: () => ({}), zoneNavigation: (check: unknown) => check, checkEval: () => ({}),
    signinSecrets: { redact: (value: unknown) => value },
  });
  vm.runInContext(code, world);
  return { tabs, sessions, tabActivity, shown, calls, audits, policy,
    advance(ms: number) { now += ms; }, now: () => now,
    add(id: number) { tabs.set(id, { id, url: `https://fixture.test/${id}?private` }); },
    failClose() { failClose = true; }, sharedCalls: () => sharedCalls,
    sweep: () => vm.runInContext('sweepSessions()', world) as Promise<void>,
    reattach: () => vm.runInContext('reattach()', world),
    async action(method: string, id?: number) {
      world.actionMethod = method; world.actionParams = { tab: id, url: 'https://fixture.test/new', expression: '1' };
      return vm.runInContext("browserCall(actionMethod, actionParams, {caller:'agent'})", world);
    },
  };
}
await test('FIRST_SIGHT', async () => {
  const f = fixture();f.add(1);await f.sweep();assert.equal(f.tabs.size, 1);
  f.advance(899999);await f.sweep();assert.equal(f.tabs.size, 1);
  assert.ok(f.calls.every(call => !call.params.cleanup), 'no mutation before the idle close threshold');
});
await test('ORPHAN_CLOSE', async () => {
  const f = fixture();f.add(1);await f.sweep();f.advance(900000);await f.sweep();assert.equal(f.tabs.size, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(f.audits[0].tabs)),[{tab:1,url:'https://fixture.test/1'}]);
});
await test('LIVE_SESSION', async () => {
  const f = fixture();f.add(1);await f.sweep();f.advance(900001);
  f.sessions.set('live',{caller:'agent',owned:new Set([1]),lastActivity:f.now()});
  await f.sweep();assert.equal(f.tabs.size,1);
});
await test('TAB_CLOCK', async () => {
  const f = fixture();f.add(1);f.add(2);await f.sweep();f.advance(899999);await f.action('eval',1);
  f.advance(1);await f.sweep();assert.ok(f.tabs.has(1));assert.ok(!f.tabs.has(2));
});
await test('OPEN_CLOCK', async () => {
  const f = fixture();await f.action('open');assert.equal(f.tabActivity.get(100),f.now());
});
await test('REATTACH_CLOCK', async () => {
  const f = fixture();f.add(1);await f.sweep();f.advance(900001);f.reattach();await f.sweep();assert.equal(f.tabs.size,1);
  f.advance(900000);await f.sweep();assert.equal(f.tabs.size,0);
});
await test('SHOWN', async () => {
  const f = fixture();f.add(1);f.shown.add(1);await f.sweep();f.advance(900001);await f.sweep();assert.equal(f.tabs.size,1);
});
await test('END_GRACE', async () => {
  const f = fixture();f.add(1);f.sessions.set('ended',{caller:'agent',owned:new Set([1]),lastActivity:f.now(),endedAt:f.now()});
  await f.sweep();f.advance(119999);await f.sweep();assert.equal(f.tabs.size,1);
  f.advance(1);await f.sweep();assert.equal(f.tabs.size,0);
});
await test('BATCH', async () => {
  const f = fixture();for(let id=1;id<=205;id++)f.add(id);await f.sweep();f.advance(900000);await f.sweep();assert.equal(f.tabs.size,0);
  assert.deepEqual(f.calls.filter(call=>call.params.cleanup==='close').map(call=>call.params.tabs.length),[100,100,5]);
});
await test('CLOSED_ONLY', async () => {
  const f = fixture();f.add(1);await f.sweep();f.advance(900000);f.failClose();await f.sweep();assert.equal(f.tabs.size,1);assert.ok(f.tabActivity.has(1));
});
await test('SHARED', async () => {
  const f = fixture();f.policy.browser.window='shared';f.add(1);await f.sweep();assert.equal(f.sharedCalls(),1);assert.equal(f.calls.length,0);
});
console.log(`== idle lifecycle: ${passed} passed, 0 failed`);
