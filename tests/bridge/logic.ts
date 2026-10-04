import type { ChromeParams, Reply, WireError } from '../../shared/protocol.ts';
import { isRecord, waitParams, versionParam, hasErrorCode } from '../../shared/protocol.ts';
import type { PageResult } from '../../extension/content.ts';
import type { ChromeResults, FixtureTab } from './extension-types.ts';

type FixtureGroup = { id: number; windowId: number; title?: string; color?: string; collapsed?: boolean };
type FixtureTabRecord = FixtureTab & { groupId?: number; status?: string; pendingUrl?: string };
type Frame = { id: string; loaderId: string; url: string };
type Query = { active?: boolean; windowId?: number; lastFocusedWindow?: boolean };
type GroupOptions = { tabIds: number[]; groupId?: number; createProperties?: { windowId: number } };
type ScriptOptions = { args: [string, ChromeParams]; target: { tabId: number }; injectImmediately: boolean; world: string };
interface CommandParams {
  url?: string; entryId?: number; expression?: string; type?: string; width?: number; height?: number;
  mobile?: boolean; deviceScaleFactor?: number; format?: string; quality?: number;
  captureBeyondViewport?: boolean; clip?: { x: number; y: number; width: number; height: number; scale: number };
  key?: string; text?: string; windowsVirtualKeyCode?: number; modifiers?: number;
  features?: { name: string; value: string }[]; media?: string; state?: string; enabled?: boolean;
}
type Call = ['query', 'groups' | Query] | ['window.update' | 'update', number, Partial<FixtureTabRecord> & { focused?: boolean; drawAttention?: boolean }]
  | ['alarm', string, { periodInMinutes: number }] | ['remove', number] | ['group', GroupOptions]
  | ['move', number | number[], { windowId: number; index: number }] | ['create', Partial<FixtureTabRecord>]
  | ['executeScript', ScriptOptions] | ['attach' | 'detach', { tabId: number }]
  | ['command', string, CommandParams];
const isCommand = (call: Call): call is Extract<Call, ['command', ...unknown[]]> => call[0] === 'command';
const isScript = (call: Call): call is Extract<Call, ['executeScript', ...unknown[]]> => call[0] === 'executeScript';
type TestTimer = { fn: () => void; delay: number; cleared?: boolean };
interface CDPResult {
  data?: string; currentIndex?: number; entries?: { id: number; url: string }[];
  cssContentSize?: { x: number; y: number; width: number; height: number };
  result?: { value?: unknown }; exceptionDetails?: { text: string };
}
type FixturePageResult = PageResult | ((action: string, params: ChromeParams) => PageResult | Promise<PageResult>);
interface FixtureNode {
  tagName: string; type?: string; isConnected: boolean; labels: { textContent: string }[];
  childNodes: { nodeType: number; textContent: string }[]; tabIndex: number;
  getAttribute(name: string): string | null; hasAttribute(name: string): boolean;
  closest(selector: string): FixtureNode | FixtureForm | null; matches(selector: string): boolean;
  getRootNode(): FixtureDocument; getClientRects(): object[]; scrollIntoView(): void; focus(): void;
  form?: FixtureForm | null; shadowRoot?: { querySelectorAll(): { type: string }[] } | null;
  contentDocument?: { querySelectorAll(): { type: string }[] } | null;
  options?: { value: string; disabled?: boolean; parentElement?: { disabled: boolean } }[];
  parentElement?: FixtureNode;
  dispatchEvent?: (event: Event) => void; value?: string; contains?: (el: unknown) => boolean;
  getBoundingClientRect?: () => { left: number; right: number; top: number; bottom: number };
}
interface FixtureForm { elements: FixtureNode[] }
interface FixtureDocument {
  activeElement: FixtureNode | { tagName: string } | null;
  body: { innerText: string; textContent: string }; getElementsByTagName(selector: string): FixtureNode[]; querySelectorAll(selector: string): FixtureNode[];
  documentElement?: { scrollHeight?: number; cloneNode(deep: boolean): { querySelectorAll(): object[]; outerHTML: string } };
  elementFromPoint?: () => FixtureNode;
  addEventListener(type: string, listener: (event: Event) => void, capture: boolean): void;
}
// Node-only checks. API doubles verify worker control flow and local guards;
// extension.test.sh is still required to prove browser behavior and trusted input.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { versionLogic } from './version-logic.ts';
import { pageTask } from '../../extension/content.ts';
import { waitFor } from './fake-daemon.ts';
import { createRecovery, RECOVERY_KEY } from '../../extension/recovery.ts';
import { manageExtensions } from '../../extension/extensions.ts';

let passed = 0;
const pass = (label: string) => { passed++; console.log(`PASS ${label}`); };
const event = <Args extends unknown[] = []>() => ({ listeners: [] as ((...args: Args) => void)[], addListener(fn: (...args: Args) => void) { this.listeners.push(fn); },
  removeListener(fn: (...args: Args) => void) { this.listeners = this.listeners.filter(listener => listener !== fn); },
  emit(...args: Args) { for (const fn of [...this.listeners]) fn(...args); },
});
type PortMessage = { id: number | string; method: string; params: object; deadline?: number; result?: unknown };
type Port = { name: string; onMessage: ReturnType<typeof event<[PortMessage]>>; onDisconnect: ReturnType<typeof event>; postMessage(message: Reply & { method?: string }): void; disconnect(): void };
const ports: Port[] = [], calls: Call[] = [], timers: TestTimer[] = [], replies = new Map<Reply['id'], Reply>();
let pageResult: FixturePageResult = {}, failCommand: boolean | undefined, cdpResult: CDPResult = { data: "test-png" };
const groups = new Map<number, FixtureGroup>();
let nextGroup = 0, failGrouping = false;
let createdId = 42;
const tab: FixtureTabRecord = { id: 42, windowId: 1, index: 0, active: true, title: 'Fixture', url: 'http://127.0.0.1/' };
const tabRecords = new Map([[42, { ...tab }]]);
const frameRecords = new Map<number, Frame>();
let navigationMode = 'complete', loaderNumber = 0;
function completeNavigation(id: number, url: string, { old = false, redirected = false, ready = true } = {}) {
  const frame = { id: `frame:${id}`, loaderId: old ? `old:${id}` : `loader:${++loaderNumber}`, url };
  frameRecords.set(id, frame);
  Object.assign(tabRecords.get(id)!, { url, status: 'complete' });
  chrome.debugger.onEvent.emit({ tabId: id }, 'Page.frameNavigated', { frame });
  if (ready) chrome.debugger.onEvent.emit({ tabId: id }, 'Page.lifecycleEvent', { frameId: frame.id, loaderId: frame.loaderId, name: 'DOMContentLoaded' });
  return frame;
}
const chrome = {
  storage: { local: { async get(_key: string) { return {}; }, async set(_value: object) {} } },
  tabGroups: {
    async query(query: Query = {}) { calls.push(['query', 'groups']); return [...groups.values()].filter(group => query.windowId === undefined || group.windowId === query.windowId); },
    async get(id: number) { return groups.get(id)!; },
    async update(id: number, options: Partial<FixtureGroup>) { Object.assign(groups.get(id)!, options); },
  },
  windows: { async update(id: number, options: Partial<FixtureTabRecord> & { focused?: boolean; drawAttention?: boolean }) { calls.push(['window.update', id, options]); return { id, ...options }; } },
  bookmarks: { async getTree() { return [{ title: '', children: [{ title: 'Bar', children: [
    { title: 'Design', children: [{ title: 'Example', url: 'https://example.com/' }] },
    { title: 'Other', url: 'https://other.test/' },
  ] }] }]; } },
  runtime: { onStartup: event(), onInstalled: event(), reload() {}, connectNative(name: string) {
    const port: Port = { name, onMessage: event<[PortMessage]>(), onDisconnect: event(), disconnect() { port.onDisconnect.emit(); }, postMessage(message) {
      if (message.method === 'bridge.health') {
        queueMicrotask(() => port.onMessage.emit({ id: String(message.id), method: 'bridge.health', params: {}, result: { connected: true } }));
      } else replies.set(message.id, message);
    } };
    ports.push(port); return port;
  } },
  alarms: { onAlarm: event(), create(name: string, options: { periodInMinutes: number }) { calls.push(['alarm', name, options]); } },
  tabs: { onUpdated: event<[number, { status: string }]>(), onRemoved: event<[number]>(), async remove(id: number) { calls.push(['remove', id]); if (!tabRecords.has(id)) throw new Error(`No tab with id: ${id}`); tabRecords.delete(id); this.onRemoved.emit(id); },
    async group({ tabIds, groupId, createProperties }: GroupOptions) {
      calls.push(['group', { tabIds, groupId, createProperties }]);
      if (failGrouping) throw new Error('Synthetic grouping failure');
      groupId ??= ++nextGroup;
      if (!groups.has(groupId)) groups.set(groupId, { id: groupId, windowId: createProperties?.windowId ?? tabRecords.get(tabIds[0])!.windowId });
      for (const id of tabIds) tabRecords.get(id)!.groupId = groupId;
      return groupId;
    },
    async query(query: Query) { calls.push(['query', query]); return [...tabRecords.values()].filter(tab => (!query.active || tab.active) && (query.windowId === undefined || tab.windowId === query.windowId)); },
    async get(id: number) { const tab = tabRecords.get(id)!; if (!tab) throw new Error(`No tab with id: ${id}`); return { ...tab }; },
    async update(id: number, options: Partial<FixtureTabRecord> & { focused?: boolean; drawAttention?: boolean }) { calls.push(['update', id, options]); Object.assign(tabRecords.get(id)!, options); return { ...tabRecords.get(id)! }; },
    async move(ids: number | number[], options: { windowId: number; index: number }) { calls.push(['move', ids, options]); return [ids].flat().map(id => { Object.assign(tabRecords.get(id)!, options); return { ...tabRecords.get(id)! }; }); },
    async create(options: Partial<FixtureTabRecord>) { calls.push(['create', options]); const created = { ...tab, id: ++createdId, ...options }; tabRecords.set(created.id, created); return created; } },
  scripting: { async executeScript(options: ScriptOptions) {
    calls.push(['executeScript', options]);
    return [{ result: typeof pageResult === 'function' ? await pageResult(...options.args) : pageResult }];
  } },
  // Self-detach is silent. onDetach is browser-initiated termination:
  // https://developer.chrome.com/docs/extensions/reference/api/debugger#event-onDetach
  debugger: { onEvent: event<[{ tabId: number }, string, object]>(), onDetach: event<[{ tabId: number }, string?]>(), async attach(target: { tabId: number }) { calls.push(['attach', target]); }, async detach(target: { tabId: number }) { calls.push(['detach', target]); },
    async sendCommand(target: { tabId: number }, method: string, params: CommandParams) { calls.push(['command', method, params]); if (failCommand) throw new Error('CDP failure');
      if (method === 'Page.getLayoutMetrics') return { cssContentSize: { x: 0, y: 0, width: 900, height: 2400 }, cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 900, clientHeight: 700 } };
      if (method === 'Runtime.evaluate' && params.expression === 'window.devicePixelRatio') return { result: { value: 2 } };
      if (method === 'Page.getFrameTree') return { frameTree: { frame: frameRecords.get(target.tabId) || { id: `frame:${target.tabId}`, loaderId: `old:${target.tabId}`, url: tabRecords.get(target.tabId)!.url } } };
      if (method === 'Page.navigate' || method === 'Page.navigateToHistoryEntry') {
        const url = params.url || cdpResult.entries!.find(entry => entry.id === params.entryId)!.url;
        if (navigationMode === 'same-document') {
          chrome.debugger.onEvent.emit({ tabId: target.tabId }, 'Page.navigatedWithinDocument', { frameId: `frame:${target.tabId}`, url });
          tabRecords.get(target.tabId)!.url = url;
          return {};
        }
        if (navigationMode === 'download') return { isDownload: true };
        if (navigationMode === 'throw') throw new Error('Navigation command rejected');
        if (navigationMode === 'bfcache') {
          const frame = { id: `frame:${target.tabId}`, loaderId: 'cached-document', url };
          frameRecords.set(target.tabId, frame);
          tabRecords.get(target.tabId)!.url = url;
          chrome.debugger.onEvent.emit({ tabId: target.tabId }, 'Page.frameNavigated', { frame, type: 'BackForwardCacheRestore' });
          return {};
        }
        if (navigationMode === 'early-takeover') {
          const targetFrame = completeNavigation(target.tabId, url);
          completeNavigation(target.tabId, 'http://127.0.0.1/user-took-over-before-reply');
          return { loaderId: targetFrame.loaderId };
        }
        if (['spa-redirect', 'early-spa-redirect', 'script-redirect', 'cross-origin-route', 'fragment-takeover', 'user-then-script'].includes(navigationMode)) {
          const frame = completeNavigation(target.tabId, url, { ready: navigationMode !== 'early-spa-redirect' });
          const finalURL = navigationMode === 'cross-origin-route' ? 'https://other.test/settings' : 'http://127.0.0.1/#settings/Apps';
          if (navigationMode === 'user-then-script') {
            chrome.debugger.onEvent.emit({ tabId: target.tabId }, 'Page.frameRequestedNavigation', { frameId: frame.id, url: `${url}/user`, reason: 'anchorClick' });
            completeNavigation(target.tabId, `${url}/user`);
            chrome.debugger.onEvent.emit({ tabId: target.tabId }, 'Page.frameRequestedNavigation', { frameId: frame.id, url: finalURL, reason: 'scriptInitiated' });
            completeNavigation(target.tabId, finalURL);
          } else if (navigationMode === 'script-redirect') {
            chrome.debugger.onEvent.emit({ tabId: target.tabId }, 'Page.frameRequestedNavigation', { frameId: frame.id, url: finalURL, reason: 'scriptInitiated' });
            completeNavigation(target.tabId, finalURL);
          } else {
            if (navigationMode === 'fragment-takeover') chrome.debugger.onEvent.emit({ tabId: target.tabId }, 'Page.frameRequestedNavigation', { frameId: frame.id, url: finalURL, reason: 'anchorClick' });
            chrome.debugger.onEvent.emit({ tabId: target.tabId }, 'Page.navigatedWithinDocument', { frameId: frame.id, url: finalURL, navigationType: navigationMode === 'fragment-takeover' ? 'fragment' : 'historyApi' });
            tabRecords.get(target.tabId)!.url = finalURL;
          }
          if (navigationMode === 'early-spa-redirect') chrome.debugger.onEvent.emit({ tabId: target.tabId }, 'Page.lifecycleEvent', { frameId: frame.id, loaderId: frame.loaderId, name: 'DOMContentLoaded' });
          return { loaderId: frame.loaderId };
        }
        if (navigationMode === 'error') return { errorText: 'net::ERR_CONNECTION_REFUSED' };
        if (navigationMode === 'manual') return { loaderId: 'manual-loader' };
        const frame = completeNavigation(target.tabId, url);
        return method === 'Page.navigate' ? { loaderId: frame.loaderId } : {};
      }
      return cdpResult; } },
};
// Exercise current sources (including disposable mutants), never a stale dist build.
const source = stripTypeScriptTypes(fs.readFileSync(new URL('../../extension/bg.ts', import.meta.url), 'utf8')).replace(/^import .*;$/gm, '');
function worker() {
  const context = vm.createContext({ chrome, pageTask, waitParams, versionParam, hasErrorCode, isRecord, createRecovery, RECOVERY_KEY, manageExtensions, URL, setTimeout(fn: () => void, delay: number) { timers.push({ fn, delay }); return timers.length; }, clearTimeout(id: number) { if (timers[id - 1]) timers[id - 1].cleared = true; } });
  vm.runInContext(source, context);
  return context;
}
const world = worker();
let serial = 0;
async function request<M extends keyof ChromeResults>(method: M, params?: object): Promise<Reply<ChromeResults[M]>>;
async function request(method: string, params?: object): Promise<Reply<Record<string, unknown>>>;
async function request(method: string, params: object = {}): Promise<Reply<unknown>> {
  const id = ++serial;
  ports.at(-1)!.onMessage.listeners[0]({ id, method, params });
  const response = await waitFor(() => replies.get(id), `worker ${method}`);
  replies.delete(id);
  const copy: unknown = JSON.parse(JSON.stringify(response));
  assert.ok(isRecord(copy) && typeof copy.id === 'number');
  if (copy.error !== undefined) assert.ok(isRecord(copy.error) && typeof copy.error!.message === 'string');
  return { id: copy.id, result: copy.result!, ...(copy.error ? { error: { message: String(copy.error.message),
    ...(typeof copy.error.code === 'string' ? { code: copy.error.code } : {}) } } : {}) };
}

