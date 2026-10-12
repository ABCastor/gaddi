// One agent window per Chrome run; session storage survives worker reloads, not browser restarts.
const WINDOW_KEY = 'agentWindow';
const TARGETS_KEY = 'agentWindowTargets';
const OWNER_WINDOW_KEY = 'ownerWindow';
const MODE_KEY = 'agentWindowMode';
const TABS_KEY = 'agentTabScopes';
export function createAgentWindow() {
  let enabled = true;
  let anchor: string | undefined;
  type TabScope = { tabId?: number; windowId: number; groupId?: number; agentGroup?: boolean; protected?: boolean };
  let scopes: Record<string, TabScope> = {};
  let id: number | undefined;
  let ownerId: number | undefined;
  let creatingWindow: Promise<chrome.windows.Window | undefined> | undefined;
  const createdTabs = new Set<number>();
  const pendingCreates = new Set<Promise<chrome.tabs.Tab>>();
  const placeholderURL = chrome.runtime.getURL('placeholder.html');
  const isPlaceholder = (tab: chrome.tabs.Tab) => tab.url === placeholderURL || tab.pendingUrl === placeholderURL;
  const ready = chrome.storage.session.get([WINDOW_KEY, OWNER_WINDOW_KEY, MODE_KEY]).then(async value => {
    enabled = value[MODE_KEY] !== 'shared';
    const owner = value[OWNER_WINDOW_KEY];
    if (typeof owner === 'number' && Number.isSafeInteger(owner)) ownerId = owner;
    const saved = value[WINDOW_KEY];
    if (typeof saved === 'number' && Number.isSafeInteger(saved)) { id = saved; return; }
    // The placeholder tab marks the Gaddi window and survives extension reloads.
    if ((id = await placeholderWindow()) !== undefined) { await chrome.storage.session.set({ [WINDOW_KEY]: id }); return; }
    const record = (await chrome.storage.local.get(TARGETS_KEY))[TARGETS_KEY] as { id?: unknown; targets?: unknown } | undefined;
    if (typeof record?.id !== 'number' || !Array.isArray(record.targets)) return;
    // Page target identities survive an extension reload and change on browser
    // restart. Never recover a window from a recycled numeric tab/window id alone.
    for (const target of await chrome.debugger.getTargets()) if (target.tabId !== undefined && record.targets.includes(target.id)) {
      const tab = await chrome.tabs.get(target.tabId).catch(() => undefined);
      if (tab?.windowId === record.id) { id = record.id; await chrome.storage.session.set({ [WINDOW_KEY]: id }); return; }
    }
  }).then(async () => {
    const stored = (await chrome.storage.local.get(TABS_KEY))[TABS_KEY] as { scopes?: Record<string, TabScope>; anchor?: string } | undefined;
    if (stored?.scopes && typeof stored.scopes === 'object' && !Array.isArray(stored.scopes)) {
      scopes = stored.scopes as Record<string, TabScope>;
      anchor = stored.anchor;
    }
  });
  async function placeholderWindow() {
    return (await chrome.tabs.query({})).find(isPlaceholder)?.windowId;
  }
  async function rememberOwner(window: chrome.windows.Window) {
    if (!enabled || window.id === id || window.type !== 'normal' || window.id === undefined) return;
    ownerId = window.id;
    await chrome.storage.session.set({ [OWNER_WINDOW_KEY]: ownerId });
  }
  let focusQueue = Promise.resolve();
  chrome.windows.onFocusChanged.addListener(focused => {
    if (!enabled || focused === chrome.windows.WINDOW_ID_NONE) return;
    focusQueue = focusQueue.then(async () => {
      await ready;
      await creatingWindow;
      if (!enabled || focused === id) return;
      const window = await chrome.windows.get(focused).catch(() => undefined);
      if (window) await rememberOwner(window);
    }).catch(() => {});
  });
  // onCreated can precede tabs.create's result. Wait for exact IDs, never
  // exempt every tab arriving while an agent creation is in flight.
  function createTab(options: chrome.tabs.CreateProperties) {
    const pending = chrome.tabs.create(options).then(tab => {
      if (tab.id !== undefined) createdTabs.add(tab.id);
      return tab;
    });
    pendingCreates.add(pending);
    return pending.finally(() => pendingCreates.delete(pending));
  }
  async function route(tab: chrome.tabs.Tab) {
    await ready;
    await focusQueue;
    await Promise.allSettled([...pendingCreates]);
    if (!enabled || tab.windowId !== id || tab.id === undefined || createdTabs.has(tab.id)) return;
    const current = await chrome.tabs.get(tab.id).catch(() => undefined);
    if (!current || current.windowId !== id || isPlaceholder(current)) return;
    if (tab.openerTabId !== undefined) {
      const opener = await chrome.tabs.get(tab.openerTabId).catch(() => undefined);
      if (opener && opener.windowId === id && !isPlaceholder(opener)) return;
    }
    let owner = ownerId === undefined ? undefined : await chrome.windows.get(ownerId).catch(() => undefined);
    if (!owner || owner.id === id || owner.type !== 'normal')
      owner = (await chrome.windows.getAll({ windowTypes: ['normal'] })).find(window => window.id !== id);
    if (!enabled) return;
    if (owner?.id !== undefined) {
      await chrome.tabs.move(tab.id, { windowId: owner.id, index: -1 });
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(owner.id, { focused: true });
    } else owner = await chrome.windows.create({ tabId: tab.id, type: 'normal', focused: true });
    if (owner) await rememberOwner(owner);
  }
  let routing = Promise.resolve();
  chrome.tabs.onCreated.addListener(tab => {
    if (!enabled) return;
    routing = routing.then(() => route(tab)).catch(() => {});
  });
  chrome.tabs.onRemoved.addListener(tab => createdTabs.delete(tab));
  async function keepAlive(check: () => void) {
    const tabs = await chrome.tabs.query({ windowId: id });
    check();
    if (!tabs.some(isPlaceholder)) await createTab({ windowId: id, url: placeholderURL, active: false });
    check();
  }
  async function get(check: () => void) {
    await ready;
    await focusQueue;
    check();
    if (ownerId === undefined) {
      const owner = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => undefined);
      if (owner) await rememberOwner(owner);
      check();
    }
    if (id !== undefined) {
      const existing = await chrome.windows.get(id).catch(() => undefined);
      check();
      if (existing?.type === 'normal') {
        await keepAlive(check);
        check();
        return id;
      }
      id = undefined;
    }
    creatingWindow = chrome.windows.create({ focused: false, type: 'normal', url: placeholderURL, state: 'minimized' }).then(window => {
      id = window?.id;
      for (const tab of window?.tabs ?? []) if (tab.id !== undefined) createdTabs.add(tab.id);
      return window;
    });
    await creatingWindow.finally(() => { creatingWindow = undefined; });
    if (id === undefined) throw new Error('Chrome did not create an agent window');
    await chrome.storage.session.set({ [WINDOW_KEY]: id });
    await remember(check);
    check();
    return id;
  }
  async function remember(check: () => void) {
    const tabs = await chrome.tabs.query({ windowId: id });
    check();
    const targets = (await chrome.debugger.getTargets()).filter(target => tabs.some(tab => tab.id === target.tabId)).map(target => target.id);
    check();
    await chrome.storage.local.set({ [TARGETS_KEY]: { id, targets } });
  }
  chrome.windows.onRemoved.addListener(removed => {
    void ready.then(async () => {
      if (id !== removed) return;
      id = undefined;
      await Promise.all([chrome.storage.session.remove(WINDOW_KEY), chrome.storage.local.remove(TARGETS_KEY)]);
    }).catch(() => {});
  });
  async function isAgent(tab: chrome.tabs.Tab, groups?: chrome.tabGroups.TabGroup[]) {
    await ready;
    groups ??= await chrome.tabGroups.query({});
    return !isPlaceholder(tab) && (tab.windowId === id || groups.some(group => group.id === tab.groupId && group.title?.startsWith('● ')));
  }
  // Page target IDs, unlike numeric tab IDs, cannot be recycled across browser
  // runs. Persist scope and owner handoffs through extension/broker reloads.
  let scopeQueue = Promise.resolve();
  const groupingTabs = new Set<number>();
  async function inspectTabs(protectId?: number, grouped: number[] = []) {
    await ready;
    const [tabs, groups, targets] = await Promise.all([chrome.tabs.query({}), chrome.tabGroups.query({}), chrome.debugger.getTargets()]);
    const currentAnchor = targets.find(target => tabs.some(tab => tab.id === target.tabId && isPlaceholder(tab)))?.id;
    const sameBrowser = currentAnchor !== undefined && currentAnchor === anchor;
    const next: typeof scopes = {};
    const eligible: chrome.tabs.Tab[] = [];
    for (const tab of tabs) {
      const target = targets.find(target => target.tabId === tab.id)?.id
        ?? (currentAnchor ? `tab:${currentAnchor}:${tab.id}` : undefined);
      if (!target) continue;
      const old = scopes[target] ?? (sameBrowser ? Object.values(scopes).find(scope => scope.tabId === tab.id) : undefined);
      const agent = await isAgent(tab, groups);
      if (!old && !agent && tab.id !== protectId) continue;
      const agentGroup = groups.some(group => group.id === tab.groupId && group.title?.startsWith('● '));
      const moved = old && !grouped.includes(tab.id!) && !groupingTabs.has(tab.id!) && (old.windowId !== tab.windowId || old.groupId !== tab.groupId || old.agentGroup && !agentGroup);
      const record = next[target] = { tabId: tab.id, windowId: tab.windowId, groupId: tab.groupId, agentGroup,
        ...(old?.protected || moved || tab.id === protectId ? { protected: true } : {}) };
      if (enabled && agent && !record.protected && !(tab.active && (await chrome.windows.get(tab.windowId)).focused)) eligible.push(tab);
    }
    if (currentAnchor !== anchor || JSON.stringify(next) !== JSON.stringify(scopes)) {
      scopes = next;
      anchor = currentAnchor;
      await chrome.storage.local.set({ [TABS_KEY]: { anchor, scopes } });
    }
    return eligible;
  }
  function cleanupTabs(protectId?: number, grouped?: number[]) {
    const pending = scopeQueue.catch(() => {}).then(() => inspectTabs(protectId, grouped));
    scopeQueue = pending.then(() => {});
    return pending;
  }
  async function groupTabs<T>(ids: number[], task: () => Promise<T>) {
    await cleanupTabs();
    for (const tab of ids) groupingTabs.add(tab);
    try { return await task(); }
    finally {
      try { await cleanupTabs(undefined, ids); }
      finally { for (const tab of ids) groupingTabs.delete(tab); }
    }
  }
  chrome.tabs.onDetached.addListener(tab => { if (!groupingTabs.has(tab)) void cleanupTabs(tab).catch(() => {}); });
  chrome.tabs.onUpdated.addListener((tab, change) => {
    if (change.groupId === undefined || groupingTabs.has(tab)) return;
    const previous = Object.values(scopes).find(scope => scope.tabId === tab);
    if (previous && previous.groupId !== change.groupId) void cleanupTabs(tab).catch(() => {});
  });
  chrome.tabGroups.onUpdated.addListener(group => {
    if (group.title?.startsWith('● ')) return;
    for (const scope of Object.values(scopes)) if (scope.agentGroup && scope.groupId === group.id && scope.tabId !== undefined)
      void cleanupTabs(scope.tabId).catch(() => {});
  });
  async function setMode(mode: 'own' | 'shared') {
    await ready;
    enabled = mode === 'own';
    await chrome.storage.session.set({ [MODE_KEY]: mode });
  }
  return { get, isPlaceholder, remember, createTab, setMode, isAgent, cleanupTabs, groupTabs };
}
