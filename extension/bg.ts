import type { ChromeParams, ChromeRequest, Reply, BrokerResults, TabInfo, PageResult, PageResults } from '../shared/protocol.ts';
import type { Protocol } from '../node_modules/playwright-core/types/protocol.d.ts';

function actionErrorMessage(error: unknown): string {
  return error && typeof error === 'object' && 'message' in error && typeof error.message === 'string' ? error.message : '';
}

type Check = () => void;
interface Deadline { check: Check; expired: Promise<never>; error: Error; end: number }
type CDPSend = <M extends keyof Protocol.CommandReturnValues>(method: M, params?: Protocol.CommandParameters[M]) => Promise<Protocol.CommandReturnValues[M]>;
interface DebuggerSession { ready: Promise<void>; closing?: Promise<void>; owner?: object; inputFocus?: boolean }
// Whether one request met another extension's frame (which blocks the debugger) and what it did about it.
interface Route { foreign?: boolean; note?: string }
type LiveTab = chrome.tabs.Tab & { id: number };
type NavigationError = Error & { preserveTab?: boolean; navigationURL?: string };
declare global {
  var __gaddiBridgeTest: { disconnectNativePort(): void } | undefined;
}
import { waitParams, versionParam, hasErrorCode, isRecord } from '../shared/protocol.ts';
import { pageTask } from './content.ts';
import { manageExtensions } from './extensions.ts';
import { createRecovery, RECOVERY_KEY } from './recovery.ts';

const NATIVE_HOST = 'com.abcastor.gaddi.bridge';
let nativePort: chrome.runtime.Port | undefined, reconnectTimer: ReturnType<typeof setTimeout> | undefined, retryDelay = 250, nextConnect = 0;
let healthTimer: ReturnType<typeof setTimeout> | undefined, healthSequence = 0;
let health: { id: string; port: chrome.runtime.Port; deadline: number } | undefined;
const recovery = createRecovery({
  load: async () => (await chrome.storage.local.get(RECOVERY_KEY))[RECOVERY_KEY],
  save: value => chrome.storage.local.set({ [RECOVERY_KEY]: value }),
  reload: () => chrome.runtime.reload(),
});
const requestSelfReload = recovery.requestSelfReload;
// Invariant: page scripts cannot invoke this bridge. Only the native port supplies
// commands; there is no runtime.onMessage, external listener, or page event bus.
// tabs/scripting + all_urls inspect existing tabs; debugger supplies trusted input;
// nativeMessaging reaches the daemon; alarms revives a suspended reconnect loop.
// tabGroups organizes shared tabs; bookmarks grants read-only tree access here.

function checkHealth() {
  const port = nativePort;
  if (!port) return;
  clearTimeout(healthTimer);
  if (health && health.port === port) {
    if (Date.now() >= health.deadline) {
      health = undefined;
      // A native host can remain alive while its broker is absent or stalled.
      // Destroy the transport, never resend an outstanding page action.
      failNative(port, 'broker-unresponsive');
      return;
    }
  } else {
    health = { id: `health:${++healthSequence}`, port, deadline: Date.now() + 10000 };
    try { port.postMessage({ id: health.id, method: 'bridge.health', params: { lastSelfHeal: recovery.lastSelfHeal() } }); }
    catch { failNative(port, 'native-disconnect'); return; }
  }
  healthTimer = setTimeout(checkHealth, Math.max(0, health!.deadline - Date.now()));
}

// Assigned by the live port so stale disconnects cannot affect its replacement.
let failNative: (port: chrome.runtime.Port, reason: 'native-disconnect' | 'broker-unresponsive') => void = () => {};

function connectNative() {
  if (nativePort || Date.now() < nextConnect) return;
  clearTimeout(reconnectTimer);
  let port: chrome.runtime.Port;
  try { port = chrome.runtime.connectNative(NATIVE_HOST); }
  catch {
    void recovery.failed('native-disconnect');
    nextConnect = Date.now() + retryDelay;
    reconnectTimer = setTimeout(connectNative, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 30000);
    return;
  }
  nativePort = port;
  port.onMessage.addListener((message: ChromeRequest) => {
    if (nativePort !== port) return;
    if (!message || !['string', 'number'].includes(typeof message.id)) return;
    if (message.method === 'bridge.health') {
      if (health?.port !== port || message.id !== health.id) return;
      const result = isRecord(message) ? message.result : undefined;
      if (Date.now() >= health.deadline || !isRecord(result) || result.connected !== true) { failNative(port, 'broker-unresponsive'); return; }
      health = undefined; retryDelay = 250;
      void recovery.healthy();
      clearTimeout(healthTimer);
      healthTimer = setTimeout(checkHealth, 15000);
      return;
    }
    if (message.method === 'chrome.selfReload') {
      const check = () => {
        if (nativePort !== port) throw new Error('Self-reload transport disconnected');
        if (typeof message.deadline === 'number' && (!Number.isFinite(message.deadline) || Date.now() >= message.deadline))
          throw new Error('Self-reload request deadline expired');
      };
      requestSelfReload('broker-requested', check).then(result => reply({ id: message.id, result }),
        error => reply({ id: message.id, error: { message: actionErrorMessage(error) || 'Self-reload request failed' } }));
      return;
    }
    withinDeadline(scope => dispatch(message, scope), message.deadline, () => nativePort === port).then(result => reply({ id: message.id, result }),
      error => reply({ id: message.id, error: { message: isSigninMethod(message.method) ? 'Sign-in action failed' : actionErrorMessage(error) || 'Chrome action failed',
        ...(hasErrorCode(error, 'stale') ? { code: 'stale' } : {}) } }));
    function reply(message: Reply) {
      if (nativePort !== port) return;
      try { port.postMessage(message); } catch { /* Host has disconnected. Never replay an action. */ }
    }
  });
  function disconnected(reason: 'native-disconnect' | 'broker-unresponsive' = 'native-disconnect') {
    void chrome.runtime.lastError;
    if (nativePort !== port) return;
    nativePort = undefined;
    health = undefined; clearTimeout(healthTimer);
    void recovery.failed(reason);
    nextConnect = Date.now() + retryDelay;
    reconnectTimer = setTimeout(connectNative, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 30000);
  }
  port.onDisconnect.addListener(() => disconnected());
  failNative = (failed, reason) => {
    if (failed !== port || nativePort !== port) return;
    disconnected(reason);
    try { port.disconnect(); } catch { /* The transport is already unavailable. */ }
  };
  if (NATIVE_HOST.endsWith('.test')) globalThis.__gaddiBridgeTest = {
    disconnectNativePort() { port.disconnect(); disconnected(); },
  };
  void recovery.ready.then(() => { if (nativePort === port) checkHealth(); });
}
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'bridge-keepalive') { connectNative(); checkHealth(); detachLingering(); } });
chrome.runtime.onStartup.addListener(connectNative);
chrome.runtime.onInstalled.addListener(connectNative);
chrome.alarms.create('bridge-keepalive', { periodInMinutes: 0.5 });
connectNative();