assert.equal(ports[0].name, 'com.abcastor.gaddi.bridge');
assert.ok(calls.some(([kind, name, options]) => kind === 'alarm' && name === 'bridge-keepalive' && options.periodInMinutes === 0.5));
pass('worker opens only the named native port and creates a keepalive alarm');

const beforeExpiredDelivery = calls.length;
const expiredDeliveryId = ++serial;
ports.at(-1)!.onMessage.emit({ id: expiredDeliveryId, method: 'chrome.close', params: { tabs: [42] }, deadline: Date.now() - 1 });
const expiredDelivery = await waitFor(() => replies.get(expiredDeliveryId), 'already expired delivery');
assert.match(expiredDelivery.error?.message || '', /within 25 seconds/, 'ASSERT_EXPIRED_DELIVERY');
assert.equal(calls.length, beforeExpiredDelivery, 'expired native delivery cannot invoke any Chrome API');
replies.delete(expiredDeliveryId);
pass('request delivered after its absolute deadline fails before any Chrome API or action');

const realGet = chrome.tabs.get;
let releaseLookup: (() => void) | undefined;
chrome.tabs.get = async id => {
  const result = await realGet(id);
  return new Promise(resolve => { releaseLookup = () => resolve(result); });
};
const delayedLookupId = ++serial, lookupDeadline = Date.now() + 25000;
const realNow: () => number = vm.runInContext('Date.now', world);
ports.at(-1)!.onMessage.emit({ id: delayedLookupId, method: 'chrome.click', params: { tab: 42 }, deadline: lookupDeadline });
await waitFor(() => releaseLookup, 'lookup entered before expiry');
const beforeDelayedContinuation = calls.length;
// No timer is fired. This models Chrome resuming an API continuation before it
// delivers an overdue timer callback after a worker pause.
vm.runInContext(`Date.now = () => ${lookupDeadline + 1}`, world);
releaseLookup!();
const delayedLookup = await waitFor(() => replies.get(delayedLookupId), 'late continuation checks absolute expiry');
assert.match(delayedLookup.error?.message || '', /within 25 seconds/, 'ASSERT_DELAYED_TIMER');
assert.equal(calls.length, beforeDelayedContinuation, 'late lookup cannot inject, attach or click before the timer fires');
vm.runInContext('Date', world).now = realNow;
chrome.tabs.get = realGet;
replies.delete(delayedLookupId);
pass('late API continuation checks the clock even when the deadline timer has not run');

assert.deepEqual((await request('chrome.tabs')).result!.tabs, [{ ...tab }]);
assert.deepEqual((await request('chrome.active')).result!, { ...tab });
for (const url of ['chrome://extensions', 'chrome-extension://fixture/page.html', 'edge://settings',
  'about:blank', 'view-source:https://example.com/', 'file:///tmp/fixture.html',
  'https://chromewebstore.google.com/detail/fixture', 'https://chrome.google.com/webstore/detail/fixture']) {
  tabRecords.get(42)!.url = url;
  const before = calls.length;
  assert.equal((await request('chrome.tabs')).result!.tabs[0].url, url);
  assert.deepEqual((await request('chrome.read')).result!, { tab: 42, url, title: tab.title,
    text: '', outline: '', note: "Chrome's own page: not readable; pick another tab" });
  for (const action of ['describe', 'html', 'screenshot', 'click', 'type', 'eval', 'press', 'hover',
    'scroll', 'select', 'goto', 'back', 'emulate']) {
    assert.equal((await request(`chrome.${action}`, { tab: 42 })).error!.message, "Chrome's own pages cannot be driven");
  }
  assert.ok(calls.slice(before).every(([kind]) => kind === 'query'), 'restricted tabs must not invoke scripting, debugger or tab mutations');
}
tabRecords.get(42)!.url = tab.url;
pass('restricted tabs remain listed, read as a note, and deny actions without browser calls');
for (const url of ['https://chrome.google.com/webstore-other', 'https://chromewebstore.google.com.example.org/']) {
  tabRecords.get(42)!.url = url;
  const before = calls.length;
  await request('chrome.read');
  assert.ok(calls.slice(before).some(([kind]) => kind === 'executeScript'));
}
tabRecords.get(42)!.url = tab.url;
pass('ordinary URLs resembling Web Store addresses remain readable');
await request('chrome.goto', { tab: 42, url: 'http://127.0.0.1/next' });
assert.ok(calls.some(([kind, method, params]) => kind === 'command' && method === 'Page.navigate' && params.url === 'http://127.0.0.1/next'));
assert.ok(!calls.some(([kind]) => kind === 'update'));
assert.equal((await request('chrome.open', { url: tab.url })).result!.active, false);
assert.equal((await request('chrome.open', { url: tab.url, active: true })).result!.active, false);
assert.match((await request('chrome.goto', { tab: 42, url: 'javascript:alert(1)' })).error!.message, /http/);
assert.equal((await request('chrome.open', { url: tab.url, foreground: true })).result!.active, true);
assert.match((await request('chrome.close', { tab: 42 })).error!.message, /tabs/);
pass('tab dispatch keeps goto free of activation and defaults open to background');

pageResult = { __gaddiError: 'Refusing to type into a password field' };
const beforeCommands = calls.filter(isCommand).length;
assert.match((await request('chrome.type', { tab: 42, selector: '#password', text: 'synthetic' })).error!.message, /password/);
assert.equal(calls.filter(isCommand).length, beforeCommands);
pass('serialized password errors propagate without dispatching input');

pageResult = { selector: '@stable:1', signature: 'before', x: 10, y: 20 };
await request('chrome.type', { tab: 42, selector: '#text', text: 'hello' });
const commands = calls.filter(isCommand);
assert.deepEqual(JSON.parse(JSON.stringify(commands.at(-1)!)), ['command', 'Input.insertText', { text: 'hello' }]);
const scripts = calls.filter(isScript).map(([, opts]) => opts);
assert.equal(scripts.at(-3)!.args[0], 'typeFocus');
assert.equal(scripts.at(-2)!.args[0], 'typeCheck');
assert.equal(scripts.at(-1)!.args[0], 'settle');
assert.ok(scripts.every(options => options.world === 'ISOLATED' && options.target.tabId === 42));
assert.ok(scripts.every(options => options.injectImmediately === true));
assert.equal(calls.at(-1)![0], 'detach');
pass('typing checks focus again inside the debugger session and detaches');

for (const failedInsert of [false, true]) {
  const start = calls.length;
  pageResult = action => {
    if (action === 'typeCheck' && failedInsert) failCommand = true;
    if (action === 'typeCleanup') failCommand = false;
    return { selector: '@stable:1', signature: 'before', appendCleanup: 'append:1' };
  };
  const reply = await request('chrome.type', { tab: 42, selector: '#composer', text: ' wake up', mode: 'append' });
  assert.equal(reply.error?.message, failedInsert ? 'CDP failure' : undefined, 'ASSERT_APPEND_LAYOUT_CLEANUP');
  assert.deepEqual(calls.slice(start).filter(isScript).map(([, options]) => options.args[0]),
    ['typeFocus', 'typeCheck', 'typeCleanup', ...(failedInsert ? [] : ['settle'])], 'ASSERT_APPEND_LAYOUT_CLEANUP: restore layout before settling, including failed insertion');
}
pageResult = { selector: '@stable:1', signature: 'before', x: 10, y: 20 };
pass('ASSERT_APPEND_LAYOUT_CLEANUP');

