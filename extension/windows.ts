// One agent window per Chrome run; session storage survives worker reloads, not browser restarts.
const WINDOW_KEY = 'agentWindow';
const TARGETS_KEY = 'agentWindowTargets';
export function createAgentWindow() {
  let id: number | undefined, blank: number | undefined;
  const ready = chrome.storage.session.get(WINDOW_KEY).then(async value => {
    const saved = value[WINDOW_KEY];
    if (typeof saved === 'number' && Number.isSafeInteger(saved)) { id = saved; return; }
    const record = (await chrome.storage.local.get(TARGETS_KEY))[TARGETS_KEY] as { id?: unknown; targets?: unknown } | undefined;
    if (typeof record?.id !== 'number' || !Array.isArray(record.targets)) return;
    // Page target identities survive an extension reload and change on browser
    // restart. Never recover a window from a recycled numeric tab/window id alone.
    for (const target of await chrome.debugger.getTargets()) if (target.tabId !== undefined && record.targets.includes(target.id)) {
      const tab = await chrome.tabs.get(target.tabId).catch(() => undefined);
      if (tab?.windowId === record.id) { id = record.id; await chrome.storage.session.set({ [WINDOW_KEY]: id }); return; }
    }
  });
  const displays = () => chrome.system.display.getInfo();
  async function get(check: () => void) {
    await ready;
    check();
    if (id !== undefined) {
      const existing = await chrome.windows.get(id).catch(() => undefined);
      check();
      if (existing?.type === 'normal') return id;
      id = undefined;
    }
    const screens = await displays();
    check();
    const screen = screens.find(screen => !screen.isPrimary && screen.isEnabled)
      ?? screens.find(screen => screen.isPrimary) ?? screens[0];
    const area = screen?.workArea;
    const window = await chrome.windows.create({ focused: false, type: 'normal', url: 'about:blank',
      ...(area ? { left: area.left, top: area.top, width: Math.min(1200, area.width), height: Math.min(900, area.height) } : {}) });
    id = window?.id;
    blank = window?.tabs?.[0]?.id;
    if (id === undefined) throw new Error('Chrome did not create an agent window');
    await chrome.storage.session.set({ [WINDOW_KEY]: id });
    check();
    return id;
  }
  async function removeBlank(check: () => void) {
    if (blank === undefined) return;
    const tab = blank;
    blank = undefined;
    check();
    await chrome.tabs.remove(tab).catch(() => {});
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
      id = undefined; blank = undefined;
      await Promise.all([chrome.storage.session.remove(WINDOW_KEY), chrome.storage.local.remove(TARGETS_KEY)]);
    }).catch(() => {});
  });
  chrome.system.display.onDisplayChanged.addListener(() => {
    void ready.then(async () => {
      if (id === undefined) return;
      const window = await chrome.windows.get(id).catch(() => undefined);
      if (!window || window.state === 'minimized') return;
      const primary = (await displays()).find(screen => screen.isPrimary)?.bounds;
      const x = (window.left ?? 0) + (window.width ?? 0) / 2;
      const y = (window.top ?? 0) + (window.height ?? 0) / 2;
      if (primary && x >= primary.left && x < primary.left + primary.width && y >= primary.top && y < primary.top + primary.height)
        await chrome.windows.update(id, { state: 'minimized' });
    }).catch(() => {});
  });
  return { get, removeBlank, remember };
}