const tabQueues = new Map<number | string, Promise<unknown>>(), attached = new Map<number, DebuggerSession>(), emulations = new Map<number, ChromeParams>();
const PAGE_TASK_TIMEOUT_MS = 25000;
const AGENT_GROUP_PREFIX = '● ';
// Chrome refuses every chrome.debugger call (attach, command, detach) while any frame in
// the tab shows another extension's page, such as a password manager's inline menu, and
// ends a live session (reason target_closed) the moment such a frame starts loading:
// Chromium debugger_api.cc ExtensionMayAttachToURL/ExtensionMayAttachToRenderFrameHost,
// devtools_instrumentation.cc OnNavigationRequestWillBeSent. The check runs before the
// command is sent, so a refused command never reached the page.
const FOREIGN_FRAME = 'Cannot access a chrome-extension:// URL of different extension';
const FOREIGN_FRAME_HELP = "Another extension's frame (such as a password manager's menu) is on this page where Gaddi cannot remove it, "
  + "and Chrome blocks Gaddi's debugger while it is there. Ask the user to close that menu, or reload the page";
const FOREIGN_CLOSED = "Removed another extension's frame (such as a password manager's menu) from the page: Chrome blocks Gaddi's debugger while one is open";
// Page scripts do not run in a frozen tab, and waking it needs the debugger.
const FROZEN_FOREIGN_HELP = "Chrome has frozen this background tab, and another extension's frame (such as a password manager's menu) blocks the debugger Gaddi needs to wake it, "
  + 'so nothing on the page can run. Close the tab and open the page again, or ask the user to bring it forward';
