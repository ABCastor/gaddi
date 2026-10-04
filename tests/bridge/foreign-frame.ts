import type { BrowserContext, Page, Worker } from 'playwright-core';
import type { FakeDaemon } from './fake-daemon.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { callsFor } from './extension-types.ts';
import { waitFor } from './fake-daemon.ts';

const FOREIGN_FRAME = 'Cannot access a chrome-extension:// URL of different extension';
type PageEvent = { type: string; target: string; key?: string; keyCode?: number; inputType?: string; trusted: boolean };

// A test-only stand-in for a password manager's inline menu: a field marked data-menu that
// receives focus gets a chrome-extension:// frame from another extension under it, inside a
// closed shadow root. It stays open when focus leaves (1Password's did, live, 23 Sep 2026)
// until a trusted Escape or focus on another such field. ?persistent opens on load and
// ignores focus, like 1Password's sign-in options popover; ?sticky opens on field input.
// Serialized into the disposable extension, so it must stay self-contained.
function inject() {
  if (!location.pathname.endsWith('/foreign.html')) return;
  let host: HTMLElement | undefined, field: Element | null | undefined;
  const persistent = location.search.includes('persistent');
  const sticky = location.search.includes('sticky');
  function hide() { host?.remove(); host = field = undefined; }
  function show(anchor: Element | null) {
    if (host && field === anchor) return;
    hide();
    field = anchor;
    host = document.createElement('foreign-menu');
    const frame = document.createElement('iframe');
    frame.src = chrome.runtime.getURL('menu.html');
    const box = anchor ? anchor.getBoundingClientRect() : { left: innerWidth - 240, bottom: innerHeight - 100 };
    frame.style.cssText = `position:absolute;left:${box.left + scrollX}px;top:${box.bottom + scrollY + 2}px;width:220px;height:90px;border:1px solid #c79;z-index:2147483647`;
    host.attachShadow({ mode: 'closed' }).append(frame);
    document.documentElement.append(host);
  }
  const marked = (el: unknown): el is Element => el instanceof Element && el.matches('[data-menu]');
  if (persistent) {
    show(null);
    // The test reopens it before each action (the page's own scripts cannot reach this world).
    document.addEventListener('foreign-reopen', () => { hide(); show(null); });
    return;
  }
  if (sticky) {
    document.addEventListener('input', event => { if (marked(event.target) && !host) show(event.target); }, true);
    return;
  }
  document.addEventListener('focusin', event => { if (marked(event.target)) show(event.target); }, true);
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && event.isTrusted) hide(); }, true);
}
export function writeForeignExtension(root: string) {
  const dir = path.join(root, 'foreign-extension');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    manifest_version: 3, name: 'Foreign frame fixture', version: '1',
    content_scripts: [{ matches: ['http://127.0.0.1/foreign.html*'], js: ['inject.js'], run_at: 'document_idle' }],
    web_accessible_resources: [{ resources: ['menu.html'], matches: ['<all_urls>'] }],
  }));
  fs.writeFileSync(path.join(dir, 'menu.html'), '<!doctype html><meta charset="utf-8"><title>Foreign menu</title><body style="margin:0;background:#fde8f0">Stand-in suggestions</body>');
  fs.writeFileSync(path.join(dir, 'inject.js'), `(${inject.toString()})();\n`);
  return dir;
}

