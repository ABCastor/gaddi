// Tabs and popups a page opens from an agent's click in a background tab.
// Chrome brings its window to the front for every tab a page opens, background
// dispositions included (Chrome 153 and later), which pulls the user out of
// the app in use. A tab the extension creates with active:false does not.
// So while an agent's click or key is in flight, the page's request for a new
// tab is caught and handed to the extension, which opens the same address
// behind the user's tab.
//
// Each function below is injected with chrome.scripting.executeScript, so it
// must stay self-contained: no imports, no module-level names.
//
// Invariant: the page never gets a channel to the bridge. It can only leave
// http(s) addresses in this frame's queue while the agent's own input is in
// flight, at most one per armed action as Chrome's popup blocker allows, and
// the extension decides what to open after the input has finished.

/** MAIN world: answer window.open with a background tab instead of a real window. */
export function hookWindowOpen(nonce: string, lifetimeMs: number) {
  const view = window as Window & { __gaddiOpenHook?: { nonce: string; restore(): void } };
  view.__gaddiOpenHook?.restore();
  const original = view.open;
  let used = false;
  const hooked = function (this: Window, url?: string | URL, target?: string, features?: string) {
    const native = () => original.call(this, url, target, features);
    const name = target == null ? '' : String(target);
    // Same-window targets and named frames already on the page stay native.
    if (['_self', '_parent', '_top'].includes(name.toLowerCase())
      || (name && name.toLowerCase() !== '_blank' && [...document.querySelectorAll('iframe,frame')].some(frame => (frame as HTMLIFrameElement).name === name))) return native();
    let href = '';
    try { href = url == null || String(url) === '' ? '' : new URL(String(url), document.baseURI).href; } catch { return native(); }
    // An empty popup is usually written into or pointed somewhere later; only a real one can do that.
    if (!/^https?:/i.test(href)) return native();
    // Chrome allows one popup per click; a second request is blocked, as there.
    if (used) return null;
    used = true;
    window.dispatchEvent(new CustomEvent(`gaddi-open-${nonce}`, { detail: href }));
    // Enough of a window for the usual follow-up calls (focus, checking it opened).
    const stub = { closed: false, opener: null, focus() {}, blur() {}, postMessage() {},
      close() { stub.closed = true; }, location: { href, assign() {}, replace() {}, reload() {}, toString: () => href } };
    return stub as unknown as Window;
  };
  function restore() {
    window.removeEventListener(`gaddi-unhook-${nonce}`, restore);
    if (view.open === hooked) view.open = original;
    if (view.__gaddiOpenHook?.nonce === nonce) delete view.__gaddiOpenHook;
  }
  view.open = hooked;
  view.__gaddiOpenHook = { nonce, restore };
  // collectNewContexts asks for the original back with this event, from its own world.
  window.addEventListener(`gaddi-unhook-${nonce}`, restore, { once: true });
  setTimeout(restore, lifetimeMs);
  return true;
}

/** ISOLATED world: queue new-tab links and the hooked window.open requests of this frame. */
export function armNewContexts(nonce: string, lifetimeMs: number) {
  type Queue = { nonce: string; urls: string[]; stop(): void };
  const scope = globalThis as typeof globalThis & { __gaddiNewContexts?: Queue };
  scope.__gaddiNewContexts?.stop();
  const queue: Queue = { nonce, urls: [], stop };
  const fromPage = (event: Event) => {
    const href = (event as CustomEvent).detail;
    if (typeof href === 'string' && /^https?:/i.test(href) && queue.urls.length === 0) queue.urls.push(href);
  };
  const onClick = (event: MouseEvent) => {
    if (!event.isTrusted || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.composedPath().find((node): node is HTMLAnchorElement | HTMLAreaElement =>
      node instanceof HTMLAnchorElement || node instanceof HTMLAreaElement);
    if (!link || !link.href || link.hasAttribute('download') || !/^https?:/i.test(link.href)) return;
    const name = (link.getAttribute('target') ?? document.querySelector('base[target]')?.getAttribute('target') ?? '').trim();
    const lower = name.toLowerCase();
    if (!name || ['_self', '_parent', '_top'].includes(lower)) return;
    if (lower !== '_blank' && [...document.querySelectorAll('iframe,frame')].some(frame => (frame as HTMLIFrameElement).name === name)) return;
    // Decide after the page's own handlers: a page that handles the click itself keeps it.
    const href = link.href;
    window.addEventListener('click', late => {
      if (late !== event || event.defaultPrevented || queue.urls.length) return;
      event.preventDefault();
      queue.urls.push(href);
    }, { once: true });
  };
  window.addEventListener(`gaddi-open-${nonce}`, fromPage);
  window.addEventListener('click', onClick, true);
  const timer = setTimeout(stop, lifetimeMs);
  function stop() {
    clearTimeout(timer);
    window.removeEventListener(`gaddi-open-${nonce}`, fromPage);
    window.removeEventListener('click', onClick, true);
  }
  scope.__gaddiNewContexts = queue;
  return true;
}

/** ISOLATED world: stop listening and hand over what this frame queued. */
export function collectNewContexts(nonce: string) {
  const scope = globalThis as typeof globalThis & { __gaddiNewContexts?: { nonce: string; urls: string[]; stop(): void } };
  // Put window.open back first: a later call opens natively rather than into a queue nobody reads.
  window.dispatchEvent(new Event(`gaddi-unhook-${nonce}`));
  const queue = scope.__gaddiNewContexts;
  if (!queue || queue.nonce !== nonce) return [];
  queue.stop();
  delete scope.__gaddiNewContexts;
  return queue.urls.slice(0, 1);
}
