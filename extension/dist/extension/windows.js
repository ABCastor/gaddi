// One agent window per Chrome run; session storage survives worker reloads, not browser restarts.
const WINDOW_KEY = 'agentWindow';
const TARGETS_KEY = 'agentWindowTargets';
const OWNER_WINDOW_KEY = 'ownerWindow';
const MODE_KEY = 'agentWindowMode';
export function createAgentWindow() {
    let enabled = true;
    let id;
    let ownerId;
    let creatingWindow;
    const createdTabs = new Set();
    const pendingCreates = new Set();
    const placeholderURL = chrome.runtime.getURL('placeholder.html');
    const isPlaceholder = (tab) => tab.url === placeholderURL || tab.pendingUrl === placeholderURL;
    const ready = chrome.storage.session.get([WINDOW_KEY, OWNER_WINDOW_KEY, MODE_KEY]).then(async (value) => {
        enabled = value[MODE_KEY] !== 'shared';
        const owner = value[OWNER_WINDOW_KEY];
        if (typeof owner === 'number' && Number.isSafeInteger(owner))
            ownerId = owner;
        const saved = value[WINDOW_KEY];
        if (typeof saved === 'number' && Number.isSafeInteger(saved)) {
            id = saved;
            return;
        }
        // The placeholder tab marks the Gaddi window and survives extension reloads.
        if ((id = await placeholderWindow()) !== undefined) {
            await chrome.storage.session.set({ [WINDOW_KEY]: id });
            return;
        }
        const record = (await chrome.storage.local.get(TARGETS_KEY))[TARGETS_KEY];
        if (typeof record?.id !== 'number' || !Array.isArray(record.targets))
            return;
        // Page target identities survive an extension reload and change on browser
        // restart. Never recover a window from a recycled numeric tab/window id alone.
        for (const target of await chrome.debugger.getTargets())
            if (target.tabId !== undefined && record.targets.includes(target.id)) {
                const tab = await chrome.tabs.get(target.tabId).catch(() => undefined);
                if (tab?.windowId === record.id) {
                    id = record.id;
                    await chrome.storage.session.set({ [WINDOW_KEY]: id });
                    return;
                }
            }
    });
    async function placeholderWindow() {
        return (await chrome.tabs.query({})).find(isPlaceholder)?.windowId;
    }
    async function rememberOwner(window) {
        if (!enabled || window.id === id || window.type !== 'normal' || window.id === undefined)
            return;
        ownerId = window.id;
        await chrome.storage.session.set({ [OWNER_WINDOW_KEY]: ownerId });
    }
    let focusQueue = Promise.resolve();
    chrome.windows.onFocusChanged.addListener(focused => {
        if (!enabled || focused === chrome.windows.WINDOW_ID_NONE)
            return;
        focusQueue = focusQueue.then(async () => {
            await ready;
            await creatingWindow;
            if (!enabled || focused === id)
                return;
            const window = await chrome.windows.get(focused).catch(() => undefined);
            if (window)
                await rememberOwner(window);
        }).catch(() => { });
    });
    // onCreated can precede tabs.create's result. Wait for exact IDs, never
    // exempt every tab arriving while an agent creation is in flight.
    function createTab(options) {
        const pending = chrome.tabs.create(options).then(tab => {
            if (tab.id !== undefined)
                createdTabs.add(tab.id);
            return tab;
        });
        pendingCreates.add(pending);
        return pending.finally(() => pendingCreates.delete(pending));
    }
    async function route(tab) {
        await ready;
        await focusQueue;
        await Promise.allSettled([...pendingCreates]);
        if (!enabled || tab.windowId !== id || tab.id === undefined || createdTabs.has(tab.id))
            return;
        const current = await chrome.tabs.get(tab.id).catch(() => undefined);
        if (!current || current.windowId !== id || isPlaceholder(current))
            return;
        if (tab.openerTabId !== undefined) {
            const opener = await chrome.tabs.get(tab.openerTabId).catch(() => undefined);
            if (opener && opener.windowId === id && !isPlaceholder(opener))
                return;
        }
        let owner = ownerId === undefined ? undefined : await chrome.windows.get(ownerId).catch(() => undefined);
        if (!owner || owner.id === id || owner.type !== 'normal')
            owner = (await chrome.windows.getAll({ windowTypes: ['normal'] })).find(window => window.id !== id);
        if (!enabled)
            return;
        if (owner?.id !== undefined) {
            await chrome.tabs.move(tab.id, { windowId: owner.id, index: -1 });
            await chrome.tabs.update(tab.id, { active: true });
            await chrome.windows.update(owner.id, { focused: true });
        }
        else
            owner = await chrome.windows.create({ tabId: tab.id, type: 'normal', focused: true });
        if (owner)
            await rememberOwner(owner);
    }
    let routing = Promise.resolve();
    chrome.tabs.onCreated.addListener(tab => {
        if (!enabled)
            return;
        routing = routing.then(() => route(tab)).catch(() => { });
    });
    chrome.tabs.onRemoved.addListener(tab => createdTabs.delete(tab));
    const displays = () => chrome.system.display.getInfo();
    const secondary = (screens) => screens.find(screen => !screen.isPrimary && screen.isEnabled);
    async function place(window, screens, check = () => { }) {
        check();
        const screen = secondary(screens);
        const x = (window.left ?? 0) + (window.width ?? 0) / 2;
        const y = (window.top ?? 0) + (window.height ?? 0) / 2;
        const inside = (area) => x >= area.left && x < area.left + area.width
            && y >= area.top && y < area.top + area.height;
        if (screen) {
            if (!inside(screen.workArea) || window.state === 'minimized')
                await chrome.windows.update(window.id, { state: 'normal', left: screen.workArea.left, top: screen.workArea.top,
                    width: Math.min(1200, screen.workArea.width), height: Math.min(900, screen.workArea.height) });
        }
        else if (window.state !== 'minimized') {
            // Disconnect events can precede Chrome's relocation of off-screen bounds.
            await chrome.windows.update(window.id, { state: 'minimized' });
        }
    }
    async function keepAlive(check) {
        const tabs = await chrome.tabs.query({ windowId: id });
        check();
        if (!tabs.some(isPlaceholder))
            await createTab({ windowId: id, url: placeholderURL, active: false });
        check();
    }
    async function get(check, created) {
        await ready;
        await focusQueue;
        check();
        if (ownerId === undefined) {
            const owner = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => undefined);
            if (owner)
                await rememberOwner(owner);
            check();
        }
        if (id !== undefined) {
            const existing = await chrome.windows.get(id).catch(() => undefined);
            check();
            if (existing?.type === 'normal') {
                await keepAlive(check);
                await place(existing, await displays(), check);
                check();
                return id;
            }
            id = undefined;
        }
        const screens = await displays();
        check();
        const screen = secondary(screens);
        const area = screen?.workArea;
        creatingWindow = chrome.windows.create({ focused: false, type: 'normal', url: placeholderURL,
            ...(area ? { left: area.left, top: area.top, width: Math.min(1200, area.width), height: Math.min(900, area.height) }
                : { state: 'minimized' }) }).then(window => {
            id = window?.id;
            for (const tab of window?.tabs ?? [])
                if (tab.id !== undefined)
                    createdTabs.add(tab.id);
            return window;
        });
        await creatingWindow.finally(() => { creatingWindow = undefined; });
        if (id === undefined)
            throw new Error('Chrome did not create an agent window');
        created?.();
        await chrome.storage.session.set({ [WINDOW_KEY]: id });
        await remember(check);
        check();
        return id;
    }
    async function remember(check) {
        const tabs = await chrome.tabs.query({ windowId: id });
        check();
        const targets = (await chrome.debugger.getTargets()).filter(target => tabs.some(tab => tab.id === target.tabId)).map(target => target.id);
        check();
        await chrome.storage.local.set({ [TARGETS_KEY]: { id, targets } });
    }
    chrome.windows.onRemoved.addListener(removed => {
        void ready.then(async () => {
            if (id !== removed)
                return;
            id = undefined;
            await Promise.all([chrome.storage.session.remove(WINDOW_KEY), chrome.storage.local.remove(TARGETS_KEY)]);
        }).catch(() => { });
    });
    chrome.system.display.onDisplayChanged.addListener(() => {
        void ready.then(async () => {
            if (id === undefined)
                return;
            const window = await chrome.windows.get(id).catch(() => undefined);
            if (window)
                await place(window, await displays());
        }).catch(() => { });
    });
    async function setMode(mode) {
        await ready;
        enabled = mode === 'own';
        await chrome.storage.session.set({ [MODE_KEY]: mode });
    }
    return { get, isPlaceholder, remember, createTab, setMode };
}