failCommand = true;
assert.match((await request('chrome.screenshot', { tab: 42 })).error!.message, /CDP failure/);
assert.equal(calls.at(-1)![0], 'detach');
failCommand = false;
const before = calls.length;
await Promise.all([request('chrome.click', { tab: 42, selector: '#pay' }), request('chrome.screenshot', { tab: 42 })]);
assert.deepEqual(calls.slice(before).filter(([kind]) => kind === 'attach' || kind === 'detach').map(([kind]) => kind), ['attach', 'detach', 'attach', 'detach']);
pass('debugger detaches on error and same-tab actions serialize');

await request('chrome.press', { tab: 42, key: 'Control+Enter' });
const keys = calls.filter(isCommand).filter(([, method]) => method === 'Input.dispatchKeyEvent');
assert.equal(keys[0][2].key, 'Enter');
assert.equal(keys[0][2].modifiers, 2);
assert.equal(keys[0][2].type, 'keyDown');
assert.equal(keys[1][2].type, 'keyUp');
pass('press dispatches paired key events with modifier bits');
if (!process.argv.includes('--nav-only')) {
  const marker = calls.length;
  pageResult = { selector: '@stable:1', signature: 'before', appendNeedsEnd: true, expectedText: 'user@example.test' };
  assert.equal((await request('chrome.type', { tab: 42, selector: '#email', text: '@example.test', mode: 'append' })).error, undefined, 'ASSERT_APPEND_NATIVE_KEYS');
  const input = calls.slice(marker).filter(isCommand).filter(([, method]) => method.startsWith('Input.'));
  assert.deepEqual(input.map(([, method, params]) => [method, params.type, params.key, params.text]), [
    ['Input.dispatchKeyEvent', 'keyDown', 'End', undefined], ['Input.dispatchKeyEvent', 'keyUp', 'End', undefined],
    ['Input.insertText', undefined, undefined, '@example.test'],
  ], 'ASSERT_APPEND_NATIVE_KEYS');
  assert.equal(calls.slice(marker).filter(isScript).filter(([, options]) => options.args[0] === 'typeCheck').length, 2, 'ASSERT_APPEND_NATIVE_KEYS');
  assert.ok(calls.slice(marker).filter(isScript).filter(([, options]) => options.args[0] === 'typeCheck')
    .every(([, options]) => options.args[1].mode === 'append'), 'ASSERT_APPEND_NATIVE_KEYS: rechecks retain append mode');
  const invalid = await request('chrome.type', { tab: 42, selector: '#email', text: 'text', mode: 'bad' });
  assert.match(invalid.error!.message, /mode/, 'ASSERT_APPEND_NATIVE_KEYS');
  pass('ASSERT_APPEND_NATIVE_KEYS');
  pageResult = { selector: '@stable:1', signature: 'before', x: 10, y: 20 };
}

ports.at(-1)!.onDisconnect.listeners[0]();
assert.equal(timers.at(-1)!.delay, 250);
vm.runInContext('nextConnect = 0', world);
timers.at(-1)!.fn();
assert.equal(ports.length, 2);
ports.at(-1)!.onDisconnect.listeners[0]();
assert.equal(timers.at(-1)!.delay, 500);
pass('native-port reconnect uses increasing backoff');

worker();
const opened = (await request('chrome.open', { url: tab.url })).result!;
assert.ok(!Object.hasOwn(opened, 'owned'));
const activeWorld = worker(); // The same IDs remain controllable after a fresh worker starts.
assert.deepEqual((await request('chrome.close', { tabs: [opened.id] })).result!, { closed: [opened.id], failed: [] });
assert.deepEqual((await request('chrome.close', { tabs: [opened.id] })).result!.failed.map(item => item.tab), [opened.id]);
for (const params of [{}, { tab: 42 }, { tabs: [] }, { tabs: null }, { tabs: '42' }, { tabs: [42, -1] },
  { tabs: [1.5] }, { tabs: ['42'] }, { tabs: [Number.MAX_SAFE_INTEGER + 1] }, { tabs: Array(101).fill(42) }]) {
  const before = calls.length;
  assert.match((await request('chrome.close', params)).error!.message, /tabs/, 'ASSERT_EXPLICIT_CLOSE_TABS');
  assert.ok(!calls.slice(before).some(([kind]) => kind === 'remove'), 'invalid close cannot remove any tab');
}
pass('close requires a bounded explicit integer list before any removal');
const humanId = ++nextGroup;
groups.set(humanId, { id: humanId, title: 'Human research', windowId: 1 });
const external = ++createdId, human = ++createdId;
tabRecords.set(external, { ...tab, id: external, active: false });
tabRecords.set(human, { ...tab, id: human, active: false, groupId: humanId });
const mixed = (await request('chrome.close', { tabs: [external, 999999, human, external] })).result!;
assert.deepEqual(mixed.closed, [external, human]);
assert.deepEqual(mixed.failed.map(item => item.tab), [999999]);
assert.match(mixed.failed[0].reason, /No tab/);
assert.equal(calls.filter(([kind, id]) => kind === 'remove' && id === external).length, 1);
for (const url of ['about:blank', 'chrome://extensions', 'chrome-error://chromewebdata/']) {
  const id = ++createdId;
  tabRecords.set(id, { ...tab, id, url, active: false });
  const before = calls.length;
  assert.deepEqual((await request('chrome.close', { tabs: [id] })).result!, { closed: [id], failed: [] });
  assert.ok(!calls.slice(before).some(([kind]) => ['executeScript', 'attach', 'command'].includes(kind)));
}
pass('shared ungrouped and human-group tabs close once; missing IDs fail individually; restricted URLs need no injection');
for (const params of [{}, { tab: null }, { tab: -1 }, { tab: '42' }, { tab: 1.5 }, { tab: Number.MAX_SAFE_INTEGER + 1 }]) {
  const before = calls.length;
  assert.ok((await request('chrome.show', params)).error);
  assert.ok(!calls.slice(before).some(([kind]) => ['update', 'window.update'].includes(kind)));
}
const showMarker = calls.length;
assert.equal((await request('chrome.show', { tab: 42 })).result!.id, 42);
assert.deepEqual(JSON.parse(JSON.stringify(calls.slice(showMarker).filter(([kind]) => ['update', 'window.update'].includes(kind)))),
  [['update', 42, { active: true }], ['window.update', 1, { focused: true, drawAttention: true }]]);
pass('show requires an explicit ID, activates it and focuses its window');
const foreign = ++createdId, nearby = ++createdId;
tabRecords.set(foreign, { ...tab, id: foreign, windowId: 2, active: false });
tabRecords.set(nearby, { ...tab, id: nearby, active: false });
const title = '● Existing tabs · tests';
const organized = (await request('chrome.group', { tabs: [42, foreign, 42], group: title })).result!;
assert.deepEqual(organized.tabs.map(tab => tab.id), [42, foreign]);
assert.ok(organized.tabs.every(tab => tab.windowId === 1 && tab.group === title));
assert.equal(organized.group, title);
assert.equal(groups.get(organized.groupId)!.windowId, 1);
assert.ok(calls.some(([kind, ids, options]) => kind === 'move' && [ids].flat().includes(foreign) && options.windowId === 1));
assert.equal((await request('chrome.group', { tabs: [nearby], group: title })).result!.groupId, organized.groupId);
const otherWindow = ++createdId;
tabRecords.set(otherWindow, { ...tab, id: otherWindow, windowId: 3, active: false });
const sameTitleElsewhere = (await request('chrome.group', { tabs: [otherWindow], group: title })).result!;
assert.equal(sameTitleElsewhere.groupId, organized.groupId);
assert.equal(sameTitleElsewhere.tabs[0].windowId, 1);
const newWindowTab = ++createdId;
tabRecords.set(newWindowTab, { ...tab, id: newWindowTab, windowId: 3, active: false });
const newWindowGroup = (await request('chrome.group', { tabs: [newWindowTab], group: '● New window · tests' })).result!;
assert.equal(groups.get(newWindowGroup.groupId)!.windowId, 3);
for (const params of [{ tabs: [42] }, { tabs: [], group: title }, { tabs: [42], group: null },
  { tabs: [42], group: 'Human' }, { tabs: Array(101).fill(42), group: title }]) {
  const before = calls.length;
  assert.ok((await request('chrome.group', params)).error);
  assert.ok(!calls.slice(before).some(([kind]) => ['group', 'move'].includes(kind)));
}
pass('group uses the first tab window, moves foreign tabs, reuses the exact title and its window and validates before mutations');
const groupLabel = '● Shared · tests';
const paired = await Promise.all([request('chrome.open', { url: tab.url, group: groupLabel }), request('chrome.open', { url: tab.url, group: groupLabel })]);
assert.equal(tabRecords.get(paired[0].result!.id)!.groupId, tabRecords.get(paired[1].result!.id)!.groupId);
const shared = groups.get(tabRecords.get(paired[0].result!.id)!.groupId!)!;
assert.equal(shared.color, 'cyan'); assert.equal(shared.collapsed, true);
shared.windowId = 7;
assert.equal((await request('chrome.open', { url: tab.url, group: groupLabel })).result!.windowId, 7);
failGrouping = true;
assert.match((await request('chrome.open', { url: tab.url })).error!.message, /grouping failure/);
assert.equal(tabRecords.has(createdId), false);
failGrouping = false;
assert.match((await request('chrome.open', { url: tab.url, group: 'Human' })).error!.message, /prefix/);
pass('open reuses labelled groups across windows and removes failed grouping');
const bookmarks = (await request('chrome.bookmarks')).result!.bookmarks;
assert.equal(bookmarks.length, 2);
assert.deepEqual((await request('chrome.bookmarks', { query: 'DESIGN' })).result!.bookmarks, [bookmarks[0]]);
assert.equal(bookmarks[0].path, 'Bar/Design');
assert.equal((await request('chrome.bookmarks', { query: 'EXAMPLE' })).result!.bookmarks.length, 1);
assert.equal((await request('chrome.bookmarks', { query: 'OTHER.TEST' })).result!.bookmarks.length, 1);
pass('bookmarks flatten folders and query paths, titles and URLs without case sensitivity');

pageResult = { x: 10, y: 20 };
let marker = calls.length;
assert.equal((await request('chrome.hover', { tab: 42, selector: '#pay' })).result!.hovered, true);
assert.deepEqual(calls.slice(marker).filter(isCommand).map(([, method, p]) => [method, p.type, p.enabled]),
  [['Emulation.setFocusEmulationEnabled', undefined, true], ['Input.dispatchMouseEvent', 'mouseMoved', undefined]]);
assert.equal((await request('chrome.scroll', { dy: 200 })).result!.scrolled, true);
assert.match((await request('chrome.scroll', { dy: 2, selector: '#pay' })).error!.message, /exactly one/);
assert.match((await request('chrome.scroll', { dy: NaN })).error!.message, /finite/);
pageResult = { scrolled: true };
assert.equal((await request('chrome.scroll', { selector: '#pay' })).result!.scrolled, true);
pageResult = { selected: true };
assert.equal((await request('chrome.select', { selector: '#option', value: 'b' })).result!.selected, true);
cdpResult = { currentIndex: 1, entries: [{ id: 7, url: tab.url }, { id: 8, url: `${tab.url}next` }] };
await request('chrome.back');
assert.ok(calls.some(([kind, method, params]) => kind === 'command' && method === 'Page.navigateToHistoryEntry' && params.entryId === 7));
cdpResult = { currentIndex: 0, entries: [{ id: 8, url: tab.url }] };
assert.match((await request('chrome.back')).error!.message, /No previous/);
pass('hover, both scroll modes, select and back dispatch without tab activation');

cdpResult = { data: 'test-png', cssContentSize: { x: 0, y: 0, width: 900, height: 2400 } };
await request('chrome.screenshot', { fullPage: true });
const shot = calls.filter(isCommand).filter(([, method]) => method === 'Page.captureScreenshot').at(-1)![2];
assert.equal(shot.captureBeyondViewport, true);
assert.deepEqual(JSON.parse(JSON.stringify(shot.clip)), { x: 0, y: 0, width: 900, height: 2400, scale: 1568 / 2400 / 2 });
assert.equal(shot.format, 'jpeg'); assert.equal(shot.quality, 85);
pass('full-page JPEG scales complete CSS bounds below 1568 even on Retina');

