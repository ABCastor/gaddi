import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import { createRecovery, RECOVERY_KEY, RELOAD_COOLDOWN_MS } from '../../extension/recovery.ts';
import { createBridge } from '../../daemon/bridge.ts';
import { isRecord, hasErrorCode } from '../../shared/protocol.ts';

let passed = 0;
const pass = (label: string) => { passed++; console.log(`PASS ${label}`); };
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
class Clock {
  now = 1_000_000;
  sequence = 0;
  tasks = new Map<number, { at: number; fn: () => void }>();
  set(fn: () => void, delay: number) { const id = ++this.sequence; this.tasks.set(id, { at: this.now + delay, fn }); return id; }
  clear(id: number) { this.tasks.delete(id); }
  async tick(ms: number) {
    const target = this.now + ms;
    while (true) {
      const next = [...this.tasks].filter(([, task]) => task.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.now = next[1].at; this.tasks.delete(next[0]); next[1].fn(); await flush();
    }
    this.now = target; await flush();
  }
}

// Use the actual module with persistent storage shared by replacement workers.
{
  const clock = new Clock();
  let stored: unknown, reloads = 0, failStorage = false;
  const make = () => createRecovery({ now: () => clock.now,
    load: async () => { if (failStorage) throw new Error('storage unavailable'); return structuredClone(stored); },
    save: async state => { if (failStorage) throw new Error('storage unavailable'); stored = structuredClone(state); },
    later: fn => clock.set(fn, 250), reload: () => { reloads++; },
  });
  let recovery = make();
  for (let i = 0; i < 4; i++) await recovery.failed('native-disconnect');
  assert.equal(reloads, 0);
  await recovery.failed('native-disconnect');
  assert.equal(reloads, 0, 'reload is delayed so its acknowledgment can be delivered');
  assert.ok(isRecord(stored) && isRecord(stored.lastSelfHeal));
  assert.equal(stored.lastSelfHeal.action, 'reload', 'allowance and marker reach storage before reload');
  await clock.tick(250); assert.equal(reloads, 1);
  recovery = make(); await recovery.ready;
  assert.deepEqual(await recovery.requestSelfReload(), { scheduled: false, reason: 'self-reload rate limit' });
  await clock.tick(RELOAD_COOLDOWN_MS);
  assert.equal((await recovery.requestSelfReload()).scheduled, true);
  await clock.tick(250); assert.equal(reloads, 2);
  recovery = make(); await clock.tick(RELOAD_COOLDOWN_MS);
  assert.equal((await recovery.requestSelfReload()).scheduled, true);
  await clock.tick(250); assert.equal(reloads, 3);
  recovery = make(); await clock.tick(RELOAD_COOLDOWN_MS);
  assert.equal((await recovery.requestSelfReload()).scheduled, false, 'three/hour bound survives another worker replacement');
  pass('five failures escalate, acknowledgments precede reload, and persisted cooldown/hour cap survive worker restarts');

  await clock.tick(60 * 60 * 1000);
  failStorage = true; recovery = make(); await recovery.ready;
  for (let i = 0; i < 6; i++) await recovery.failed('broker-unresponsive');
  await clock.tick(500); assert.equal(reloads, 3, 'storage failure must never bypass reload budget');
  failStorage = false;
  await recovery.failed('broker-unresponsive');
  await clock.tick(250); assert.equal(reloads, 4, 'storage recovery re-enables bounded self-heal');
  pass('storage denial closes reload while a later storage recovery permits it');

  recovery = make(); await recovery.failed('broker-unresponsive'); await recovery.healthy();
  assert.equal(recovery.lastSelfHeal()?.action, 'reconnect');
  assert.equal(recovery.lastSelfHeal()?.reason, 'broker-unresponsive');
  assert.ok(isRecord(stored) && stored.failures === 0);
  pass('successful broker health resets failures and records automatic reconnect metadata');
}
{
  const clock = new Clock();
  let stored: unknown = { failures: 5, reloadTimes: [clock.now - 3000, clock.now - 2000, clock.now - 1000] }, writes = 0, reloads = 0;
  let denyRead = true;
  const recovery = createRecovery({ now: () => clock.now,
    load: async () => { if (denyRead) throw new Error('get rejected'); return structuredClone(stored); },
    save: async state => { writes++; stored = structuredClone(state); },
    later: fn => clock.set(fn, 250), reload: () => { reloads++; },
  });
  await recovery.ready;
  for (let i = 0; i < 6; i++) await recovery.failed('native-disconnect');
  await clock.tick(250);
  assert.equal(writes, 0, 'set succeeding must not erase reload history when get is denied');
  assert.equal(reloads, 0);
  denyRead = false;
  await recovery.failed('native-disconnect'); await clock.tick(250);
  assert.equal(reloads, 0, 'recovered get must restore the old exhausted allowance before any write');
  assert.ok(isRecord(stored) && Array.isArray(stored.reloadTimes));
  assert.equal(stored.reloadTimes.length, 3);
  pass('asymmetric storage get denial/set success preserves unknown prior reload budget until it can be read');
}
{
  const clock = new Clock();
  let stored: unknown = { failures: 3, reloadTimes: [] }, failSave = true, reloads = 0;
  const recovery = createRecovery({ now: () => clock.now, load: async () => structuredClone(stored),
    save: async state => { if (failSave) throw new Error('ENOSPC'); stored = structuredClone(state); },
    later: fn => clock.set(fn, 250), reload: () => { reloads++; },
  });
  await recovery.failed('native-disconnect');
  failSave = false; await recovery.healthy();
  assert.ok(isRecord(stored)); assert.equal(stored.failures, 0, 'successful health supersedes stale persisted failures after a failed save');
  await recovery.failed('native-disconnect'); await recovery.failed('native-disconnect'); await clock.tick(250);
  assert.equal(reloads, 0, 'two new failures after recovery cannot inherit three stale failures');
  assert.ok(isRecord(stored)); assert.equal(stored.failures, 2);
  pass('successful health after ENOSPC resets failure count without resurrecting persisted failures');
}
{
  const clock = new Clock();
  let releaseSave: (() => void) | undefined, reloads = 0;
  const recovery = createRecovery({ now: () => clock.now, load: async () => undefined,
    save: () => new Promise<void>(resolve => { releaseSave = resolve; }),
    later: fn => clock.set(fn, 250), reload: () => { reloads++; },
  });
  const deadline = clock.now + 100;
  const request = recovery.requestSelfReload('broker-requested', () => { if (clock.now >= deadline) throw new Error('request expired'); });
  const rejected = assert.rejects(request, /request expired/);
  await flush(); assert.ok(releaseSave);
  clock.now += 100; releaseSave(); await rejected;
  await clock.tick(250); assert.equal(reloads, 0);
  pass('self-reload guard is rechecked after an awaited storage save exceeds the requesting action deadline');
}

const event = <T>() => ({ listeners: [] as ((value: T) => void)[], addListener(fn: (value: T) => void) { this.listeners.push(fn); }, emit(value: T) { for (const fn of this.listeners) fn(value); } });
type Message = { id: string | number; method?: string; params?: object; deadline?: number; result?: unknown; error?: { message: string } };
class NativePort {
  onMessage = event<Message>(); onDisconnect = event<void>();
  sent: Message[] = []; disconnected = false;
  healthResponse: () => boolean;
  constructor(healthResponse: () => boolean) { this.healthResponse = healthResponse; }
  postMessage(message: Message) {
    this.sent.push(message);
    if (message.method === 'bridge.health' && this.healthResponse()) queueMicrotask(() => this.onMessage.emit({ id: message.id, method: 'bridge.health', result: { connected: true } }));
  }
  disconnect() { this.disconnected = true; this.onDisconnect.emit(); }
}
const source = stripTypeScriptTypes(fs.readFileSync(new URL('../../extension/bg.ts', import.meta.url), 'utf8'))
  .replace(/^import .*;$/gm, '').split('const tabQueues =')[0];
function worker({ clock, saved, unavailable = false, healthResponse = () => true, read }: {
  clock: Clock; saved: { value?: unknown }; unavailable?: boolean; healthResponse?: () => boolean; read?: () => Promise<unknown>;
}) {
  const ports: NativePort[] = []; let reloads = 0, actions = 0, finish: ((value: unknown) => void) | undefined;
  const chrome = {
    storage: { local: { async get() { return { [RECOVERY_KEY]: read ? await read() : structuredClone(saved.value) }; }, async set(value: Record<string, unknown>) { saved.value = structuredClone(value[RECOVERY_KEY]); } } },
    runtime: { onStartup: event<void>(), onInstalled: event<void>(), lastError: undefined, reload() { reloads++; },
      connectNative() { if (unavailable) throw new Error('native host unavailable'); const port = new NativePort(healthResponse); ports.push(port); return port; } },
    alarms: { onAlarm: event<{ name: string }>(), create() {} },
  };
  const context = vm.createContext({ chrome, RECOVERY_KEY, isRecord, hasErrorCode, Date: { now: () => clock.now },
    createRecovery: (options: Parameters<typeof createRecovery>[0]) => createRecovery({ ...options, now: () => clock.now, later: fn => clock.set(fn, 250) }),
    setTimeout: (fn: () => void, delay: number) => clock.set(fn, delay), clearTimeout: (id: number) => clock.clear(id),
    detachLingering() {}, isSigninMethod: () => false,
    withinDeadline: (fn: (scope: unknown) => Promise<unknown>) => fn({}),
    dispatch: () => { actions++; return new Promise(resolve => { finish = resolve; }); },
  });
  vm.runInContext(source, context);
  return { context, ports, chrome, reloads: () => reloads, actions: () => actions, finish: () => finish?.({ acted: true }) };
}

{
  const clock = new Clock(), saved: { value?: unknown } = {};
  let brokerHealthy = false;
  const world = worker({ clock, saved, healthResponse: () => brokerHealthy }); await flush();
  assert.equal(world.ports.length, 1);
  assert.equal(world.ports[0].sent[0].method, 'bridge.health');
  world.ports[0].onMessage.emit({ id: 7, method: 'chrome.click', params: { selector: '#pay' } }); await flush();
  await clock.tick(10000);
  assert.equal(world.ports[0].disconnected, true, 'host with a stalled broker is disconnected by health deadline');
  await clock.tick(250); assert.equal(world.ports.length, 2);
  world.finish(); await flush();
  assert.equal(world.actions(), 1, 'pending action is never replayed on the fresh port');
  assert.equal(world.ports[1].sent.some(message => message.id === 7), false, 'late page result cannot cross transport replacement');
  world.ports[0].onMessage.emit({ id: 'health:1', method: 'bridge.health', result: { connected: true } });
  assert.equal(world.ports[1].disconnected, false, 'stale old health reply cannot affect current connection');
  brokerHealthy = true;
  await clock.tick(10000); await clock.tick(500); await flush();
  assert.ok(world.ports.length >= 3);
  assert.equal(world.reloads(), 0);
  assert.ok(isRecord(saved.value) && isRecord(saved.value.lastSelfHeal));
  assert.equal(saved.value.lastSelfHeal.reason, 'broker-unresponsive');
  pass('actual worker watchdog replaces a live-host/stalled-broker port and never replays or leaks a late action');

  const port = world.ports.at(-1)!;
  port.onMessage.emit({ id: 50, method: 'chrome.selfReload', params: {} }); await flush();
  const response = port.sent.find(message => message.id === 50);
  assert.ok(isRecord(response?.result) && response.result.scheduled === true);
  assert.equal(world.reloads(), 0);
  await clock.tick(250); assert.equal(world.reloads(), 1);
  const afterRestart = worker({ clock, saved }); await flush();
  afterRestart.ports[0].onMessage.emit({ id: 51, method: 'chrome.selfReload', params: {} }); await flush();
  assert.ok(isRecord(afterRestart.ports[0].sent.find(message => message.id === 51)?.result));
  await clock.tick(250); assert.equal(afterRestart.reloads(), 0);
  pass('broker self-reload request is acknowledged before reload and cannot bypass a fresh worker cooldown');
}
{
  const clock = new Clock(), saved: { value?: unknown } = {};
  const world = worker({ clock, saved, unavailable: true }); await flush();
  await clock.tick(4000);
  assert.equal(world.reloads(), 1, 'synchronous native host failure escalates after bounded backoff');
  const replacement = worker({ clock, saved, unavailable: true }); await flush();
  await clock.tick(1000); assert.equal(replacement.reloads(), 0);
  pass('connectNative exceptions retain bounded retries and cannot restart into a reload loop');
}
{
  const clock = new Clock(), saved: { value?: unknown } = {};
  const world = worker({ clock, saved, healthResponse: () => false }); await flush();
  const port = world.ports[0], probe = port.sent[0];
  // A suspended worker can deliver a message before its overdue timer callback.
  clock.now += 10000;
  port.onMessage.emit({ id: probe.id, method: 'bridge.health', result: { connected: true } }); await flush();
  assert.equal(port.disconnected, true, 'a result delivered at its deadline cannot certify a stale broker roundtrip');
  port.onMessage.emit({ id: 60, method: 'chrome.selfReload', params: {} }); await flush();
  await clock.tick(250); assert.equal(world.reloads(), 0, 'replaced port cannot request a worker reload');
  pass('overdue health replies and self-reload commands from replaced ports cannot bypass transport ownership');
}
{
  const clock = new Clock(), saved: { value?: unknown } = {};
  let releaseRead: ((value: unknown) => void) | undefined;
  const world = worker({ clock, saved, read: () => new Promise(resolve => { releaseRead = resolve; }) });
  const port = world.ports[0];
  port.onMessage.emit({ id: 70, method: 'chrome.selfReload', params: {}, deadline: clock.now + 100 }); await flush();
  clock.now += 100; assert.ok(releaseRead); releaseRead(undefined); await flush();
  const response = port.sent.find(message => message.id === 70);
  assert.match(response?.error?.message ?? '', /deadline expired/);
  await clock.tick(250); assert.equal(world.reloads(), 0);
  assert.equal(saved.value, undefined, 'expired initial-read request never reserves a reload allowance');
  pass('actual native self-reload waits for initial storage read and rejects an expired request with an error reply');
}
{
  const clock = new Clock(), saved: { value?: unknown } = {};
  const world = worker({ clock, saved }); await flush();
  const port = world.ports[0];
  port.onMessage.emit({ id: 71, method: 'chrome.selfReload', params: {}, deadline: clock.now + 1000 }); await flush();
  assert.ok(isRecord(port.sent.find(message => message.id === 71)?.result));
  port.disconnect(); await flush();
  await clock.tick(250); assert.equal(world.reloads(), 0, 'replaced native port cancels already-scheduled manual reload');
  pass('delayed broker-requested reload rechecks native transport ownership before runtime.reload');
}

class BrokerSocket extends EventEmitter {
  destroyed = false; mode: 'normal' | 'throw' | 'callback' = 'normal';
  writes: string[] = [];
  write(data: string, callback?: (error?: Error) => void) {
    if (this.mode === 'throw') throw new Error('write failed');
    this.writes.push(data);
    if (this.mode === 'callback') callback?.(new Error('write failed'));
    return true;
  }
  destroy() { this.destroyed = true; this.emit('close'); }
  socket() { return this as unknown as Socket; }
}
{
  const bridge = createBridge(), peer = new BrokerSocket(); bridge.attach(peer.socket(), 'chrome');
  const at = Date.now();
  const metadata = { at, reason: 'native-disconnect', action: 'reload', privatePage: 'must-not-survive' };
  assert.deepEqual(bridge.health(peer.socket(), { lastSelfHeal: metadata }).lastSelfHeal, { at, reason: 'native-disconnect', action: 'reload' });
  assert.equal(JSON.stringify(bridge.status()).includes('must-not-survive'), false);
  const old = bridge.request('chrome.click', {}, peer.socket());
  const rejected = assert.rejects(old, /replaced/);
  const fresh = new BrokerSocket(); bridge.attach(fresh.socket(), 'chrome'); await rejected;
  assert.throws(() => bridge.health(peer.socket(), { lastSelfHeal: metadata }), /replaced or disconnected/);
  assert.equal(bridge.health(fresh.socket(), { lastSelfHeal: { ...metadata, at: Date.now() + 120000 } }).lastSelfHeal?.at, at);
  pass('broker status retains only validated self-heal metadata and rejects replaced transport health');
  for (const mode of ['throw', 'callback'] as const) {
    const broken = new BrokerSocket(); broken.mode = mode; bridge.attach(broken.socket(), 'chrome');
    await assert.rejects(bridge.request('chrome.tabs', {}, broken.socket()), /write failed/);
    assert.equal(bridge.status().connected, false); assert.equal(broken.destroyed, true);
  }
  pass('synchronous and asynchronous broker write failures reject pending requests and destroy unusable transports');
}
console.log(`== bridge recovery: ${passed} passed`);