const detachReasons = new Map<number, string>();
// Pieces of a file the broker vetted and is sending for an upload, by upload id.
const uploads = new Map<string, { parts: string[]; at: number }>();
// Sessions Chrome would not let Gaddi detach because such a frame arrived meanwhile.
const lingering = new Set<number>();
function detachLingering() {
  for (const tab of lingering) if (!attached.has(tab)) chrome.debugger.detach({ tabId: tab })
    .then(() => lingering.delete(tab), error => { if (actionErrorMessage(error) !== FOREIGN_FRAME) lingering.delete(tab); });
}
chrome.tabs.onRemoved.addListener(tab => { attached.delete(tab); emulations.delete(tab); detachReasons.delete(tab); lingering.delete(tab); });
chrome.debugger.onDetach.addListener(({ tabId }, reason) => {
  if (tabId === undefined) return;
  detachReasons.set(tabId, reason);
  const hadMotion = emulations.get(tabId)?.animationSpeed !== undefined;
  attached.delete(tabId); emulations.delete(tabId);
  if (hadMotion) forTab<PageResult | false>(tabId, check => !emulations.has(tabId)
    && onPage(tabId, 'animationSpeed', { reset: true }, check)).catch(() => {});
});
chrome.tabs.onUpdated.addListener((tab, change) => {
  if (change.status === 'complete' && emulations.get(tab)?.animationSpeed !== undefined) {
    forTab<PageResult | false>(tab, check => emulations.get(tab)?.animationSpeed !== undefined
      && onPage(tab, 'animationSpeed', { animationSpeed: emulations.get(tab)!.animationSpeed }, check)).catch(() => {});
  }
});
function withinDeadline<T>(task: (scope: Deadline) => Promise<T>, deadline = Date.now() + PAGE_TASK_TIMEOUT_MS, connected = () => true): Promise<T> {
  const end = Math.min(deadline, Date.now() + PAGE_TASK_TIMEOUT_MS);
  const error = new Error('Chrome did not respond within 25 seconds; inspect the tab before retrying');
  let expired = false, timer: ReturnType<typeof setTimeout> | undefined;
  const scope: Deadline = {
    error, end,
    check() {
      // Invariant: a delayed delivery/API result cannot start or continue an expired
      // action, even if Chrome delayed the timer itself. Reconnect never replays it.
      if (expired || !Number.isFinite(end) || Date.now() >= end) throw error;
      if (!connected()) throw new Error('Chrome bridge disconnected; inspect the tab before retrying');
    },
    expired: new Promise<never>((_, reject) => {
      timer = setTimeout(() => { expired = true; reject(error); }, Math.max(0, end - Date.now()));
    }),
  };
  const work = (async () => { scope.check(); const result = await task(scope); scope.check(); return result; })();
  return Promise.race([work, scope.expired]).finally(() => clearTimeout(timer));
}
function forTab<T>(tab: number | string, task: (check: Check) => T | Promise<T>, scope?: Deadline): Promise<T> {
  if (!scope) return withinDeadline(scope => forTab(tab, task, scope));
  const { check } = scope;
  const work = (tabQueues.get(tab) || Promise.resolve()).catch(() => {}).then(() => { check(); return task(check); });
  const running = Promise.race([work, scope.expired]);
  // Include lookup and queue wait in the same request budget. Group mutations
  // stay serialized until the outstanding API settles, including after expiry.
  const queued = tab === 'groups' ? work : running;
  tabQueues.set(tab, queued);
  queued.finally(() => { if (tabQueues.get(tab) === queued) tabQueues.delete(tab); }).catch(() => {});
  return running;
}
async function tabInfo(tab: chrome.tabs.Tab, groups?: chrome.tabGroups.TabGroup[]) {
  groups ??= await chrome.tabGroups.query({});
  const group = groups.find(group => group.id === tab.groupId);
  return { ...(group ? { group: group.title || '' } : {}), ...(tab.frozen === true ? { frozen: true } : {}),
    ...(tab.discarded === true ? { discarded: true } : {}), id: tab.id, windowId: tab.windowId, index: tab.index, active: tab.active, title: tab.title || '', url: tab.url || '' } satisfies TabInfo;
}
function tabIds(value: unknown): number[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100
    || value.some(id => !Number.isSafeInteger(id) || id < 0)) throw new Error('tabs must contain 1 to 100 Chrome tab ids');
  return [...new Set(value)];
}
async function findGroup(title: unknown) {
  if (typeof title !== 'string' || !title.startsWith(AGENT_GROUP_PREFIX) || !title.slice(AGENT_GROUP_PREFIX.length).trim()) throw new Error('group must have the agent prefix and a label');
  return (await chrome.tabGroups.query({})).find(group => group.title === title);
}
// Call under the shared groups queue so open and group cannot create duplicate titles.
async function joinGroup(ids: number[], title: string | undefined, group: chrome.tabGroups.TabGroup | undefined, foreground: boolean, check: Check) {
  check();
  const tabs = await Promise.all(ids.map(id => getTab(id)));
  check();
  const windowId = group?.windowId ?? tabs[0].windowId;
  for (const tab of tabs) if (tab.windowId !== windowId) { check(); await chrome.tabs.move(tab.id, { windowId, index: -1 }); }
  check();
  const groupId = await chrome.tabs.group({ tabIds: ids as [number, ...number[]], ...(group ? { groupId: group.id } : { createProperties: { windowId } }) });
  check();
  if (!group) await chrome.tabGroups.update(groupId, { title, color: 'cyan', collapsed: !foreground });
  else if (foreground) await chrome.tabGroups.update(groupId, { collapsed: false });
  return groupId;
}
async function getTab(id?: number | null): Promise<LiveTab> {
  if (id !== undefined && id !== null) {
    if (!Number.isInteger(id) || id < 0) throw new Error('tab must be a Chrome tab id');
    return await chrome.tabs.get(id) as LiveTab;
  }
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tabs.length) throw new Error('No active Chrome tab');
  return tabs[0] as LiveTab;
}
async function onPage<A extends keyof PageResults>(tab: number, action: A, params: ChromeParams = {}, check: Check): Promise<PageResults[A]> {
  // Version guards run before in-page effects. Trusted CDP input follows this
  // promise asynchronously, so this is a preflight check, not atomic native input.
  check();
  const [injection] = await chrome.scripting.executeScript({ target: { tabId: tab }, injectImmediately: true, world: 'ISOLATED', func: pageTask, args: [action, params] });
  const response = injection as (chrome.scripting.InjectionResult<PageResult> & { error?: { message?: string } }) | undefined;
  // Invariant: a late injection result cannot authorize follow-up input after expiry.
  check();
  if (!response || response.error) throw new Error(response?.error?.message || 'Page script failed');
  if (response.result === undefined) throw new Error('Page script returned no result');
  if (response.result?.__gaddiError) throw Object.assign(new Error(response.result.__gaddiError),
    response.result.__gaddiCode === 'stale' ? { code: 'stale' } : {});
  // pageTask checks each producer against the same action-specific contract.
  return response.result as PageResults[A];
}
async function waitOnTab(tab: number, params: ChromeParams, scope: Deadline) {
  const args = waitParams(params), start = Date.now(), end = start + args.timeout!;
  let wake: (() => void) | undefined;
  const updated = (id: number, change: { url?: string; status?: string }) => {
    if (id === tab && (change.url !== undefined || change.status !== undefined)) wake?.();
  };
  chrome.tabs.onUpdated.addListener(updated);
  try {
    do {
      scope.check();
      const current = await getTab(tab);
      if (args.url !== undefined) {
        if ((current.url || '').includes(args.url)) return { met: true, ms: Date.now() - start, url: current.url || '' };
        if (Date.now() >= end) break;
        await new Promise<void>(resolve => {
          const timer = setTimeout(done, Math.min(250, end - Date.now()));
          function done() { clearTimeout(timer); wake = undefined; resolve(); }
          wake = done;
        });
      } else {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const remaining = Math.max(0, end - Date.now());
          const result = await Promise.race([
            onPage(tab, 'wait', { ...args, timeout: Math.min(2000, remaining) }, scope.check),
            new Promise<null>(resolve => {
              const done = () => { wake = undefined; resolve(null); };
              wake = done; timer = setTimeout(done, Math.min(2100, remaining + 100));
            }),
          ]);
          if (result?.met) return { met: true, ms: Date.now() - start, url: (await getTab(tab)).url || '' };
        } catch (error) {
          // A destroyed document loses its injection; malformed CSS is still an error.
          if (/selector|SyntaxError/i.test(actionErrorMessage(error))) throw error;
          if ((await getTab(tab)).status !== 'loading' && Date.now() < end) {
            // Chrome may finish loading before reporting a destroyed execution context.
            await new Promise(resolve => setTimeout(resolve, Math.min(50, Math.max(0, end - Date.now()))));
          }
        } finally { clearTimeout(timer); wake = undefined; }
      }
    } while (Date.now() < end);
    return { met: false, ms: Date.now() - start, url: (await getTab(tab)).url || '' };
  } finally { chrome.tabs.onUpdated.removeListener(updated); }
}
async function afterInput(tab: number, before: PageResults['snapshot'], url: string, scope: Deadline, combobox = false) {
  // Observation cannot reject an input already sent. Bound even a lost injection
  // reply (navigation or a busy renderer); do not leave agents waiting to replay it.
  const maxWait = combobox ? 450 : 300;
  // Preserve the request deadline and leave the same budget for debugger cleanup.
  if (scope.end - Date.now() <= maxWait * 2) return { changed: true, url };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        try {
          const after = await onPage(tab, 'settle', { settleMs: combobox ? 200 : 50 }, scope.check);
          return { changed: before.signature !== after.signature, url: after.url,
            ...(after.version ? { version: after.version } : {}) };
        } catch {
          const current = await getTab(tab).catch(() => null);
          return { changed: true, url: current?.url || url,
            ...(current?.status === 'loading' || current?.pendingUrl ? { navigating: true } : {}) };
        }
      })(),
      new Promise<{ changed: boolean; url: string }>(resolve => {
        timer = setTimeout(() => resolve({ changed: true, url }), maxWait);
      }),
    ]);
  } finally { clearTimeout(timer); }
}
// These answers mean Chrome did not send the command at all.
const unsent = (error: unknown) => /^(?:Cannot access a chrome-extension:\/\/ URL of different extension|Debugger is not attached)/.test(actionErrorMessage(error));
async function endedByForeignFrame(tab: number, error: unknown) {
  const message = actionErrorMessage(error);
  if (message === FOREIGN_FRAME) return true;
  if (!/^(?:Debugger is not attached|Detached while handling command)/.test(message)) return false;
  // A frame that starts loading ends the session before it commits, so the failed command
  // does not name it; Chrome reports the end (target_closed) separately, sometimes later.
  // Any other end, such as the person cancelling the debugging bar, is not overridden.
  for (let i = 0; i < 15 && !detachReasons.has(tab); i++) await new Promise(resolve => setTimeout(resolve, 20));
  return detachReasons.get(tab) === 'target_closed';
}
const foreignFrameError = (maybeDelivered: boolean) => Object.assign(new Error(maybeDelivered
  ? "Another extension's frame opened on this page during the input and Chrome stopped Gaddi's debugger; part of the input may have landed. "
    + 'Look before retrying; type focuses its field itself, so a field needs no click first' : FOREIGN_FRAME_HELP), { foreignFrame: true, maybeDelivered });