marker = calls.length;
await request('chrome.emulate', { width: 400, height: 700, mobile: true, colorScheme: 'dark', animationSpeed: 0.1 });
await request('chrome.screenshot');
await request('chrome.emulate', { colorScheme: 'light' });
assert.equal(calls.slice(marker).filter(([kind]) => kind === 'attach').length, 1);
assert.equal(calls.slice(marker).filter(([kind]) => kind === 'detach').length, 0);
const metrics = calls.filter(isCommand).filter(([, method]) => method === 'Emulation.setDeviceMetricsOverride').at(-1)![2];
assert.equal(metrics.width, 400); assert.equal(metrics.height, 700); assert.equal(metrics.mobile, true);
await request('chrome.emulate', { reset: true });
assert.ok(calls.slice(marker).some(([, method]) => method === 'Emulation.clearDeviceMetricsOverride'));
assert.ok(calls.some(([kind, options]) => kind === 'executeScript' && options.args[0] === 'animationSpeed' && options.args[1].animationSpeed === 0.1));
assert.ok(calls.filter(isScript).at(-1)![1].args[1].reset);
assert.equal(calls.at(-1)![0], 'detach');
for (const animationSpeed of [0, -1, 2, NaN, '0.1']) assert.match((await request('chrome.emulate', { animationSpeed })).error!.message, /animationSpeed/);
assert.match((await request('chrome.emulate', { width: -1 })).error!.message, /width/);
assert.match((await request('chrome.emulate', { colorScheme: 'purple' })).error!.message, /colorScheme/);
pass('emulation retains debugger and merged settings across actions until reset');
await request('chrome.emulate', { width: 450 });
failCommand = true;
assert.match((await request('chrome.emulate', { width: 460 })).error!.message, /CDP failure/);
assert.equal(calls.at(-1)![0], 'detach');
failCommand = false;
marker = calls.length;
await request('chrome.screenshot');
assert.equal(calls.slice(marker).filter(([kind]) => kind === 'attach').length, 1);
pass('failed emulation clears its attachment so partial settings cannot persist');

pageResult = { __gaddiError: 'Refusing evaluation on a page with password fields' };
marker = calls.length;
assert.match((await request('chrome.eval', { expression: 'document.title' })).error!.message, /password/);
assert.equal(calls.slice(marker).filter(([, method]) => method === 'Runtime.evaluate').length, 0);
pageResult = {};
cdpResult = { result: { value: { status: 'local' } } };
assert.deepEqual((await request('chrome.eval', { expression: 'window.fixtureState' })).result!.value, { status: 'local' });
assert.deepEqual((await request('chrome.eval', { expression: 'LMSSetValue("x", "y")' })).result!.value, { status: 'local' });
assert.match((await request('chrome.eval', { expression: 'document.querySelector("input[type=password]").value' })).error!.message, /password/);
cdpResult = { exceptionDetails: { text: 'Synthetic failure' } };
assert.match((await request('chrome.eval', { expression: 'invalidCall()' })).error!.message, /evaluation failed/);
pass('eval checks password DOM before main-world execution and reports exceptions');

// Navigation completion must belong to the requested document, even when
// events arrive before the CDP command reply or the previous document was ready.
const navEvent = (id: number, method: string, details: object) => chrome.debugger.onEvent.emit({ tabId: id }, method, details);
const listenersBefore = chrome.debugger.onEvent.listeners.length;
navigationMode = 'manual';
let navigationSettled = false;
const slowURL = 'http://127.0.0.1/slow';
const pendingNavigation = request('chrome.goto', { tab: 42, url: slowURL }).then(reply => { navigationSettled = true; return reply; });
await waitFor(() => calls.some(([kind, method, params]) => kind === 'command' && method === 'Page.navigate' && params.url === slowURL), 'slow navigation issued');
navEvent(42, 'Page.lifecycleEvent', { frameId: 'frame:42', loaderId: 'old:42', name: 'load' });
await new Promise(resolve => setTimeout(resolve, 10));
assert.equal(navigationSettled, false, 'old complete document must not finish navigation');
const redirectURL = 'http://127.0.0.1/redirected';
navEvent(42, 'Page.frameNavigated', { frame: { id: 'frame:42', loaderId: 'manual-loader', url: redirectURL } });
await new Promise(resolve => setTimeout(resolve, 10));
assert.equal(navigationSettled, false, 'commit alone is not a parsed document');
tabRecords.get(42)!.url = redirectURL;
navEvent(42, 'Page.lifecycleEvent', { frameId: 'frame:42', loaderId: 'manual-loader', name: 'DOMContentLoaded' });
assert.equal((await pendingNavigation).result!.url, redirectURL);
pageResult = { html: '<main>Delayed document complete</main>', truncated: false };
assert.match((await request('chrome.html', { tab: 42 })).result!.html, /Delayed document complete/);
assert.equal(chrome.debugger.onEvent.listeners.length, listenersBefore);
assert.equal(timers.filter(timer => timer.delay === 20000).every(timer => timer.cleared), true);
pass('navigation ignores old completion, waits for parsed redirect document, and removes listeners/timers');

navigationMode = 'same-document';
assert.equal((await request('chrome.goto', { tab: 42, url: `${redirectURL}#section` })).result!.url, `${redirectURL}#section`);
navigationMode = 'bfcache';
cdpResult = { currentIndex: 1, entries: [{ id: 7, url: tab.url }, { id: 8, url: redirectURL }] };
assert.equal((await request('chrome.back', { tab: 42 })).result!.url, tab.url);
pass('same-document navigation and cached history restores settle without new load events');
for (const mode of ['spa-redirect', 'early-spa-redirect', 'script-redirect']) {
  navigationMode = mode;
  const opened = await request('chrome.open', { url: `${tab.url}#settings/Connectors` });
  assert.equal(opened.error, undefined, 'ASSERT_APP_REDIRECT');
  assert.equal(opened.result!.url, `${tab.url}#settings/Apps`, 'ASSERT_APP_REDIRECT');
  assert.equal(tabRecords.has(createdId), true, 'ASSERT_APP_REDIRECT');
}
navigationMode = 'cross-origin-route';
assert.match((await request('chrome.open', { url: `${tab.url}#settings/Connectors` })).error?.message || '', /superseded/, 'ASSERT_APP_REDIRECT_BOUNDARY');
assert.equal(tabRecords.has(createdId), true, 'ASSERT_APP_REDIRECT_BOUNDARY');
pass('ASSERT_APP_REDIRECT');
pass('ASSERT_APP_REDIRECT_BOUNDARY');
navigationMode = 'fragment-takeover';
assert.match((await request('chrome.open', { url: `${tab.url}#settings/Connectors` })).error?.message || '', /superseded/, 'ASSERT_USER_FRAGMENT_TAKEOVER');
assert.equal(tabRecords.has(createdId), true, 'ASSERT_USER_FRAGMENT_TAKEOVER');
pass('ASSERT_USER_FRAGMENT_TAKEOVER');
navigationMode = 'user-then-script';
assert.match((await request('chrome.open', { url: `${tab.url}#settings/Connectors` })).error?.message || '', /superseded/, 'ASSERT_USER_SCRIPT_TAKEOVER');
assert.equal(tabRecords.has(createdId), true, 'ASSERT_USER_SCRIPT_TAKEOVER');
pass('ASSERT_USER_SCRIPT_TAKEOVER');

for (const mode of ['error', 'throw', 'download']) {
  navigationMode = mode;
  const failed = await request('chrome.open', { url: `${tab.url}${mode}` });
  assert.match(failed.error!.message, /Navigation/);
  assert.equal(tabRecords.has(createdId), false, 'failed original open must close its new tab');
  assert.equal(chrome.debugger.onEvent.listeners.length, listenersBefore);
}
navigationMode = 'manual';
const timedURL = `${tab.url}timeout`;
const timedOpen = request('chrome.open', { url: timedURL });
await waitFor(() => calls.some(([kind, method, params]) => kind === 'command' && method === 'Page.navigate' && params.url === timedURL), 'timeout navigation issued');
timers.findLast(timer => timer.delay === 20000 && !timer.cleared)!.fn();
assert.match((await timedOpen).error!.message, /20 seconds/);
assert.equal(tabRecords.has(createdId), false);
assert.equal(chrome.debugger.onEvent.listeners.length, listenersBefore);
pass('failed, download and timed-out opens close only their new tabs and clean navigation listeners');

const takeoverURL = `${tab.url}takeover`;
const takeover = request('chrome.open', { url: takeoverURL });
await waitFor(() => calls.some(([kind, method, params]) => kind === 'command' && method === 'Page.navigate' && params.url === takeoverURL), 'takeover navigation issued');
const takenId = createdId;
navEvent(takenId, 'Page.frameRequestedNavigation', { frameId: `frame:${takenId}`, url: `${tab.url}user-work` });
tabRecords.get(takenId)!.url = `${tab.url}user-work`;
navEvent(takenId, 'Page.frameNavigated', { frame: { id: `frame:${takenId}`, loaderId: 'user-loader', url: `${tab.url}user-work` } });
assert.match((await takeover).error!.message, new RegExp(`tab ${takenId} was preserved`));
assert.equal(tabRecords.has(takenId), true);
assert.equal(chrome.debugger.onEvent.listeners.length, listenersBefore);
assert.equal(timers.filter(timer => timer.delay === 20000).every(timer => timer.cleared), true);
navigationMode = 'early-takeover';
const earlyTakeover = await request('chrome.open', { url: `${tab.url}early-takeover` });
assert.match(earlyTakeover.error!.message, /superseded.*preserved/);
assert.equal(tabRecords.has(createdId), true);
assert.equal(tabRecords.get(createdId)!.url, 'http://127.0.0.1/user-took-over-before-reply');
navigationMode = 'complete';
pass('a superseding user navigation preserves its tab and reports the tab ID instead of closing it');

const recoveryTab = 900000;
tabRecords.set(recoveryTab, { ...tab, id: recoveryTab, frozen: false, discarded: false });
assert.ok(!Object.hasOwn((await request('chrome.tabs')).result!.tabs.find(t => t.id === recoveryTab)!, 'frozen'));
assert.ok(!Object.hasOwn((await request('chrome.tabs')).result!.tabs.find(t => t.id === recoveryTab)!, 'discarded'));
tabRecords.get(recoveryTab)!.frozen = true;
assert.equal((await request('chrome.tabs')).result!.tabs.find(t => t.id === recoveryTab)!.frozen, true);
marker = calls.length;
pageResult = { text: 'awake' };
assert.equal((await request('chrome.read', { tab: recoveryTab })).result!.text, 'awake');
const wakeCalls = calls.slice(marker);
assert.ok(wakeCalls.findIndex(([kind, method, args]) => kind === 'command' && method === 'Page.setWebLifecycleState' && args.state === 'active')
  < wakeCalls.findIndex(([kind]) => kind === 'executeScript'));
assert.ok(wakeCalls.some(([, method]) => method === 'Page.setWebLifecycleState'));
Object.assign(tabRecords.get(recoveryTab)!, { frozen: false, discarded: true });
assert.equal((await request('chrome.tabs')).result!.tabs.find(t => t.id === recoveryTab)!.discarded, true);
marker = calls.length;
for (const action of ['read', 'eval', 'goto', 'screenshot']) {
  assert.match((await request(`chrome.${action}`, { tab: recoveryTab, expression: '1', url: tab.url })).error!.message,
    /Tab 900000 is discarded; reload it explicitly/);
}
assert.ok(!calls.slice(marker).some(([kind]) => ['executeScript', 'attach', 'command', 'update'].includes(kind)));
tabRecords.get(recoveryTab)!.discarded = false;
pass('frozen tabs wake before injection; discarded tabs are named without page work or reload; false flags are omitted');