export async function foreignFrame({ context, worker, daemon, url, pass }: {
  context: BrowserContext; worker: Worker; daemon: FakeDaemon; url: string; pass: (label: string) => void;
}) {
  const call = callsFor(daemon);
  const open = async (suffix: string, foreground = false) => {
    const tab = (await call('chrome.open', { url: `${url}foreign.html${suffix}`, foreground })).id;
    const page = await waitFor(() => context.pages().find(page => page.url() === `${url}foreign.html${suffix}`), `foreign fixture ${suffix}`);
    return { tab, page };
  };
  const hasFrame = (page: Page) => page.frames().some(frame => frame.url().startsWith('chrome-extension://'));
  // Chrome's rule applies once the other extension's page has committed in the frame;
  // a hidden tab can take a second or more to get there.
  const menuShown = (page: Page) => waitFor(() => hasFrame(page), 'foreign menu frame committed', 8000);
  const menuGone = (page: Page) => waitFor(() => !hasFrame(page), 'foreign menu frame removed', 3000);
  // Someone other than Gaddi focuses a field (the person, or the page's own autofocus). A
  // hidden page gets no focus event from the browser, so the test supplies the one a
  // focused window would have produced.
  const focusField = async (page: Page, selector: string) => {
    await page.evaluate(selector => {
      const el = document.querySelector<HTMLElement>(selector)!;
      el.focus(); el.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    }, selector);
    await menuShown(page);
  };
  const attachError = (tab: number) => worker.evaluate(async tabId => {
    try { await chrome.debugger.attach({ tabId }, '1.3'); await chrome.debugger.detach({ tabId }); return ''; }
    catch (error) { return error instanceof Error ? error.message : String(error); }
  }, tab);
  const events = (page: Page, from: number) => page.evaluate(from => (window as unknown as { events: PageEvent[] }).events.slice(from), from);
  const eventCount = (page: Page) => page.evaluate(() => (window as unknown as { events: PageEvent[] }).events.length);
  const note = (reply: { result?: unknown }) => String((reply.result as { note?: unknown } | undefined)?.note ?? '');

  // A menu like 1Password's sign-in options: open from page load, deaf to focus and Escape.
  {
    const { tab, page } = await open('?persistent');
    await menuShown(page);
    assert.equal(await attachError(tab), FOREIGN_FRAME, 'ASSERT_FOREIGN_ROOT_CAUSE: Chrome refuses the debugger while another extension frames the tab');
    pass('root cause reproduced: another extension\'s frame in the page makes Chrome refuse chrome.debugger for the whole tab');
    const shot = await daemon.request('chrome.screenshot', { tab });
    assert.equal(shot.error, undefined, `ASSERT_FOREIGN_REMOVE: ${JSON.stringify(shot.error)}`);
    assert.equal(Buffer.from((shot.result as { data: string }).data, 'base64').subarray(0, 3).toString('hex'), 'ffd8ff', 'ASSERT_FOREIGN_REMOVE');
    assert.match(note(shot), /Removed another extension's frame/, 'ASSERT_FOREIGN_REMOVE');
    await menuGone(page);
    assert.ok(await page.evaluate(() => !!document.querySelector('foreign-menu')), 'only the frame goes; the other extension\'s own element stays');
    const reopen = async () => { await page.evaluate(() => document.dispatchEvent(new CustomEvent('foreign-reopen'))); await menuShown(page); };
    await reopen();
    assert.equal((await call('chrome.eval', { tab, expression: '6 * 7' })).value, 42, 'ASSERT_FOREIGN_REMOVE: eval');
    await reopen();
    const scrolled = await daemon.request('chrome.scroll', { tab, dy: 400 });
    assert.equal(scrolled.error, undefined, `ASSERT_FOREIGN_REMOVE: scroll ${JSON.stringify(scrolled.error)}`);
    assert.ok(await page.evaluate(() => scrollY) > 0, 'ASSERT_FOREIGN_REMOVE: the wheel scroll moved the page');
    const visiblePage = await call('chrome.read', { tab });
    assert.ok(!visiblePage.text.includes('Stand-in suggestions'), 'Gaddi never reads the foreign menu content');
    await page.evaluate(() => {
      const button = document.createElement('button'); button.id = 'trusted-only'; button.textContent = 'Trusted only';
      button.onclick = event => { if (event.isTrusted) document.querySelector('#status')!.textContent = 'Trusted accepted'; };
      document.querySelector('#form')!.prepend(button);
    });
    await reopen();
    const from = await eventCount(page);
    await call('chrome.click', { tab, selector: '#trusted-only' });
    assert.equal(await page.locator('#status').textContent(), 'Trusted accepted', 'ASSERT_FOREIGN_REMOVE: a trusted-only control accepts the click');
    assert.ok((await events(page, from)).some(e => e.type === 'mousedown' && e.target === 'trusted-only' && e.trusted), 'the click is a real pointer sequence');
    assert.equal(await attachError(tab), '', 'ASSERT_FOREIGN_NO_LINGERING: no Gaddi session is left attached');
    await call('chrome.close', { tabs: [tab] });
    pass('a menu open from page load is removed: screenshot, eval, wheel scroll and a trusted click all work, and nothing is read from it');
  }

  // A menu that opens whenever its field gets focus, in a background agent tab.
  const { tab, page } = await open('');
  assert.equal(await attachError(tab), '', 'fixture starts without a foreign frame');
  let from = await eventCount(page);
  const typed = await daemon.request('chrome.type', { tab, selector: '#email', text: 'owner@example.test' });
  assert.equal(typed.error, undefined, `ASSERT_FOREIGN_TYPE: ${JSON.stringify(typed.error)}`);
  assert.equal(await page.locator('#email').inputValue(), 'owner@example.test', 'ASSERT_FOREIGN_TYPE: text reaches the field');
  assert.ok((await events(page, from)).some(e => e.type === 'input' && e.target === 'email' && e.trusted), 'ASSERT_FOREIGN_TYPE: typed with trusted input');
  // Focusing the field opens the frame again each time, often while the text is in flight.
  for (const text of ['', 'second@example.test', 'owner@example.test']) {
    await call('chrome.type', { tab, selector: '#email', text });
    assert.equal(await page.locator('#email').inputValue(), text, 'ASSERT_FOREIGN_TYPE: every retype lands exactly once');
  }
  const refused = await daemon.request('chrome.type', { tab, selector: '#email', text: 'stale', version: 'v1-0' });
  assert.equal(refused.error?.code, 'stale', 'the page-version check still applies');
  assert.equal(await page.locator('#email').inputValue(), 'owner@example.test');
  pass('type into a field whose focus opens another extension\'s frame lands once, with trusted input');

  await focusField(page, '#org');
  from = await eventCount(page);
  await call('chrome.press', { tab, key: 'Escape' });
  assert.ok((await events(page, from)).some(e => e.type === 'keydown' && e.key === 'Escape' && e.target === 'org' && e.trusted), 'ASSERT_FOREIGN_PRESS: the key is trusted');
  assert.equal(await page.locator('#status').textContent(), 'Escaped', 'ASSERT_FOREIGN_PRESS: the page handles the key');
  await focusField(page, '#email');
  from = await eventCount(page);
  await call('chrome.click', { tab, selector: '#save' });
  assert.equal(await page.locator('#status').textContent(), 'Saved', 'ASSERT_FOREIGN_CLICK: the click lands');
  assert.ok((await events(page, from)).some(e => e.type === 'click' && e.target === 'save' && e.trusted), 'ASSERT_FOREIGN_CLICK: the click is trusted input');
  await call('chrome.select', { tab, selector: '#plan', value: 'pro' });
  assert.equal(await page.locator('#plan').inputValue(), 'pro');
  await focusField(page, '#org');
  await call('chrome.goto', { tab, url: `${url}next.html` });
  assert.match((await call('chrome.read', { tab })).text, /Navigation worked/, 'ASSERT_FOREIGN_GOTO');
  assert.equal(await attachError(tab), '', 'ASSERT_FOREIGN_NO_LINGERING: no Gaddi session is left attached');
  await call('chrome.close', { tabs: [tab] });
  pass('press, click, select and goto work with trusted input while such a menu is open, and leave no session attached');

  // Chrome freezes background tabs, and waking one needs the debugger such a frame blocks.
  {
    const cold = await open('#frozen');
    const freeze = async () => {
      const freezer = await context.newCDPSession(cold.page);
      await freezer.send('Page.setWebLifecycleState', { state: 'frozen' });
      await waitFor(async () => (await worker.evaluate(id => chrome.tabs.get(id), cold.tab)).frozen === true, 'Chrome reports the frozen tab');
      await freezer.detach();
    };
    await focusField(cold.page, '#email');
    await call('chrome.type', { tab: cold.tab, selector: '#email', text: 'owner@example.test' });
    await menuGone(cold.page);
    await freeze();
    const woke = await daemon.request('chrome.read', { tab: cold.tab });
    assert.equal(woke.error, undefined, `ASSERT_FOREIGN_FROZEN_PREVENTED: ${JSON.stringify(woke.error)}`);
    await focusField(cold.page, '#org');
    await freeze();
    const stuck = await daemon.request('chrome.read', { tab: cold.tab });
    assert.match(stuck.error?.message || '', /Chrome has frozen this background tab/, `ASSERT_FOREIGN_FROZEN_REPORTED: ${JSON.stringify(stuck)}`);
    await call('chrome.close', { tabs: [cold.tab] });
  }
  pass('after meeting such a frame in a background tab Gaddi removes it, so the tab still wakes when frozen; a tab frozen with a frame someone else opened gets a precise reason');

  // A tab someone has in front, with the menu they opened, and a menu that outlives typing.
  for (const [suffix, foreground] of [['#person', true], ['?sticky', false]] as const) {
    const { tab, page } = await open(suffix, foreground);
    if (foreground) await focusField(page, '#email');
    else {
      // The menu opens on the typed text itself, often while the insert is in flight.
      await call('chrome.type', { tab, selector: '#email', text: 'owner@example.test' });
      assert.equal(await page.locator('#email').inputValue(), 'owner@example.test', 'ASSERT_FOREIGN_TYPE: text opening the menu lands once');
      await menuGone(page);
    }
    from = await eventCount(page);
    await call('chrome.click', { tab, selector: '#save' });
    assert.equal(await page.locator('#status').textContent(), 'Saved', 'ASSERT_FOREIGN_CLICK');
    assert.ok((await events(page, from)).some(e => e.type === 'click' && e.target === 'save' && e.trusted), 'ASSERT_FOREIGN_CLICK');
    await page.evaluate(() => {
      const input = document.createElement('input'); input.type = 'password'; input.id = 'secret';
      document.body.prepend(input);
    });
    assert.match((await daemon.request('chrome.type', { tab, selector: '#secret', text: 'must-not-land' })).error?.message || '', /password/);
    assert.equal(await page.locator('#secret').inputValue(), '');
    await call('chrome.close', { tabs: [tab] });
  }
  pass('in a tab in front and under a menu that ignores focus loss, clicks are trusted and password guards hold');
}