const isForeignFrameError = (error: unknown) => isRecord(error) && error.foreignFrame === true;
const surelyUndelivered = (error: unknown) => isForeignFrameError(error) && isRecord(error) && error.maybeDelivered === false;
async function attachDebugger(tab: number, check: Check, route?: Route) {
  const target = { tabId: tab };
  for (let until = 0; ; ) {
    try {
      await chrome.debugger.attach(target, '1.3');
      detachReasons.delete(tab); lingering.delete(tab);
      return;
    } catch (error) {
      if (route && actionErrorMessage(error) === FOREIGN_FRAME) route.foreign = true;
      // Chrome names only this extension's own session here: a lingering one is adopted.
      if (lingering.has(tab) && actionErrorMessage(error).startsWith('Another debugger is already attached')) {
        detachReasons.delete(tab); lingering.delete(tab);
        return;
      }
      // Without a route (waking a frozen tab) page scripts cannot run, so nothing is removed.
      if (!route || actionErrorMessage(error) !== FOREIGN_FRAME) throw error;
      // Remove the frame and attach again, as a person dismisses the menu and acts. Chrome
      // drops a removed frame a moment later, and the other extension may put it back, so
      // each refusal within the second removes again.
      if (until) {
        if (Date.now() >= until) throw error;
        await new Promise(resolve => setTimeout(resolve, 50));
        check();
      }
      if ((await onPage(tab, 'closeForeignFrames', {}, check)).closed) route.note = FOREIGN_CLOSED;
      until ||= Date.now() + 1000;
    }
  }
}
async function withDebugger<T>(tab: number, fn: (send: CDPSend) => Promise<T>, check: Check, input = false, route?: Route): Promise<T> {
  check();
  const target = { tabId: tab };
  let session = attached.get(tab);
  if (session?.closing) {
    await session.closing;
    check();
    session = attached.get(tab);
  }
  if (!session) {
    session = { ready: attachDebugger(tab, check, route) };
    attached.set(tab, session);
  }
  const owner = {};
  session.owner = owner;
  let delivered = false;
  // A pointer move changes nothing a second move would not, so it never blocks a retry.
  const counts = (method: string, params: object | undefined) => method.startsWith('Input.')
    && !(method === 'Input.dispatchMouseEvent' && (params as { type?: string } | undefined)?.type === 'mouseMoved');
  const send: CDPSend = async (method, params) => {
    check();
    try {
      const result = await chrome.debugger.sendCommand(target, method, params ?? {});
      if (counts(method, params)) delivered = true;
      check();
      return result as Protocol.CommandReturnValues[typeof method];
    } catch (error) {
      // Only an unsent command is known not to have reached the page.
      if (counts(method, params) && !unsent(error)) delivered = true;
      throw error;
    }
  };
  try {
    await session.ready;
    check();
    // Hidden tabs need frames for trusted mouse/key delivery. This changes the
    // renderer's focus/visibility, never the selected Chrome tab or window.
    if (input || session.inputFocus) {
      session.inputFocus = true; // Track even an enable whose reply arrives late.
      await send('Emulation.setFocusEmulationEnabled', { enabled: input });
      session.inputFocus = input;
    }
    return await fn(send);
  } catch (error) {
    if (!await endedByForeignFrame(tab, error)) throw error;
    if (route) route.foreign = true;
    // Invariant: a retry may follow only input known not to have reached the page;
    // anything else is reported as possibly delivered, never repeated.
    throw foreignFrameError(delivered);
  }
  finally {
    // Detaching clears CDP overrides. An emulated tab retains its attachment
    // until reset or a human detaches it; transient actions reuse that session.
    // Invariant: an expired task cannot detach a session adopted by its successor.
    if (emulations.has(tab) && session.inputFocus && attached.get(tab) === session && session.owner === owner) {
      // Cleanup must work after expiry; successors wait for it before reusing
      // this retained session. A non-input successor also clears inherited focus.
      session.closing = chrome.debugger.sendCommand(target, 'Emulation.setFocusEmulationEnabled', { enabled: false })
        .then(() => { session.inputFocus = false; })
        .catch(async error => {
          if (attached.get(tab) === session && session.owner === owner) {
            const hadMotion = emulations.get(tab)?.animationSpeed !== undefined;
            emulations.delete(tab);
            await chrome.debugger.detach(target).catch(() => {});
            if (attached.get(tab) === session) attached.delete(tab);
            if (hadMotion) forTab<PageResult | false>(tab, cleanupCheck => !emulations.has(tab)
              && onPage(tab, 'animationSpeed', { reset: true }, cleanupCheck)).catch(() => {});
          }
          throw error;
        }).finally(() => { delete session.closing; });
      await session.closing;
    }
    if (!emulations.has(tab) && attached.get(tab) === session && session.owner === owner) {
      session.closing = chrome.debugger.detach(target).catch(error => {
        if (actionErrorMessage(error) !== FOREIGN_FRAME) return;
        if (route) route.foreign = true;
        if (!detachReasons.has(tab)) lingering.add(tab);
      }).finally(() => {
        if (attached.get(tab) === session) attached.delete(tab);
      });
      await session.closing;
    }
  }
}
async function navigate(tab: number, send: CDPSend, url: string, entryId?: number) {
  await send('Page.enable');
  await send('Page.setLifecycleEventsEnabled', { enabled: true });
  const { frameTree: { frame: before } } = await send('Page.getFrameTree');
  let response: Partial<Protocol.Page.navigateReturnValue> | undefined, committed: (Protocol.Page.Frame & { restored: boolean }) | undefined, sameDocument = false, preserveTab = false, settled = false;
  const ready = new Set<string>();
  const inAppLoaders = new Set<string>();
  let appRedirect: string | undefined;
  let userNavigation = false;
  const sameOrigin = (value: string) => { try { return new URL(value).origin === new URL(url).origin; } catch { return false; } };
  let resolve!: () => void, reject!: (error: Error) => void;
  const completion = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  // Attach a rejection handler before invoking CDP; navigation events can precede
  // the command response, and the deadline must also bound a stalled command.
  completion.catch(() => {});
  function finish(error?: Error) {
    if (settled) return;
    settled = true;
    if (error) reject(error); else resolve();
  }
  function check() {
    if (!response) return;
    if (userNavigation) { preserveTab = true; finish(new Error('Navigation was superseded; inspect the tab before retrying')); return; }
    // The target can finish and then be replaced before Page.navigate replies.
    // Compare the latest commit, not a cached earlier successful document.
    if (response.loaderId && committed && committed.loaderId !== response.loaderId && !inAppLoaders.has(committed.loaderId)) {
      preserveTab = true;
      finish(new Error('Navigation was superseded; inspect the tab before retrying'));
      return;
    }
    if (committed && (ready.has(committed.loaderId) || committed.restored) || sameDocument && !response.loaderId) finish();
  }
  function onEvent(source: chrome.debugger.Debuggee, method: string, data: object | undefined) {
    if (source.tabId !== tab || !data) return;
    if (method === 'Page.frameRequestedNavigation' && (data as Protocol.Page.frameRequestedNavigationPayload).frameId === before.id) {
      preserveTab = true;
      const event = data as Protocol.Page.frameRequestedNavigationPayload;
      if (event.reason !== 'scriptInitiated') userNavigation = true;
      // A loaded app may route to another same-origin document. A user's link
      // navigation and redirects before load still count as superseding it.
      appRedirect = !userNavigation && event.reason === 'scriptInitiated' && committed && ready.has(committed.loaderId) && sameOrigin(event.url) ? event.url : undefined;
    }
    if (method === 'Page.frameNavigated' && !(data as Protocol.Page.frameNavigatedPayload).frame.parentId) {
      const event = data as Protocol.Page.frameNavigatedPayload;
      const frame = { ...event.frame, restored: event.type === 'BackForwardCacheRestore' };
      if (frame.unreachableUrl) { finish(new Error('Navigation failed to load a document')); return; }
      if (appRedirect === frame.url) { inAppLoaders.add(frame.loaderId); appRedirect = undefined; }
      if (frame.loaderId !== before.loaderId) {
        if (committed && committed.loaderId !== frame.loaderId) preserveTab = true;
        committed = frame;
      }
      if (response?.loaderId && frame.loaderId !== response.loaderId && !inAppLoaders.has(frame.loaderId)) {
        preserveTab = true;
        finish(new Error('Navigation was superseded; inspect the tab before retrying'));
      }
    }
    if (method === 'Page.lifecycleEvent') {
      const event = data as Protocol.Page.lifecycleEventPayload;
      if (event.frameId === before.id && ['DOMContentLoaded', 'load'].includes(event.name)) ready.add(event.loaderId);
    }
    if (method === 'Page.navigatedWithinDocument' && (data as Protocol.Page.navigatedWithinDocumentPayload).frameId === before.id) {
      const event = data as Protocol.Page.navigatedWithinDocumentPayload;
      const destination = event.url;
      const appRoute = event.navigationType === 'historyApi' || appRedirect === destination;
      // DOMContentLoaded handlers can rewrite history before Chrome reports
      // that lifecycle event. The new document has already committed; check()
      // still waits for its readiness before returning it to the caller.
      if (!userNavigation && (destination === url || appRoute && sameOrigin(destination)
        && (sameDocument || committed && (event.navigationType === 'historyApi' || ready.has(committed.loaderId))))) sameDocument = true;
      else { preserveTab = true; finish(new Error('Navigation was superseded; inspect the tab before retrying')); }
    }
    check();
  }
  function removed(id: number) { if (id === tab) { preserveTab = true; finish(new Error('Tab closed during navigation')); } }
  chrome.debugger.onEvent.addListener(onEvent);
  chrome.tabs.onRemoved.addListener(removed);
  const timer = setTimeout(() => finish(new Error('Navigation did not produce a readable document within 20 seconds')), 20000);
  try {
    const command = (async () => {
      response = await send(entryId === undefined ? 'Page.navigate' : 'Page.navigateToHistoryEntry',
        entryId === undefined ? { url } : { entryId });
      if (response.errorText || response.isDownload) throw new Error(response.isDownload
        ? 'Navigation started a download instead of a document' : `Navigation failed: ${response.errorText}`);
      // A history traversal can restore a cached document without load events.
      // Same-document navigation is identified by its own event, never by a
      // readyState/status value left over from the previous document.
      check();
      await completion;
    })();
    await Promise.race([command, completion]);
    return await getTab(tab);
  } catch (caught) {
    const error: NavigationError = caught instanceof Error ? caught : new Error(actionErrorMessage(caught));
    error.preserveTab = preserveTab;
    error.navigationURL = committed?.url || url;
    throw error;
  } finally {
    settled = true;
    clearTimeout(timer);
    chrome.debugger.onEvent.removeListener(onEvent);
    chrome.tabs.onRemoved.removeListener(removed);
  }
}