let releaseRead!: (result: PageResult) => void;
pageResult = () => new Promise(resolve => { releaseRead = resolve; });
const waitingRead = request('chrome.read', { tab: recoveryTab });
await waitFor(() => releaseRead, 'first page request stalls');
const firstDeadline = timers.findLast(timer => timer.delay >= 24000 && timer.delay <= 25000 && !timer.cleared)!;
const queuedType = request('chrome.type', { tab: recoveryTab, selector: '#text', text: 'must not type' });
await waitFor(() => timers.findLast(timer => timer.delay >= 24000 && timer.delay <= 25000 && !timer.cleared)! !== firstDeadline, 'queued deadline armed');
const queuedDeadline = timers.findLast(timer => timer.delay >= 24000 && timer.delay <= 25000 && !timer.cleared)!;
marker = calls.length;
firstDeadline.fn(); queuedDeadline.fn();
assert.match((await waitingRead).error!.message, /within 25 seconds/);
assert.match((await queuedType).error!.message, /within 25 seconds/);
assert.ok(!calls.slice(marker).some(([kind]) => ['executeScript', 'attach', 'command'].includes(kind)));
pageResult = { text: 'queue recovered' };
assert.equal((await request('chrome.read', { tab: recoveryTab })).result!.text, 'queue recovered');
releaseRead({ text: 'late result' });
await new Promise(resolve => setImmediate(resolve));
assert.equal(replies.size, 0, 'late results never produce a second reply');
pass('25-second deadline includes queue wait, skips expired work and releases the queue before the old injection settles');

let releaseClick!: (result: PageResult) => void, releaseEval!: (result: PageResult) => void;
pageResult = action => action === 'settle' ? { signature: 'after', url: tab.url } : new Promise(resolve => {
  if (action === 'clickPoint') releaseClick = resolve;
  if (action === 'evalCheck') releaseEval = resolve;
});
const expiredClick = request('chrome.click', { tab: recoveryTab, selector: '#button' });
await waitFor(() => releaseClick, 'click injection stalls');
timers.findLast(timer => timer.delay >= 24000 && timer.delay <= 25000 && !timer.cleared)!.fn();
assert.match((await expiredClick).error!.message, /within 25 seconds/);
const nextEval = request('chrome.eval', { tab: recoveryTab, expression: '1' });
await waitFor(() => releaseEval, 'successor adopts debugger while expired click is still pending');
marker = calls.length;
releaseClick({ x: 10, y: 20 });
await new Promise(resolve => setImmediate(resolve));
assert.ok(!calls.slice(marker).some(([kind]) => ['detach', 'command'].includes(kind)), 'late click cannot send input or detach its successor');
cdpResult = { result: { value: 1 } };
releaseEval({});
assert.equal((await nextEval).result!.value, 1);
assert.equal(calls.slice(marker).filter(([kind]) => kind === 'detach').length, 1);
pageResult = {};
pass('expired click continuation sends no input and cannot detach the next task debugger');

await request('chrome.emulate', { tab: recoveryTab, width: 400 });
let releaseMotion!: (result: PageResult) => void;
pageResult = (action, params) => params.reset ? {} : new Promise(resolve => { releaseMotion = resolve; });
const expiredEmulation = request('chrome.emulate', { tab: recoveryTab, width: 480, animationSpeed: 0.5 });
await waitFor(() => releaseMotion, 'partial emulation stalls after viewport override');
timers.findLast(timer => timer.delay >= 24000 && timer.delay <= 25000 && !timer.cleared)!.fn();
assert.match((await expiredEmulation).error!.message, /within 25 seconds/);
marker = calls.length;
releaseMotion({});
await new Promise(resolve => setImmediate(resolve));
assert.equal(calls.slice(marker).filter(([kind]) => kind === 'detach').length, 1, 'expired partial emulation clears its retained debugger');
assert.ok(calls.slice(marker).some(([kind, options]) => kind === 'executeScript'
  && options.args[0] === 'animationSpeed' && options.args[1].reset), 'late page-side motion receives a bounded reset task');
pageResult = {};
marker = calls.length;
await request('chrome.screenshot', { tab: recoveryTab });
assert.equal(calls.slice(marker).filter(([kind]) => kind === 'attach').length, 1);
pass('timed-out partial emulation releases CDP overrides and resets late page-side motion on the queue');

const realCreate = chrome.tabs.create;
let releaseCreate: (() => void) | undefined, lateCreated = 0;
chrome.tabs.create = async options => {
  const created = await realCreate(options);
  lateCreated = created.id;
  return new Promise(resolve => { releaseCreate = () => resolve(created); });
};
const lateOpen = request('chrome.open', { url: tab.url });
await waitFor(() => releaseCreate, 'Chrome created tab but withheld its ID');
tabRecords.get(lateCreated)!.url = 'http://127.0.0.1/human-takeover';
timers.findLast(timer => timer.delay <= 25000 && timer.delay >= 24000 && !timer.cleared)!.fn();
assert.match((await lateOpen).error!.message, /inspect the tab before retrying/);
marker = calls.length;
releaseCreate!();
await new Promise(resolve => setImmediate(resolve));
assert.ok(!calls.slice(marker).some(([kind]) => ['create', 'remove', 'group', 'attach', 'command'].includes(kind)),
  'late creation response cannot trigger grouping, navigation, deletion or replay');
assert.equal(tabRecords.get(lateCreated)!.url, 'http://127.0.0.1/human-takeover');
chrome.tabs.create = realCreate;
await request('chrome.close', { tabs: [lateCreated] });
pass('in-flight tab creation may complete after expiry; its late response cannot modify a user takeover');

navigationMode = 'manual';
marker = calls.length;
const partialOpen = request('chrome.open', { url: tab.url });
await waitFor(() => calls.slice(marker).some(call => isCommand(call) && call[1] === 'Page.navigate'), 'open reached navigation');
const partialTab = createdId;
timers.findLast(timer => timer.delay <= 25000 && timer.delay >= 24000 && !timer.cleared)!.fn();
assert.match((await partialOpen).error!.message, new RegExp(`tab ${partialTab} was preserved`), 'ASSERT_PARTIAL_OPEN_ID');
marker = calls.length;
completeNavigation(partialTab, 'http://127.0.0.1/human-takeover');
await new Promise(resolve => setImmediate(resolve));
assert.ok(!calls.slice(marker).some(([kind]) => kind === 'remove'), 'late navigation failure cannot delete a taken-over tab');
assert.ok(tabRecords.has(partialTab));
navigationMode = 'complete';
await request('chrome.close', { tabs: [partialTab] });
pass('open that expires during navigation reports the retained tab ID and preserves later user takeover');

// Tab queues release on expiry; only the groups queue waits for inner work.
// Hold the input's enable reply across its deadline, then let a non-input
// successor adopt that same retained session before the input reaches finally.
const inheritedFocusAssertion = 'ASSERT_DEBUGGER_INHERITED_FOCUS';
pageResult = { x: 10, y: 20 };
cdpResult = { result: { value: 7 } };
assert.equal((await request('chrome.emulate', { tab: recoveryTab, width: 400 })).error, undefined, inheritedFocusAssertion);
const realSendCommand = chrome.debugger.sendCommand;
let releaseFocus!: () => void;
chrome.debugger.sendCommand = async (target, method, params) => {
  const result = await realSendCommand(target, method, params);
  if (method === 'Emulation.setFocusEmulationEnabled' && params.enabled) await new Promise<void>(resolve => { releaseFocus = resolve; });
  return result;
};
const lateFocus = request('chrome.click', { tab: recoveryTab, selector: '#button' });
await waitFor(() => releaseFocus, 'focus enable reply withheld');
// Read state only: the native requests above must establish every precondition.
const inheritedSession: { owner?: object; inputFocus?: boolean; closing?: Promise<void> } | undefined = vm.runInContext(`attached.get(${recoveryTab})`, activeWorld);
assert.ok(inheritedSession, inheritedFocusAssertion);
const inputOwner = inheritedSession.owner;
assert.ok(inputOwner && inheritedSession.inputFocus && !inheritedSession.closing
  && vm.runInContext(`emulations.has(${recoveryTab})`, activeWorld), inheritedFocusAssertion);
timers.findLast(timer => timer.delay >= 24000 && timer.delay <= 25000 && !timer.cleared)!.fn();
assert.match((await lateFocus).error?.message || '', /within 25 seconds/, inheritedFocusAssertion);
assert.ok(inheritedSession.inputFocus && !inheritedSession.closing && inheritedSession.owner === inputOwner, inheritedFocusAssertion);
marker = calls.length;
assert.equal((await request('chrome.eval', { tab: recoveryTab, expression: '7' })).result?.value, 7, inheritedFocusAssertion);
const adoptedCalls = calls.slice(marker);
const inheritedReset = adoptedCalls.findIndex(call => isCommand(call) && call[1] === 'Emulation.setFocusEmulationEnabled' && call[2].enabled === false);
// A reset in the successor's finally is too late: eval must run without focus.
assert.ok(inheritedReset >= 0 && inheritedReset < adoptedCalls.findIndex(call => isCommand(call) && call[1] === 'Runtime.evaluate'), inheritedFocusAssertion);
assert.equal(vm.runInContext(`attached.get(${recoveryTab})`, activeWorld), inheritedSession, inheritedFocusAssertion);
assert.notEqual(inheritedSession.owner, inputOwner, inheritedFocusAssertion);
assert.equal(inheritedSession.inputFocus, false, inheritedFocusAssertion);
assert.ok(!adoptedCalls.some(([kind]) => kind === 'attach' || kind === 'detach'), inheritedFocusAssertion);
marker = calls.length;
releaseFocus();
await new Promise(resolve => setImmediate(resolve));
assert.ok(!calls.slice(marker).some(([kind]) => ['command', 'detach'].includes(kind)), inheritedFocusAssertion);
chrome.debugger.sendCommand = realSendCommand;
pass(inheritedFocusAssertion);

let releaseExpiredPoint!: (result: PageResult) => void, releaseRetainedPress!: (result: PageResult) => void;
pageResult = action => action === 'settle' ? { signature: 'after', url: tab.url } : new Promise(resolve => {
  if (action === 'clickPoint') releaseExpiredPoint = resolve;
  if (action === 'pressCheck') releaseRetainedPress = resolve;
});
const oldRetainedInput = request('chrome.click', { tab: recoveryTab, selector: '#button' });
await waitFor(() => releaseExpiredPoint, 'retained click pauses after enabling focus');
timers.findLast(timer => timer.delay >= 24000 && timer.delay <= 25000 && !timer.cleared)!.fn();
assert.match((await oldRetainedInput).error!.message, /within 25 seconds/);
const retainedSuccessor = request('chrome.press', { tab: recoveryTab, key: 'Enter' });
await waitFor(() => releaseRetainedPress, 'input successor holds inherited retained session');
marker = calls.length;
releaseExpiredPoint({ x: 10, y: 20 });
await new Promise(resolve => setImmediate(resolve));
assert.ok(!calls.slice(marker).some(([kind]) => ['command', 'detach'].includes(kind)),
  'ASSERT_RETAINED_FOCUS_OWNER: expired input cannot clear focus while its input successor is active');
releaseRetainedPress({});
assert.equal((await retainedSuccessor).result!.pressed, true);
pageResult = { x: 10, y: 20 };
pass('expired retained input cannot clear focus from an active input successor');

let releaseFocusReset!: () => void;
chrome.debugger.sendCommand = async (target, method, params) => {
  const result = await realSendCommand(target, method, params);
  if (method === 'Emulation.setFocusEmulationEnabled' && params.enabled === false) await new Promise<void>(resolve => { releaseFocusReset = resolve; });
  return result;
};
const closingInput = request('chrome.click', { tab: recoveryTab, selector: '#button' });
await waitFor(() => releaseFocusReset, 'retained input cleanup pending');
timers.findLast(timer => timer.delay >= 24000 && timer.delay <= 25000 && !timer.cleared)!.fn();
assert.match((await closingInput).error!.message, /within 25 seconds/);
marker = calls.length;
const afterCleanup = request('chrome.eval', { tab: recoveryTab, expression: '7' });
await new Promise(resolve => setImmediate(resolve));
assert.ok(!calls.slice(marker).some(([kind]) => ['executeScript', 'command', 'attach', 'detach'].includes(kind)), 'successor waits for focus cleanup before using the session');
releaseFocusReset();
assert.equal((await afterCleanup).result!.value, 7);
chrome.debugger.sendCommand = realSendCommand;
pass('successor waits for retained focus cleanup even when the input deadline expires during cleanup');

