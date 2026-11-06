// extension/sandbox.ts — SANDBOX: the red band on every page of a sandbox site (docs/authorization.md).
// The band is display only. Why: the user, watching their own Chrome, must see where agents may pay, buy and send
// without asking. The broker never reads it: what agents are allowed comes from its policy, and `look` carries
// `sandbox` from the broker, so a page that hides the band cannot hide the sandbox from agents either.

// Which sandbox a top-level page belongs to, for the band's words. It mirrors daemon/grants.ts:sandboxCovers for display
// only (the broker's own check also applies the refused hosts and the user's protected addresses).
const STRIPE_TEST = /^\/c\/pay\/cs_test_[A-Za-z0-9]+\/?$/;
export function sandboxSite(url: string | undefined, sites: readonly string[]): string | undefined {
  if (!url || !sites.length) return undefined;
  try {
    const page = new URL(url);
    if (page.username || page.password) return undefined;
    if (sites.includes(page.origin)) return page.origin;
    if (page.origin === 'https://checkout.stripe.com' && STRIPE_TEST.test(page.pathname)) return 'Stripe test mode';
  } catch { /* Not an address: no band. */ }
  return undefined;
}

// Runs in the page's isolated world, so it must be self-contained. With a label it draws the band (replacing an older
// one); with null it removes it. The band lives in a closed shadow root on a host whose inline style is !important,
// takes no pointer events, and is put back whenever the page removes or restyles it.
export function sandboxBand(label: string | null): boolean {
  const KEY = '__gaddiSandboxBand';
  const scope = globalThis as unknown as Record<string, { stop(): void } | undefined>;
  scope[KEY]?.stop();
  delete scope[KEY];
  if (!label) return false;
  const host = document.createElement('gaddi-sandbox-band');
  const style = ['all: initial', 'display: block', 'position: fixed', 'top: 0', 'left: 0', 'right: 0', 'width: 100%', 'height: 22px',
    'z-index: 2147483647', 'pointer-events: none', 'visibility: visible', 'opacity: 1', 'transform: none', 'clip-path: none',
    'filter: none', 'margin: 0', 'padding: 0'].map(rule => `${rule} !important`).join('; ');
  host.setAttribute('style', style);
  const root = host.attachShadow({ mode: 'closed' });
  const band = document.createElement('div');
  band.setAttribute('style', 'box-sizing: border-box; width: 100%; height: 22px; background: #c62828; color: #fff; text-align: center;'
    + ' font: 600 12px/22px -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif; letter-spacing: 0.02em;'
    + ' white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding: 0 8px; user-select: none;');
  band.textContent = `SANDBOX · ${label} · agents may pay, buy and send here without asking`;
  root.append(band);
  const reassert = () => {
    if (host.getAttribute('style') !== style) host.setAttribute('style', style);
    const top = document.documentElement;
    if (top && host.parentNode !== top) top.append(host);
  };
  const observer = new MutationObserver(reassert);
  const watch = () => {
    observer.disconnect();
    if (document.documentElement) observer.observe(document.documentElement, { childList: true });
    observer.observe(host, { attributes: true });
  };
  reassert(); watch();
  // A backstop for what the observer cannot see, such as the page replacing its whole document element.
  const timer = setInterval(() => { if (host.parentNode !== document.documentElement) { reassert(); watch(); } }, 1000);
  scope[KEY] = { stop() { observer.disconnect(); clearInterval(timer); host.remove(); } };
  return true;
}