async function emulate(tab: number, params: ChromeParams, check: Check, route?: Route) {
  const previous = emulations.get(tab);
  if (params.reset !== undefined && typeof params.reset !== 'boolean') throw new Error('reset must be boolean');
  for (const key of ['width', 'height'] as const) if (params[key] !== undefined
    && (!Number.isInteger(params[key]) || params[key] < 1 || params[key] > 10000)) throw new Error(`${key} must be an integer from 1 to 10000`);
  if (params.mobile !== undefined && typeof params.mobile !== 'boolean') throw new Error('mobile must be boolean');
  if (params.colorScheme !== undefined && !['light', 'dark', 'no-preference'].includes(params.colorScheme)) throw new Error('Unsupported colorScheme');
  if (params.animationSpeed !== undefined && (typeof params.animationSpeed !== 'number'
    || !Number.isFinite(params.animationSpeed) || params.animationSpeed <= 0 || params.animationSpeed > 1)) throw new Error('animationSpeed must be greater than 0 and at most 1');
  return withDebugger(tab, async send => {
    try {
    if (params.reset) {
      await onPage(tab, 'animationSpeed', { reset: true }, check);
      await send('Emulation.clearDeviceMetricsOverride');
      // An empty features list does not undo an earlier prefers-color-scheme override; an empty value does.
      await send('Emulation.setEmulatedMedia', { media: '', features: [{ name: 'prefers-color-scheme', value: '' }] });
      emulations.delete(tab);
      return;
    }
    const next = { ...emulations.get(tab) };
    for (const key of ['width', 'height', 'mobile', 'colorScheme', 'animationSpeed'] as const) if (params[key] !== undefined) Object.assign(next, { [key]: params[key] });
    if ((['width', 'height', 'mobile'] as const).some(key => next[key] !== undefined)) {
      // Zero means unchanged viewport dimension, not an arbitrary device preset.
      await send('Emulation.setDeviceMetricsOverride', { width: next.width || 0, height: next.height || 0,
        mobile: next.mobile || false, deviceScaleFactor: 0 });
    }
    if (next.colorScheme !== undefined) await send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: next.colorScheme }],
    });
    if (next.animationSpeed !== undefined) await onPage(tab, 'animationSpeed', { animationSpeed: next.animationSpeed }, check);
    emulations.set(tab, next);
    } catch (error) {
      // A partial override must not outlive a failed emulate request. Detach in
      // withDebugger clears it, including any previous override on this tab.
      // A late failure must preserve settings installed by a successor.
      if (emulations.get(tab) === previous) emulations.delete(tab);
      try { check(); } catch (expired) {
        // Detach clears CDP overrides, but a late injection can have installed
        // page-side motion. Reset it on the queue unless a successor replaced it.
        forTab<PageResult | false>(tab, cleanupCheck => !emulations.has(tab)
          && onPage(tab, 'animationSpeed', { reset: true }, cleanupCheck)).catch(() => {});
        throw expired;
      }
      await onPage(tab, 'animationSpeed', { reset: true }, check).catch(() => {});
      check();
      emulations.delete(tab);
      throw error;
    }
  }, check, false, route);
}