const failedDisableAssertion = 'ASSERT_DEBUGGER_FAILED_DISABLE_CLEANUP';
assert.equal((await request('chrome.emulate', { tab: recoveryTab, animationSpeed: 0.5 })).error, undefined, failedDisableAssertion);
assert.ok(vm.runInContext(`attached.has(${recoveryTab}) && emulations.get(${recoveryTab})?.animationSpeed === 0.5`, activeWorld), failedDisableAssertion);
let selfDetachEvents = 0;
const countSelfDetach = ({ tabId }: { tabId: number }) => { if (tabId === recoveryTab) selfDetachEvents++; };
chrome.debugger.onDetach.addListener(countSelfDetach);
chrome.debugger.sendCommand = async (target, method, params) => {
  const result = await realSendCommand(target, method, params);
  if (method === 'Emulation.setFocusEmulationEnabled' && params.enabled === false) throw new Error('Synthetic focus cleanup failure');
  return result;
};
marker = calls.length;
assert.match((await request('chrome.click', { tab: recoveryTab, selector: '#button' })).error?.message || '', /Synthetic focus cleanup failure/, failedDisableAssertion);
// Drain queued cleanup; an absent reset must fail the named assertion, not time out.
await new Promise(resolve => setImmediate(resolve));
const failedDisableCalls = calls.slice(marker);
assert.deepEqual({
  emulated: vm.runInContext(`emulations.has(${recoveryTab})`, activeWorld),
  attached: vm.runInContext(`attached.has(${recoveryTab})`, activeWorld),
  detaches: failedDisableCalls.filter(call => call[0] === 'detach' && call[1].tabId === recoveryTab).length,
  motionResets: failedDisableCalls.filter(call => isScript(call) && call[1].target.tabId === recoveryTab
    && call[1].args[0] === 'animationSpeed' && call[1].args[1].reset === true).length,
  selfDetachEvents,
}, { emulated: false, attached: false, detaches: 1, motionResets: 1, selfDetachEvents: 0 }, failedDisableAssertion);
chrome.debugger.onDetach.removeListener(countSelfDetach);
chrome.debugger.sendCommand = realSendCommand;
marker = calls.length;
assert.equal((await request('chrome.screenshot', { tab: recoveryTab })).error, undefined, failedDisableAssertion);
assert.equal(calls.slice(marker).filter(([kind]) => kind === 'attach').length, 1, failedDisableAssertion);
assert.equal(calls.slice(marker).filter(([kind]) => kind === 'detach').length, 1, failedDisableAssertion);
pass(failedDisableAssertion);

chrome.debugger.sendCommand = async (target, method, params) => {
  const result = await realSendCommand(target, method, params);
  if (method === 'Emulation.setFocusEmulationEnabled' && params.enabled) pageResult = { __gaddiError: 'Refusing keyboard input into a password field' };
  return result;
};
marker = calls.length;
assert.match((await request('chrome.press', { tab: recoveryTab, key: 'Enter' })).error!.message, /password/);
assert.ok(!calls.slice(marker).some(call => isCommand(call) && call[1].startsWith('Input.')));
chrome.debugger.sendCommand = realSendCommand;
pageResult = {};
pass('press checks password safety after focus emulation and dispatches no keys on refusal');

let movedOverGate = false;
chrome.debugger.sendCommand = async (target, method, params) => {
  const result = await realSendCommand(target, method, params);
  if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseMoved') movedOverGate = true;
  return result;
};
pageResult = action => action === 'clickPoint' && movedOverGate
  ? { __gaddiError: 'Element changed since it was checked; look again' } : { signature: 'before', x: 10, y: 20 };
marker = calls.length;
assert.match((await request('chrome.click', { tab: recoveryTab, selector: '#button', checkedDescription: { name: 'Continue', href: '' } })).error!.message,
  /Element changed since it was checked/, 'ASSERT_AFTER_MOVE_GATE: moving the pointer must not bypass the approved name');
assert.ok(!calls.slice(marker).some(call => isCommand(call) && call[1] === 'Input.dispatchMouseEvent' && call[2].type === 'mousePressed'));
chrome.debugger.sendCommand = realSendCommand;
pass('gated clicks recheck after pointer movement before any button press');

const inputCases = [
  ['chrome.click', { selector: '#button' }, 'clicked'], ['chrome.hover', { selector: '#button' }, 'hovered'],
  ['chrome.type', { selector: '#input', text: 'hello' }, 'typed'], ['chrome.press', { key: 'Enter' }, 'pressed'],
  ['chrome.select', { selector: '#select', value: 'b' }, 'selected'], ['chrome.scroll', { dy: 200 }, 'scrolled'],
  ['chrome.scroll', { selector: '#bottom' }, 'scrolled'],
] as const;
for (const [method, params, acknowledgement] of inputCases) {
  for (const changed of [false, true]) {
    pageResult = action => action === 'settle' ? { signature: changed ? 'after' : 'before', url: `${tab.url}current` }
      : { signature: 'before', selector: '@stable:1', x: 10, y: 20, selected: true, scrolled: true };
    const outcome = await request(method, { tab: recoveryTab, ...params });
    assert.equal(outcome.error, undefined);
    assert.equal(outcome.result!.changed, changed, 'ASSERT_VERSION_CHANGED');
    assert.equal(outcome.result!.url, `${tab.url}current`);
    const value: unknown = outcome.result;
    assert.ok(isRecord(value) && value[acknowledgement] === true);
  }
  pageResult = action => action === 'settle' ? { __gaddiError: 'Document was replaced during navigation' }
    : { signature: 'before', selector: '@stable:1', x: 10, y: 20, selected: true, scrolled: true };
  tabRecords.get(recoveryTab)!.status = 'loading';
  tabRecords.get(recoveryTab)!.url = `${tab.url}navigated`;
  marker = calls.length;
  const observed = await request(method, { tab: recoveryTab, ...params });
  assert.equal(observed.error, undefined, 'ASSERT_AFTER_READ_FAILURE: sent input must not become an error');
  assert.equal(observed.result!.changed, true);
  assert.equal(observed.result!.navigating, true);
  assert.equal(observed.result!.url, `${tab.url}navigated`);
  const actionCalls = calls.slice(marker);
  assert.equal(actionCalls.filter(isScript).filter(([, p]) => p.args[0] === 'settle').length, 1);
  assert.equal(actionCalls.filter(isCommand).filter(([, command, p]) => command === 'Input.insertText'
    || command === 'Input.dispatchKeyEvent' && p.type === 'keyDown'
    || command === 'Input.dispatchMouseEvent' && p.type === (method === 'chrome.click' ? 'mouseReleased' : method === 'chrome.hover' ? 'mouseMoved' : 'mouseWheel')).length,
    method === 'chrome.select' || method === 'chrome.scroll' && 'selector' in params ? 0 : 1, 'input is never replayed');
  tabRecords.get(recoveryTab)!.status = 'complete';
}
pass('all input paths compare signatures, return current URL and preserve sent input when after-read fails without replay');

pageResult = action => action === 'settle' ? new Promise(() => {}) : { signature: 'before', x: 10, y: 20 };
marker = calls.length;
const lostObservation = request('chrome.click', { tab: recoveryTab, selector: '#button' });
await waitFor(() => calls.slice(marker).some(call => isScript(call) && call[1].args[0] === 'settle'), 'sent click reaches observation');
timers.findLast(timer => timer.delay === 300 && !timer.cleared)!.fn();
assert.equal((await lostObservation).result!.changed, true, 'lost observation resolves before the input deadline');
assert.equal(calls.slice(marker).filter(isCommand).filter(([, name, p]) => name === 'Input.dispatchMouseEvent' && p.type === 'mouseReleased').length, 1);
pageResult = {};
pass('lost after-read replies are bounded independently of the action deadline');

pageResult = action => action === 'settle' ? new Promise(() => {}) : { signature: 'before', selector: '#input', combobox: true };
marker = calls.length;
const lostComboObservation = request('chrome.type', { tab: recoveryTab, selector: '#input', text: 'hello' });
await waitFor(() => calls.slice(marker).some(call => isScript(call) && call[1].args[0] === 'settle'), 'sent combobox input reaches observation');
timers.findLast(timer => timer.delay === 450 && !timer.cleared)!.fn();
const comboOutcome = await lostComboObservation;
assert.equal(comboOutcome.error, undefined);
assert.equal(comboOutcome.result!.changed, true);
assert.equal(calls.slice(marker).filter(isCommand).filter(([, name]) => name === 'Input.insertText').length, 1);
pageResult = {};
pass('lost combobox observation returns success within its 450 ms budget without replay');

const realGetTab = chrome.tabs.get;
let fallbackLookup = false;
pageResult = action => {
  if (action === 'settle') {
    chrome.tabs.get = () => { fallbackLookup = true; return new Promise(() => {}); };
    return { __gaddiError: 'Document was replaced' };
  }
  return { signature: 'before', x: 10, y: 20 };
};
const lostFallback = request('chrome.click', { tab: recoveryTab, selector: '#button' });
await waitFor(() => fallbackLookup, 'navigation fallback lookup reply lost');
timers.findLast(timer => timer.delay === 300 && !timer.cleared)!.fn();
assert.equal((await lostFallback).result!.changed, true, 'ASSERT_AFTER_READ_FALLBACK: even the URL lookup cannot hang sent input');
chrome.tabs.get = realGetTab;
pageResult = {};
pass('lost fallback tab lookup cannot turn sent input into a deadline error');

pageResult = action => action === 'settle' ? new Promise(() => {}) : { signature: 'before', x: 10, y: 20 };
marker = calls.length;
const nearDeadlineId = ++serial;
ports.at(-1)!.onMessage.listeners[0]({ id: nearDeadlineId, method: 'chrome.click',
  params: { tab: recoveryTab, selector: '#button' }, deadline: Date.now() + 150 });
const nearDeadline = await waitFor(() => replies.get(nearDeadlineId), 'near-deadline input returns without optional observation');
assert.equal(nearDeadline.error, undefined, 'ASSERT_NEAR_DEADLINE_OBSERVATION: sent input retains success');
assert.ok(isRecord(nearDeadline.result) && nearDeadline.result.changed === true);
assert.equal(calls.slice(marker).filter(isCommand).filter(([, name, p]) => name === 'Input.dispatchMouseEvent' && p.type === 'mouseReleased').length, 1);
assert.ok(!calls.slice(marker).some(call => isScript(call) && call[1].args[0] === 'settle'));
assert.equal(calls.at(-1)![0], 'detach');
replies.delete(nearDeadlineId);
pageResult = {};
pass('near-deadline input skips observation and preserves one delivered click plus cleanup');

// Version transport uses real worker code with only Chrome's API doubled.
const versionActions = [
  ['click', { selector: '#button' }], ['hover', { selector: '#button' }],
  ['type', { selector: '#input', text: 'text' }], ['press', { key: 'Tab' }],
  ['select', { selector: '#select', value: 'b' }], ['scroll', { dy: 20 }], ['scroll', { selector: '#bottom' }],
] as const;
for (const [method, params] of versionActions) {
  pageResult = (action, params) => params.version === 'v1-old'
    ? { __gaddiError: 'the page changed since you looked', __gaddiCode: 'stale' }
    : { signature: 'before', selector: '#input', x: 10, y: 20 };
  marker = calls.length;
  const reply = await request(`chrome.${method}`, { tab: recoveryTab, ...params, version: 'v1-old' });
  assert.equal(reply.error?.code, 'stale', 'ASSERT_VERSION_DISPATCH');
  assert.equal(reply.error?.message, 'the page changed since you looked', 'ASSERT_VERSION_DISPATCH');
  assert.ok(!calls.slice(marker).some(call => isCommand(call) && call[1].startsWith('Input.')), 'ASSERT_VERSION_DISPATCH');
}
pass('ASSERT_VERSION_DISPATCH');

for (const [method, params] of versionActions) {
  pageResult = action => action === 'settle' ? { signature: 'after', url: tab.url, version: 'v1-after' }
    : { signature: 'before', selector: '#input', x: 10, y: 20, selected: true, scrolled: true };
  const reply = await request(`chrome.${method}`, { tab: recoveryTab, ...params, version: 'v1-before' });
  assert.equal(reply.error, undefined, 'ASSERT_VERSION_AFTER');
  assert.ok(isRecord(reply.result)); assert.equal(reply.result.version, 'v1-after', 'ASSERT_VERSION_AFTER');
}
pass('ASSERT_VERSION_AFTER');

for (const [method, params, stage] of [
  ['type', { selector: '#input', text: 'text' }, 'typeCheck'],
  ['type', { selector: '#email', text: 'text', mode: 'append' }, 'typeCheck'],
  ['click', { selector: '#button' }, 'clickPoint'],
] as const) {
  let points = 0;
  const nativeEnd = 'mode' in params;
  pageResult = (action, params) => {
    if (action === stage && (++points === (method === 'type' && !nativeEnd ? 1 : 2)) && params.version === 'v1-before')
      return { __gaddiError: 'the page changed since you looked', __gaddiCode: 'stale' };
    return { signature: 'before', selector: '#input', x: 10, y: 20, ...(nativeEnd ? { appendNeedsEnd: true } : {}) };
  };
  marker = calls.length;
  const reply = await request(`chrome.${method}`, { tab: recoveryTab, ...params, version: 'v1-before' });
  assert.equal(reply.error?.code, 'stale', 'ASSERT_VERSION_RECHECK');
  assert.ok(!calls.slice(marker).some(call => isCommand(call)
    && (call[1] === 'Input.insertText' || call[1] === 'Input.dispatchMouseEvent' && call[2].type === 'mousePressed')), 'ASSERT_VERSION_RECHECK');
  if (nativeEnd) assert.equal(calls.slice(marker).filter(isCommand).filter(([, method]) => method === 'Input.dispatchKeyEvent').length, 2,
    'ASSERT_VERSION_RECHECK: native End precedes the second refusal');
}
pass('ASSERT_VERSION_RECHECK');

// Another extension's frame, such as a password manager's inline menu. Chrome refuses
// debugger calls before sending them, or ends the session (target_closed) mid-command.
{
  const FOREIGN = 'Cannot access a chrome-extension:// URL of different extension';
  const realAttach = chrome.debugger.attach, realDetach = chrome.debugger.detach;
  const scripts = (from: number, action: string) => calls.slice(from).filter(isScript).filter(([, p]) => p.args[0] === action);
  const inputs = (from: number) => calls.slice(from).filter(isCommand).filter(([, name]) => name.startsWith('Input.'));
  const cut = (reason: string) => { chrome.debugger.onDetach.emit({ tabId: recoveryTab }, reason); return new Error('Detached while handling command.'); };
  const note = (reply: Reply) => isRecord(reply.result) ? String(reply.result.note ?? '') : '';
  // The frame is in the tab until the page removes it; Chrome refuses attach while it is.
  let frameOpen = false, removable = true;
  const page = (action: string) => {
    if (action === 'closeForeignFrames') { const closed = frameOpen && removable ? 1 : 0; if (closed) frameOpen = false; return { closed }; }
    return action === 'settle' ? { signature: 'after', url: tab.url } : { signature: 'before', selector: '#input', x: 10, y: 20, selected: true };
  };
  chrome.debugger.attach = async target => { calls.push(['attach', target]); if (frameOpen) throw new Error(FOREIGN); };
  // Fire the pauses between attach retries (this harness's timers are manual).
  const pump = setInterval(() => { for (const timer of timers) if (timer.delay === 50 && !timer.cleared) { timer.cleared = true; timer.fn(); } }, 5);

  // Delivered input followed by a refusal or a cut is reported, never sent again.
  for (const [method, params, delivered, failing, stage, failures] of [
    ['chrome.click', { selector: '#button' }, 'mousePressed', 'mouseReleased', 'clickPoint', ['refused']],
    ['chrome.press', { key: 'Enter' }, 'keyDown', 'keyUp', 'pressCheck', ['refused', 'cut']],
  ] as const) {
    for (const failure of failures) {
      pageResult = page;
      chrome.debugger.sendCommand = async (target, name, commandParams) => {
        if (commandParams.type === failing) throw failure === 'refused' ? new Error(FOREIGN) : cut('target_closed');
        return realSendCommand(target, name, commandParams);
      };
      marker = calls.length;
      const reply = await request(method, { tab: recoveryTab, ...params });
      chrome.debugger.sendCommand = realSendCommand;
      assert.match(reply.error?.message || '', /may have landed/, 'ASSERT_FOREIGN_NO_REPLAY');
      assert.equal(inputs(marker).filter(([, , p]) => p.type === delivered).length, 1, 'ASSERT_FOREIGN_NO_REPLAY');
      assert.equal(scripts(marker, stage).length, 1, 'ASSERT_FOREIGN_NO_REPLAY');
    }
  }
  // input cut after delivery is reported as possibly landed and never repeated
  pass('ASSERT_FOREIGN_NO_REPLAY');

  // A click's press and release go to Chrome together; a cut after both were sent is a click.
  pageResult = page;
  chrome.debugger.sendCommand = async (target, name, commandParams) => {
    if (commandParams.type === 'mousePressed' || commandParams.type === 'mouseReleased') { calls.push(['command', name, commandParams]); throw cut('target_closed'); }
    return realSendCommand(target, name, commandParams);
  };
  marker = calls.length;
  const handedReply = await request('chrome.click', { tab: recoveryTab, selector: '#button' });
  chrome.debugger.sendCommand = realSendCommand;
  assert.equal(handedReply.error, undefined, 'ASSERT_FOREIGN_CLICK_HANDED');
  assert.match(note(handedReply), /both press and release were sent/, 'ASSERT_FOREIGN_CLICK_HANDED');
  assert.equal(inputs(marker).filter(([, , p]) => p.type === 'mousePressed').length, 1, 'ASSERT_FOREIGN_CLICK_HANDED');
  // a click cut after both halves were sent is reported clicked, with a note, and never resent
  pass('ASSERT_FOREIGN_CLICK_HANDED');

  // A menu that opens on the typed text cuts the session mid-insert: the field decides.
  for (const landed of [true, false]) {
    pageResult = action => action === 'typeLanded' ? { landed } : page(action);
    chrome.debugger.sendCommand = async (target, name, commandParams) => {
      if (name === 'Input.insertText') { calls.push(['command', name, commandParams]); throw cut('target_closed'); }
      return realSendCommand(target, name, commandParams);
    };
    marker = calls.length;
    const reply = await request('chrome.type', { tab: recoveryTab, selector: '#input', text: 'hello' });
    chrome.debugger.sendCommand = realSendCommand;
    assert.equal(reply.error === undefined, landed, 'ASSERT_FOREIGN_TYPE_LANDED');
    if (!landed) assert.match(reply.error?.message || '', /may have landed/, 'ASSERT_FOREIGN_TYPE_LANDED');
    assert.equal(inputs(marker).length, 1, 'ASSERT_FOREIGN_TYPE_LANDED');
    assert.equal(scripts(marker, 'typeLanded')[0][1].args[1].text, 'hello', 'ASSERT_FOREIGN_TYPE_LANDED');
  }
  // a cut insert is reported typed only when the field holds exactly the text, and never resent
  pass('ASSERT_FOREIGN_TYPE_LANDED');

  // A menu that opens on focus ends the session before the input went out: the action runs
  // once more, trusted, and lands exactly once.
  for (const [method, params, command] of [
    ['chrome.type', { selector: '#input', text: 'hello' }, 'Input.insertText'],
    ['chrome.click', { selector: '#button' }, 'Input.dispatchMouseEvent'],
    ['chrome.press', { key: 'Escape' }, 'Input.dispatchKeyEvent'],
  ] as const) {
    for (const failure of ['refused', 'not attached'] as const) {
      pageResult = page;
      let first = true;
      chrome.debugger.sendCommand = async (target, name, commandParams) => {
        if (name === command && first) {
          first = false;
          if (failure === 'refused') throw new Error(FOREIGN);
          chrome.debugger.onDetach.emit({ tabId: recoveryTab }, 'target_closed');
          throw new Error(`Debugger is not attached to the tab with id: ${recoveryTab}.`);
        }
        return realSendCommand(target, name, commandParams);
      };
      marker = calls.length;
      const reply = await request(method, { tab: recoveryTab, ...params });
      chrome.debugger.sendCommand = realSendCommand;
      assert.equal(reply.error, undefined, 'ASSERT_FOREIGN_RETRY_UNSENT');
      const sent = inputs(marker).filter(([, name]) => name === command);
      assert.equal(sent.length, method === 'chrome.click' ? 3 : method === 'chrome.press' ? 2 : 1, 'ASSERT_FOREIGN_RETRY_UNSENT');
      // Re-enabling focus would refire focus on the field, and that reopens such a menu.
      const focusOn = calls.slice(marker).filter(call => isCommand(call) && call[1] === 'Emulation.setFocusEmulationEnabled' && call[2].enabled);
      assert.equal(focusOn.length, method === 'chrome.type' ? 1 : 2, 'ASSERT_FOREIGN_TYPE_RETRY_NO_FOCUS');
    }
  }
  // unsent input after a foreign-frame cut is retried once with trusted input
  pass('ASSERT_FOREIGN_RETRY_UNSENT');
  // type's retry leaves focus emulation off, so it cannot reopen a focus-driven menu
  pass('ASSERT_FOREIGN_TYPE_RETRY_NO_FOCUS');

  // A menu that opens while only the pointer has moved: the move repeats, the click lands once.
  pageResult = page;
  let moved = 0;
  chrome.debugger.sendCommand = async (target, name, commandParams) => {
    if (commandParams.type === 'mouseMoved' && ++moved === 1) { calls.push(['command', name, commandParams]); throw cut('target_closed'); }
    return realSendCommand(target, name, commandParams);
  };
  marker = calls.length;
  const afterMove = await request('chrome.click', { tab: recoveryTab, selector: '#button' });
  chrome.debugger.sendCommand = realSendCommand;
  assert.equal(afterMove.error, undefined, 'ASSERT_FOREIGN_MOVE_RETRY');
  assert.equal(inputs(marker).filter(([, , p]) => p.type === 'mousePressed').length, 1, 'ASSERT_FOREIGN_MOVE_RETRY');
  // a pointer move alone does not count as delivered input, so the click is retried
  pass('ASSERT_FOREIGN_MOVE_RETRY');

  // A session the person ended (the debugging bar's Cancel) is never worked around.
  pageResult = page;
  chrome.debugger.sendCommand = async (target, name, commandParams) => {
    if (name === 'Input.insertText') throw cut('canceled_by_user');
    return realSendCommand(target, name, commandParams);
  };
  marker = calls.length;
  const cancelled = await request('chrome.type', { tab: recoveryTab, selector: '#input', text: 'hello' });
  chrome.debugger.sendCommand = realSendCommand;
  assert.equal(cancelled.error?.message, 'Detached while handling command.', 'ASSERT_FOREIGN_CANCEL');
  assert.equal(scripts(marker, 'typeCheck').length, 1, 'ASSERT_FOREIGN_CANCEL');
  // a person cancelling the debugger is honoured, not routed around
  pass('ASSERT_FOREIGN_CANCEL');

  // The frame is in the tab before the action: it is removed, then every action uses the debugger.
  for (const [method, params, command] of [
    ['chrome.click', { selector: '#button' }, 'Input.dispatchMouseEvent'],
    ['chrome.type', { selector: '#input', text: 'hello' }, 'Input.insertText'],
    ['chrome.press', { key: 'Escape' }, 'Input.dispatchKeyEvent'],
    ['chrome.scroll', { dy: 300 }, 'Input.dispatchMouseEvent'],
    ['chrome.screenshot', {}, 'Page.captureScreenshot'],
    ['chrome.eval', { expression: '1' }, 'Runtime.evaluate'],
    ['chrome.goto', { url: `${tab.url}after-menu` }, 'Page.navigate'],
  ] as const) {
    pageResult = page;
    frameOpen = true;
    marker = calls.length;
    const reply = await request(method, { tab: recoveryTab, ...params });
    assert.equal(reply.error, undefined, 'ASSERT_FOREIGN_REMOVE');
    assert.equal(scripts(marker, 'closeForeignFrames').length, 1, 'ASSERT_FOREIGN_REMOVE');
    assert.ok(calls.slice(marker).some(call => isCommand(call) && call[1] === command), 'ASSERT_FOREIGN_REMOVE');
    assert.match(note(reply), /Removed another extension's frame/, 'ASSERT_FOREIGN_REMOVE');
  }
  // another extension's frame is removed before attach, and the action runs with the debugger
  pass('ASSERT_FOREIGN_REMOVE');

  // A frame the page cannot remove (none found): the reason after the retry window, no input.
  removable = false;
  pageResult = page;
  frameOpen = true;
  marker = calls.length;
  const unremovable = await request('chrome.click', { tab: recoveryTab, selector: '#button' });
  assert.match(unremovable.error?.message || '', /cannot remove it/, 'ASSERT_FOREIGN_UNREMOVABLE');
  assert.equal(inputs(marker).length, 0, 'ASSERT_FOREIGN_UNREMOVABLE');
  marker = calls.length;
  assert.equal((await request('chrome.select', { tab: recoveryTab, selector: '#select', value: 'b' })).error, undefined);
  assert.equal(scripts(marker, 'select').length, 1, 'select needs focus emulation only');
  removable = true;
  // a frame Gaddi cannot remove is reported with the reason, and no input is sent
  pass('ASSERT_FOREIGN_UNREMOVABLE');

  // A background tab must not be left with the frame open: Chrome could freeze it that way.
  for (const active of [false, true]) {
    tabRecords.get(recoveryTab)!.active = active;
    pageResult = page;
    frameOpen = true;
    marker = calls.length;
    assert.equal((await request('chrome.type', { tab: recoveryTab, selector: '#input', text: 'hello' })).error, undefined);
    assert.equal(scripts(marker, 'closeForeignFrames').length, active ? 1 : 2, 'ASSERT_FOREIGN_BACKGROUND_CLOSE');
  }
  // after meeting such a frame in a background tab, Gaddi removes any it left behind
  pass('ASSERT_FOREIGN_BACKGROUND_CLOSE');

  // A frozen tab runs no page script: the precise reason, and nothing is injected.
  tabRecords.get(recoveryTab)!.frozen = true;
  frameOpen = true;
  marker = calls.length;
  assert.match((await request('chrome.read', { tab: recoveryTab })).error?.message || '', /Chrome has frozen this background tab/, 'ASSERT_FOREIGN_FROZEN_REPORTED');
  assert.equal(calls.slice(marker).filter(isScript).length, 0, 'a frozen page is never injected into');
  tabRecords.get(recoveryTab)!.frozen = false;
  frameOpen = false;
  chrome.debugger.attach = realAttach;
  clearInterval(pump);
  pass('ASSERT_FOREIGN_FROZEN_REPORTED');

  // Chrome may refuse the detach once such a frame has arrived. The session lingers,
  // and the next action adopts it instead of failing with "already attached".
  pageResult = page;
  chrome.debugger.detach = async target => { calls.push(['detach', target]); throw new Error(FOREIGN); };
  assert.equal((await request('chrome.click', { tab: recoveryTab, selector: '#button' })).error, undefined);
  chrome.debugger.detach = realDetach;
  let adopted = false;
  chrome.debugger.attach = async target => { calls.push(['attach', target]); adopted = true; throw new Error(`Another debugger is already attached to the tab with id: ${recoveryTab}.`); };
  marker = calls.length;
  const adoptedReply = await request('chrome.click', { tab: recoveryTab, selector: '#button' });
  assert.ok(adopted);
  assert.equal(adoptedReply.error, undefined, 'ASSERT_FOREIGN_ADOPT');
  assert.equal(inputs(marker).filter(([, , p]) => p.type === 'mouseReleased').length, 1, 'ASSERT_FOREIGN_ADOPT');
  assert.equal(calls.at(-1)![0], 'detach', 'ASSERT_FOREIGN_ADOPT: the adopted session is detached afterwards');
  const unknown = await request('chrome.click', { tab: recoveryTab, selector: '#button' });
  assert.match(unknown.error?.message || '', /already attached/, 'only a session Gaddi knows it left behind is adopted');
  chrome.debugger.attach = realAttach;
  pageResult = {};
  // a session Chrome would not detach is adopted by the next action and then detached
  pass('ASSERT_FOREIGN_ADOPT');
}

// Minimal DOM doubles for local naming, selector identity, and password guards.
// They deliberately do not assert layout, actual injection, or browser event trust.
const attributes = new Map<string, string>();
let node: FixtureNode, inputType = 'text', focusMutation = false;
const doc: FixtureDocument = { activeElement: null, body: { innerText: 'x'.repeat(25001), textContent: 'x'.repeat(25001) }, addEventListener() {},
  getElementsByTagName() { return [node]; },
  documentElement: { scrollHeight: 1000, cloneNode() { throw new Error('unused'); } },
  querySelectorAll(selector) { return selector === '#input' || selector === '*' ? [node] : []; } };
const label = { textContent: 'Notes' };
node = { tagName: 'INPUT', isConnected: true, labels: [label], childNodes: [], tabIndex: 0,
  get type() { return inputType; }, getAttribute(name) { return attributes.get(name) || null; },
  hasAttribute(name) { return attributes.has(name); }, closest() { return null; },
  matches() { return false; }, getRootNode() { return doc; }, getClientRects() { return [{}]; },
  scrollIntoView() {}, focus() { doc.activeElement = node; if (focusMutation) inputType = 'password'; },
};
const pageWorld = vm.createContext({ document: doc, crypto, getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
  location: { href: tab.url }, performance: { timeOrigin: 123 }, scrollX: 0, scrollY: 0,
  Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 }, TextEncoder, TextDecoder, Event, innerWidth: 800, innerHeight: 600 });