function navigationURL(value: unknown) {
  if (typeof value !== 'string') throw new Error('url is required');
  const url = new URL(value);
  // Invariant: navigation is not an alternative script-execution or local-file API.
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only http and https navigation is supported');
  return url.href;
}
function unreadableURL(value: string) {
  const url = new URL(value);
  return ['chrome:', 'chrome-extension:', 'edge:', 'about:', 'view-source:', 'file:'].includes(url.protocol)
    || url.hostname === 'chromewebstore.google.com'
    || (url.hostname === 'chrome.google.com' && /^\/webstore(?:\/|$)/.test(url.pathname));
}
function keyEvent(value: unknown) {
  if (typeof value !== 'string' || !value) throw new Error('key is required');
  const parts = value.split('+'), raw = parts.pop()!;
  const bits: Record<string, number> = { Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Command: 4, Cmd: 4, Shift: 8 };
  let modifiers = 0;
  for (const part of parts) {
    if (!bits[part]) throw new Error(`Unsupported modifier: ${part}`);
    modifiers |= bits[part];
  }
  const aliases: Record<string, string> = { Esc: 'Escape', Return: 'Enter', Space: ' ', Spacebar: ' ', Left: 'ArrowLeft', Right: 'ArrowRight', Up: 'ArrowUp', Down: 'ArrowDown' };
  const key = aliases[raw] || raw;
  const codes: Record<string, number> = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ArrowLeft: 37, ArrowUp: 38,
    ArrowRight: 39, ArrowDown: 40, Home: 36, End: 35, PageUp: 33, PageDown: 34, ' ': 32 };
  const vk = codes[key] || (/^F(?:[1-9]|1[0-2])$/.test(key) ? 111 + Number(key.slice(1)) : key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
  if (!vk) throw new Error(`Unsupported key: ${key}`);
  const code = key === ' ' ? 'Space' : /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : /^\d$/.test(key) ? `Digit${key}` : key;
  const text = modifiers & 7 ? '' : key === 'Enter' ? '\r' : key.length === 1 ? key : '';
  return { key, code, modifiers, windowsVirtualKeyCode: vk, ...(text ? { text, unmodifiedText: text } : {}) };
}