const local = (action: string, params: ChromeParams = {}): Promise<PageResult> => {
  pageWorld.args = [action, params];
  return vm.runInContext(`(${pageTask.toString()})(...args)`, pageWorld);
};
const info = await local('describe', { selector: '#input' });
assert.equal(info.name, 'Notes');
assert.equal(info.tag, 'input');
assert.equal(info.type, 'text');
assert.equal((await local('describe', { selector: info.selector })).name, 'Notes');
assert.equal((await local('describe', { selector: '#input' })).selector, info.selector);
pass('content names associated labels and reuses opaque selectors');

node.value = '  first\nsecond  ';
assert.ok((await local('read')).outline!.includes('value="  first\\nsecond  "'), 'ASSERT_VALUE_WHITESPACE: current values preserve meaningful spaces and line breaks');
node.value = undefined;
pass('outline values preserve whitespace inside escaped strings');

for (const [type, autocomplete] of [['password', ''], ['text', 'current-password'], ['text', 'section-login new-password']]) {
  inputType = type; attributes.set('autocomplete', autocomplete);
  assert.match((await local('typeFocus', { selector: '#input' })).__gaddiError!, /password/);
}
attributes.clear(); inputType = 'text'; focusMutation = true;
assert.match((await local('typeFocus', { selector: '#input' })).__gaddiError!, /password/);
assert.match((await local('pressCheck')).__gaddiError!, /password/);
assert.match((await local('evalCheck')).__gaddiError!, /password/);
pass('content blocks password tokens and focus-time password mutation');
for (const tagName of ['IFRAME', 'FRAME', 'OBJECT', 'EMBED']) {
  doc.activeElement = { tagName };
  assert.match((await local('pressCheck')).__gaddiError!, /embedded document/);
}
pass('content refuses keyboard dispatch into uninspected embedded documents');

inputType = 'text'; focusMutation = false;
assert.equal((await local('read')).text!.length, 20000);
node.isConnected = false;
assert.match((await local('describe', { selector: info.selector })).__gaddiError!, /Stale selector/);
pass('content caps read text and rejects detached node selectors');

await local('read'); // Prune the disconnected node's strong reference.
node.isConnected = true;
assert.match((await local('read')).outline!, new RegExp(info.selector!));
assert.equal((await local('describe', { selector: info.selector })).name, 'Notes');
pass('detached and reattached nodes regain resolvable outline selectors');

const makeButton = (name: string): FixtureNode => ({ ...node, tagName: 'BUTTON', type: 'submit', labels: [],
  getAttribute(attr) { return attr === 'aria-label' ? name : null; } });
const preview = makeButton('Preview');
const pay = makeButton('Pay');
const form = { elements: [preview, pay] };
pay.form = form;
pay.closest = selector => selector === 'form' ? form : selector === 'a[href]' ? null : pay;
doc.activeElement = pay;
const payInfo = await local('describe', { selector: ':focus' });
assert.equal(payInfo.name, 'Pay');
assert.equal(payInfo.submitName, 'Pay');
node.form = form;
doc.activeElement = node;
assert.equal((await local('describe', { selector: ':focus' })).submitName, 'Preview');
pass('focused submit button name wins over the default form button');

doc.activeElement = { ...node, tagName: 'MAIN', form: null, labels: [], childNodes: [{ nodeType: 3, textContent: 'Unrelated page contents' }] };
assert.equal((await local('describe', { selector: ':focus' })).name, '');
attributes.set('aria-label', 'Named landmark');
assert.equal((await local('describe', { selector: ':focus' })).name, 'Named landmark');
pass('landmark names use author labels instead of all descendant text');

attributes.clear();
node.matches = selector => selector === '.protected';
assert.deepEqual(Array.from((await local('describe', { selector: '#input', denySelectors: ['.protected', '.ordinary'] })).matched!), ['.protected']);
assert.equal((await local('evalCheck')).__gaddiError!, undefined);
node.shadowRoot = { querySelectorAll() { return [{ type: 'password' }]; } };
assert.match((await local('evalCheck')).__gaddiError!, /password/);
node.shadowRoot = null;
node.tagName = 'IFRAME';
node.contentDocument = { querySelectorAll() { return [{ type: 'password' }]; } };
assert.match((await local('evalCheck')).__gaddiError!, /password/);
node.contentDocument = null; node.tagName = 'INPUT';
pass('custom typing deny selectors and password checks cover open shadows and readable frames');

const redacted: string[] = [];
const secrets = ['password', 'current-password', 'section-login new-password'].map(kind => ({
  type: kind === 'password' ? 'password' : 'text', getAttribute(name: string) { return name === 'autocomplete' ? kind : ''; },
  removeAttribute(name: string) { redacted.push(name); }, set textContent(value: string) { redacted.push(value); },
}));
doc.documentElement = { cloneNode(deep) { assert.equal(deep, true); return {
  querySelectorAll() { return secrets; }, outerHTML: '<html>synthetic-redacted-copy</html>',
}; } };
assert.equal((await local('html')).html, '<html>synthetic-redacted-copy</html>');
assert.deepEqual(redacted, ['value', '', 'value', '', 'value', '']);
pass('HTML extraction redacts password values on a clone without editing the live page');

node.tagName = 'SELECT';
node.options = [{ value: 'a', disabled: false }, { value: 'b', disabled: true }, { value: 'c', parentElement: { disabled: true } }];
const selectEvents: string[] = [];
node.dispatchEvent = event => { selectEvents.push(event.type); };
assert.equal((await local('select', { selector: '#input', value: 'a' })).selected, true);
assert.equal(node.value, 'a');
assert.deepEqual(selectEvents, ['input', 'change']);
for (const value of ['b', 'c', 'missing']) assert.match((await local('select', { selector: '#input', value })).__gaddiError!, /enabled option/);
attributes.set('aria-disabled', 'true');
assert.match((await local('select', { selector: '#input', value: 'a' })).__gaddiError!, /enabled select/);
pass('select validates actual options, disabled groups and controls before dispatching events');

attributes.clear();
node.matches = selector => selector === ':disabled';
node.getBoundingClientRect = () => ({ left: 0, right: 100, top: 0, bottom: 50 });
doc.elementFromPoint = () => node;
assert.match((await local('clickPoint', { selector: '#input' })).__gaddiError!, /not interactable/);
const hoverPoint = await local('hoverPoint', { selector: '#input' });
assert.deepEqual({ x: hoverPoint.x, y: hoverPoint.y }, { x: 50, y: 25 });
assert.equal(typeof hoverPoint.signature, 'string');
pass('disabled controls remain hoverable while clicks are refused');

await versionLogic(pass);

console.log(`== bridge logic: ${passed} passed`);