function isSigninMethod(method: string) { return ['chrome.signinProbe', 'chrome.signinType', 'chrome.signinSubmit'].includes(method); }
async function dispatch(request: ChromeRequest, scope: Deadline) {
  try { return await dispatchAction(request, scope); }
  catch (error) { if (isSigninMethod(request.method)) throw new Error('Sign-in action failed'); throw error; }
}
async function dispatchAction({ method, params = {} }: ChromeRequest, scope: Deadline) {
  if (['chrome.click', 'chrome.type', 'chrome.press', 'chrome.select', 'chrome.scroll', 'chrome.hover'].includes(method))
    params.version = versionParam(params.version);
  const { check } = scope;
  const queued = <T>(tab: number | string, task: (check: Check) => T | Promise<T>) => forTab(tab, task, scope);
  check();
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('params must be an object');
  if (method === 'chrome.extensions') return manageExtensions(params, check, () => recovery.requestSelfReload('broker-requested', check));
  if (method === 'chrome.tabs') {
    const groups = await chrome.tabGroups.query({});
    return { tabs: await Promise.all((await chrome.tabs.query({})).map(tab => tabInfo(tab, groups))) } satisfies BrokerResults['tabs'];
  }
  if (method === 'chrome.bookmarks') {
    if (params.query !== undefined && typeof params.query !== 'string') throw new Error('query must be a string');
    const bookmarks: { path: string; title: string; url: string }[] = [], query = (params.query || '').toLowerCase();
    function visit(nodes: chrome.bookmarks.BookmarkTreeNode[], folders: string[] = []) {
      for (const node of nodes) {
        if (node.url) {
          const bookmark = { path: folders.join('/'), title: node.title || '', url: node.url };
          if (Object.values(bookmark).some(value => value.toLowerCase().includes(query))) bookmarks.push(bookmark);
        } else visit(node.children || [], node.title ? [...folders, node.title] : folders);
      }
    }
    visit(await chrome.bookmarks.getTree());
    return { bookmarks } satisfies BrokerResults['bookmarks'];
  }
  if (method === 'chrome.active') return tabInfo(await getTab());
  if (method === 'chrome.uploadChunk') {
    // Invariant: file bytes arrive only over the native port, from the broker that read and
    // vetted the file. No page, and no path, can reach this store.
    const { id, index, data } = params.upload || {};
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id) || typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0 || index >= 64
      || typeof data !== 'string' || data.length > 800000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new Error('invalid upload piece');
    for (const [key, entry] of uploads) if (Date.now() - entry.at > 60000) uploads.delete(key);
    if (!uploads.has(id) && uploads.size >= 4) throw new Error('too many uploads in progress');
    const entry = uploads.get(id) || { parts: [], at: Date.now() };
    entry.parts[index] = data;
    uploads.set(id, entry);
    return { stored: index };
  }
  if (method === 'chrome.close') {
    // Invariant: nothing closes the tab the user is looking at by omission; IDs are explicit.
    const ids = tabIds(params.tabs), closed = [], failed = [];
    for (const tab of ids) {
      check();
      try { await chrome.tabs.remove(tab); closed.push(tab); }
      catch (error) { failed.push({ tab, reason: actionErrorMessage(error) || 'Tab could not be closed' }); }
    }
    return { closed, failed } satisfies BrokerResults['close'];
  }
  if (method === 'chrome.show') {
    if (typeof params.tab !== 'number' || !Number.isSafeInteger(params.tab) || params.tab < 0) throw new Error('tab must be a Chrome tab id');
    const tab = (await chrome.tabs.update(params.tab, { active: true }))!;
    // macOS may refuse focus (locked screen, another app in front); drawAttention then bounces the Dock icon.
    check();
    await chrome.windows.update(tab.windowId, { focused: true, drawAttention: true });
    return tabInfo(tab);
  }
  if (method === 'chrome.group') {
    const ids = tabIds(params.tabs);
    return queued('groups', async () => {
      const group = await findGroup(params.group);
      const groupId = await joinGroup(ids, params.group, group, false, check);
      return { tabs: await Promise.all(ids.map(async id => tabInfo(await getTab(id)))), group: params.group, groupId };
    });
  }
  // Tab management above injects nothing, including on Chrome's own pages.
  if (method === 'chrome.open') {
    // Existing tabs stay in their window/order; only the new tab joins a group.
    const url = navigationURL(params.url), title = params.group ?? `${AGENT_GROUP_PREFIX}unknown`;
    // Serialize just group creation so concurrent opens cannot create duplicates.
    const opened = await queued('groups', async () => {
      const group = await findGroup(title);
      check();
      const opened = await chrome.tabs.create({ url: 'about:blank', active: params.foreground === true,
        ...(group ? { windowId: group.windowId } : {}) }) as LiveTab;
      scope.error.message = `Chrome did not respond within 25 seconds; tab ${opened.id} was preserved; inspect it before retrying`;
      try {
        await joinGroup([opened.id], title, group, params.foreground === true, check);
      } catch (error) {
        // Before expiry, remove our blank tab if grouping fails. After expiry,
        // creation may already have happened; preserve it for inspection, never
        // continue cleanup against a tab the user may since have taken over.
        check();
        await chrome.tabs.remove(opened.id);
        throw error;
      }
      return opened;
    });
    return queued(opened.id, async check => {
      try {
        return tabInfo(await withDebugger(opened.id, send => navigate(opened.id, send, url), check));
      } catch (caught) {
        const error: NavigationError = caught instanceof Error ? caught : new Error(actionErrorMessage(caught));
        check();
        const current = await getTab(opened.id).catch(() => null);
        check();
        // Invariant: failed-open cleanup applies only to our original navigation.
        // If the user took over, preserve their tab and surface its ID explicitly.
        const ours = current && !error.preserveTab
          && (!current.pendingUrl || current.pendingUrl === url || current.pendingUrl === error.navigationURL)
          && ['about:blank', url, error.navigationURL].includes(current.url);
        let preserved = !!current;
        if (ours) {
          try { await chrome.tabs.remove(opened.id); preserved = false; } catch { /* Report the retained tab below. */ }
        }
        throw new Error(`${error.message}${preserved ? `; tab ${opened.id} was preserved` : ''}`);
      }
    });
  }
  const operations = ['describe', 'read', 'html', 'screenshot', 'approvalCapture', 'click', 'type', 'press', 'goto',
    'hover', 'scroll', 'select', 'upload', 'back', 'eval', 'emulate', 'wait', 'signinProbe', 'signinType', 'signinSubmit'];
  const action = typeof method === 'string' && method.startsWith('chrome.') ? method.slice(7) : '';
  if (!operations.includes(action)) throw new Error('Unsupported Chrome method');
  if (action === 'wait') waitParams(params);
  const tab = (await getTab(params.tab)).id;
  const route: Route = {};
  // Focus emulation only lets a hidden tab render; the action itself is page-level.
  const emulatedFocus = <T>(fn: () => Promise<T>) => withDebugger(tab, fn, scope.check, true, route)
    .catch(error => { if (!surelyUndelivered(error)) throw error; return fn(); });
  // A menu that opens on focus can end the session before any input was sent. Such an
  // action runs once more, and its attach removes the new frame; sent input never repeats.
  const trusted = <T>(fn: (send: CDPSend) => Promise<T>, input = true, retryInput = input) => withDebugger(tab, fn, scope.check, input, route)
    .catch(error => { if (!surelyUndelivered(error)) throw error; return withDebugger(tab, fn, scope.check, retryInput, route); });
  const value = await queued(tab, async check => {
    const current = await getTab(tab), result = { tab, url: current.url || '' };
    check();
    if (action === 'wait' && params.url !== undefined) return waitOnTab(tab, params, scope);
    if (current.discarded) throw new Error(`Tab ${tab} is discarded; reload it explicitly before working on the page`);
    // Invariant: restricted tabs remain discoverable, but never reach injection or debugger actions.
    if (current.url && unreadableURL(current.url)) {
      if (action === 'read') return { ...result, title: current.title || '', text: '', outline: '',
        note: "Chrome's own page: not readable; pick another tab" };
      throw new Error("Chrome's own pages cannot be driven");
    }
    if (current.frozen && action === 'approvalCapture') throw new Error('Capture tab is frozen');
    if (current.frozen) await withDebugger(tab, send => send('Page.setWebLifecycleState', { state: 'active' }), check)
      .catch(error => { throw isForeignFrameError(error) ? new Error(FROZEN_FOREIGN_HELP) : error; });
    if (action === 'signinProbe') return emulatedFocus(() => onPage(tab, 'signinProbe', params, check));
    if (action === 'signinType' || action === 'signinSubmit') {
      if (action === 'signinType' && typeof params.text !== 'string') throw new Error('Sign-in action failed');
      if (action === 'signinSubmit' && params.key !== undefined && params.key !== 'Enter') throw new Error('Sign-in action failed');
      return trusted(async send => {
        // These guards are intentionally separate from ordinary typing. Only the
        // native broker can request this origin-bound, role-bound password path.
        await onPage(tab, action === 'signinType' ? 'signinFocus' : 'signinSubmitFocus', params, check);
        await onPage(tab, action === 'signinType' ? 'signinCheck' : 'signinSubmitCheck', params, check);
        if (action === 'signinType') {
          await send('Input.insertText', { text: params.text! });
          return { typed: true };
        }
        const event = keyEvent('Enter');
        await send('Input.dispatchKeyEvent', { type: 'keyDown', ...event });
        const { text, unmodifiedText, ...up } = event;
        await send('Input.dispatchKeyEvent', { type: 'keyUp', ...up });
        return { pressed: true };
      }, true, false).catch(async error => {
        // A password manager can cut the debugger while the insert is returning.
        // Confirm the checked field holds the credential, without exporting it
        // or replaying the input. Submission keeps its separate no-replay path.
        if (action !== 'signinType' || !isForeignFrameError(error)
          || !(await onPage(tab, 'signinLanded', params, check)).landed) throw error;
        return { typed: true };
      });
    }
    if (action === 'wait') return emulatedFocus(() => waitOnTab(tab, params, scope));
    if (action === 'describe' || action === 'read' || action === 'html') return { ...result, ...await onPage(tab, action, params, check) };
    if (action === 'goto') return withDebugger(tab, async send => tabInfo(await navigate(tab, send, navigationURL(params.url))), check, false, route);
    if (action === 'back') return withDebugger(tab, async send => {
      const history = await send('Page.getNavigationHistory');
      const previous = history.entries[history.currentIndex - 1];
      if (!previous) throw new Error('No previous history entry');
      navigationURL(previous.url);
      return tabInfo(await navigate(tab, send, previous.url, previous.id));
    }, check, false, route);
    if (action === 'emulate') {
      await emulate(tab, params, check, route);
      return { ...result, emulated: !params.reset };
    }
    if (action === 'eval') {
      if (typeof params.expression !== 'string' || !params.expression.trim()) throw new Error('expression is required');
      // Invariant: password expressions are refused in addition to the page's password-field check.
      if (/password/i.test(params.expression)) throw new Error('Refusing password access');
      return withDebugger(tab, async send => {
        await onPage(tab, 'evalCheck', {}, check);
        const evaluated = await send('Runtime.evaluate', { expression: params.expression!,
          returnByValue: true, awaitPromise: true, timeout: 10000 });
        if (evaluated.exceptionDetails) throw new Error('Page evaluation failed');
        if (evaluated.result?.subtype === 'error') throw new Error('Page evaluation failed');
        return { ...result, value: evaluated.result?.value ?? evaluated.result?.unserializableValue ?? null };
      }, check, false, route);
    }
    if (action === 'upload') {
      // The page gets the file through its own file field or drop events; no debugger, so
      // this also works while another extension's frame is open.
      const meta = params.upload, entry = meta ? uploads.get(meta.id) : undefined;
      if (meta) uploads.delete(meta.id);
      if (!meta || !entry || typeof meta.chunks !== 'number' || entry.parts.length !== meta.chunks || [...entry.parts].some(part => typeof part !== 'string')
        || typeof meta.name !== 'string' || typeof meta.sha256 !== 'string' || typeof meta.size !== 'number') throw new Error('Upload data is incomplete; retry');
      const data = entry.parts.join(''), bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
      if (digest !== meta.sha256 || bytes.length !== meta.size) throw new Error('Upload data did not arrive intact; retry');
      const before = await onPage(tab, 'upload', { selector: params.selector, version: params.version,
        file: { name: meta.name, type: meta.type || 'application/octet-stream', lastModified: meta.lastModified ?? Date.now(), data } }, check);
      return { ...result, uploaded: true, via: before.via, ...await afterInput(tab, before, result.url, scope) };
    }
    if (action === 'select') return emulatedFocus(async () => {
      const before = await onPage(tab, 'select', params, check);
      return { ...result, selected: true, ...await afterInput(tab, before, result.url, scope) };
    });
    if (action === 'scroll') {
      if ((params.dy !== undefined) === (params.selector !== undefined)) throw new Error('Supply dy or selector, exactly one');
      if (params.selector !== undefined) return emulatedFocus(async () => {
        const before = await onPage(tab, 'scroll', params, check);
        return { ...result, scrolled: true, ...await afterInput(tab, before, result.url, scope) };
      });
      if (typeof params.dy !== 'number' || !Number.isFinite(params.dy)) throw new Error('dy must be finite');
      return trusted(async send => {
        const before = await onPage(tab, 'snapshot', params, check);
        await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 1, y: 1, deltaX: 0, deltaY: params.dy });
        return { ...result, scrolled: true, ...await afterInput(tab, before, result.url, scope) };
      });
    }
    if (action === 'approvalCapture') return withDebugger(tab, async send => {
      const target = await onPage(tab, 'captureBox', params, check);
      const { clip } = target;
      const scale = Math.min(1, 1200 / clip.width, 720 / clip.height) / target.pixelRatio;
      const { data } = await send('Page.captureScreenshot', { format: 'jpeg', quality: 70,
        captureBeyondViewport: target.beyondViewport, clip: { ...clip, scale } });
      // Keep coordinates tied to the same isolated-world node. A layout or focus
      // change during capture makes the optional picture unusable, never an input.
      const after = await onPage(tab, 'captureBox', { ...params, selector: target.selector }, check);
      if (JSON.stringify(after) !== JSON.stringify(target)) throw new Error('Capture target moved');
      const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
      const { width, height } = bitmap;
      bitmap.close();
      check();
      const box = { x: (target.box.x - clip.x) * width / clip.width,
        y: (target.box.y - clip.y) * height / clip.height,
        width: target.box.width * width / clip.width, height: target.box.height * height / clip.height };
      return { ...result, data, mimeType: 'image/jpeg', width, height, box /* CAPTURE_BOX_TEST_POINT */ };
    }, check, false, route);
    if (action === 'screenshot') return trusted(async send => {
      const { cssContentSize, cssVisualViewport } = await send('Page.getLayoutMetrics');
      const bounds = params.fullPage === true ? cssContentSize : {
        x: cssVisualViewport.pageX, y: cssVisualViewport.pageY,
        width: cssVisualViewport.clientWidth, height: cssVisualViewport.clientHeight,
      };
      const { result: { value: pixelRatio } } = await send('Runtime.evaluate', { expression: 'window.devicePixelRatio', returnByValue: true });
      const scale = Math.min(1, 1568 / Math.max(bounds.width, bounds.height)) / pixelRatio;
      const { data } = await send('Page.captureScreenshot', { format: 'jpeg', quality: 85,
        captureBeyondViewport: params.fullPage === true, clip: { ...bounds, scale } });
      return { ...result, data, mimeType: 'image/jpeg' };
    }, false);
    // Set when a click's press and release both reached Chrome before a session ended.
    let handed = false;
    if (action === 'click' || action === 'hover') return trusted(async send => {
      const before = await onPage(tab, action === 'hover' ? 'hoverPoint' : 'clickPoint', params, check);
      const point = { x: before.x, y: before.y };
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
      if (action === 'click') {
        // Pointer movement can run handlers that change the gated name or href.
        if (params.checkedDescription || params.version) {
          const { x, y } = await onPage(tab, 'clickCheck', params, check);
          Object.assign(point, { x, y });
        }
        // Both halves go to Chrome at once, so a menu that opens on the press (a password
        // manager under a field) cannot end the session between them.
        const halves = await Promise.allSettled((['mousePressed', 'mouseReleased'] as const)
          .map(type => send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 })));
        const failed = halves.find(half => half.status === 'rejected');
        if (failed) {
          handed = halves.every(half => half.status === 'fulfilled' || !unsent(half.reason));
          throw failed.reason;
        }
      }
      return { ...result, [action === 'click' ? 'clicked' : 'hovered']: true, ...await afterInput(tab, before, result.url, scope) };
    }).catch(error => {
      if (!handed || !isForeignFrameError(error)) throw error;
      route.note = "Another extension's frame opened as the click went in and Chrome stopped Gaddi's debugger after both press and release were sent; look to confirm the result";
      return { ...result, clicked: true, changed: true };
    });
    if (action === 'type') {
      if (typeof params.text !== 'string') throw new Error('text must be a string');
      if (params.mode !== undefined && params.mode !== 'replace' && params.mode !== 'append') throw new Error('mode must be replace or append');
      const target = { ...await onPage(tab, 'typeFocus', params, check), mode: params.mode };
      return trusted(async send => {
        try {
          await onPage(tab, 'typeCheck', { ...target, version: params.version }, check);
          if (target.appendNeedsEnd) {
            // Email/number inputs have no DOM selection API. A trusted End key
            // moves their native caret, then focus/writability is checked again.
            const end = keyEvent('End');
            await send('Input.dispatchKeyEvent', { type: 'keyDown', ...end });
            await send('Input.dispatchKeyEvent', { type: 'keyUp', ...end });
            await onPage(tab, 'typeCheck', { ...target, version: params.version }, check);
          }
          await send('Input.insertText', { text: params.text! });
        } finally {
          // Restore layout even when input fails or its deadline has expired.
          if (target.appendCleanup) await onPage(tab, 'typeCleanup', { appendCleanup: target.appendCleanup }, () => {}).catch(() => {});
        }
        return { ...result, typed: true, ...await afterInput(tab, target, result.url, scope, target.combobox) };
      }, true, false).catch(async error => {
        // A menu that opens on the typed text can end the session while the insert is in
        // flight. The field then shows whether it landed; text is never inserted twice.
        if (!isForeignFrameError(error) || !(await onPage(tab, 'typeLanded', { selector: target.selector, text: target.expectedText ?? params.text }, check)).landed) throw error;
        return { ...result, typed: true, ...await afterInput(tab, target, result.url, scope, target.combobox) };
      });
    }
    if (action === 'press') {
      const event = keyEvent(params.key);
      return trusted(async send => {
        const before = await onPage(tab, 'pressCheck', params, check);
        await send('Input.dispatchKeyEvent', { type: 'keyDown', ...event });
        const { text, unmodifiedText, ...up } = event;
        await send('Input.dispatchKeyEvent', { type: 'keyUp', ...up });
        return { ...result, pressed: true, ...await afterInput(tab, before, result.url, scope) };
      });
    }
  });
  // In a tab nobody has in front, Chrome may freeze the page with such a frame open, and
  // waking a frozen tab needs the debugger the frame blocks: remove it while the page runs.
  if (route.foreign) await queued(tab, async check => !(await getTab(tab)).active
    && onPage(tab, 'closeForeignFrames', {}, check)).catch(() => {});
  return route.note && isRecord(value) ? { ...value, note: route.note } : value;
}
