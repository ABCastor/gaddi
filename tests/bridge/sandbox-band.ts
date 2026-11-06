import type { BrowserContext } from 'playwright-core';
import type { FakeDaemon } from './fake-daemon.ts';
import assert from 'node:assert/strict';
import { callsFor } from './extension-types.ts';
import { waitFor } from './fake-daemon.ts';

// SANDBOX: the red band, in a real Chrome with the real extension. What the page itself can see and do: the band's host
// and nothing inside it (a closed shadow root), a strip across the top that takes no clicks, and removing or hiding it
// only makes it come back. The broker's checks never read it (tests/fixtures/broker-checks.ts ASSERT_SANDBOX).
export async function sandboxBandChecks({ context, daemon, url, pass }: {
  context: BrowserContext; daemon: FakeDaemon; url: string; pass: (label: string) => void;
}) {
  const call = callsFor(daemon);
  const site = new URL(url).origin;
  const tab = (await call('chrome.open', { url: `${url}next.html#sandbox`, group: '● Sandbox band · tests' })).id;
  const page = await waitFor(() => context.pages().find(p => p.url().endsWith('#sandbox')), 'sandbox band fixture');
  await page.waitForLoadState('load');
  const band = () => page.evaluate(() => {
    const hosts = document.querySelectorAll('gaddi-sandbox-band');
    const host = hosts[0];
    if (!host) return null;
    const box = host.getBoundingClientRect(), style = getComputedStyle(host);
    return { count: hosts.length, closed: host.shadowRoot === null, text: host.textContent, top: box.top, height: box.height, width: box.width, viewport: innerWidth,
      pointer: style.pointerEvents, position: style.position, display: style.display, visibility: style.visibility,
      hit: document.elementFromPoint(20, 8)?.tagName.toLowerCase() };
  });
  const back = (label: string, ready: (state: Awaited<ReturnType<typeof band>>) => boolean) =>
    waitFor(async () => ready(await band()), label, 3000).catch(async () => assert.fail(`${label}: ${JSON.stringify(await band())}`));
  assert.equal(await band(), null, 'ASSERT_SANDBOX_BAND: no band before the site is a sandbox');

  assert.deepEqual(await call('chrome.sandbox', { sandbox: ['https://elsewhere.example', site] }), { sandbox: 2 });
  await back('ASSERT_SANDBOX_BAND: a sandbox page shows the band', state => state !== null);
  const shown = await band();
  assert.ok(shown);
  assert.equal(shown.count, 1);
  assert.equal(shown.closed, true, 'ASSERT_SANDBOX_BAND: the page cannot reach inside the band');
  assert.equal(shown.text, '', 'the band keeps its words out of the page text');
  assert.deepEqual([shown.top, shown.height, shown.position, shown.display, shown.visibility, shown.pointer], [0, 22, 'fixed', 'block', 'visible', 'none'],
    'ASSERT_SANDBOX_BAND: a fixed strip across the top that takes no clicks');
  assert.ok(Math.abs(shown.width - shown.viewport) <= 1, 'the band spans the viewport');
  assert.notEqual(shown.hit, 'gaddi-sandbox-band', 'a click on the band reaches the page beneath it');
  pass('SANDBOX: a sandbox page shows a closed, non-interactive red band across the top');

  await page.evaluate(() => document.querySelector('gaddi-sandbox-band')!.remove());
  await back('ASSERT_SANDBOX_BAND_RETURNS: a band the page removed comes back', state => state?.count === 1);
  await page.evaluate(() => document.querySelector('gaddi-sandbox-band')!.setAttribute('style', 'display: none'));
  await back('ASSERT_SANDBOX_BAND_RETURNS: a band the page hid comes back', state => state?.display === 'block');
  await page.evaluate(() => {
    const sheet = document.createElement('style');
    sheet.textContent = 'gaddi-sandbox-band { display: none !important; visibility: hidden !important; }';
    document.head.append(sheet);
  });
  assert.deepEqual(await band().then(state => [state?.display, state?.visibility]), ['block', 'visible'], 'ASSERT_SANDBOX_BAND: a page stylesheet cannot hide it');
  pass('SANDBOX: removing, restyling or hiding the band from the page puts it back');

  await call('chrome.goto', { tab, url: `${url}next.html?again#sandbox` });
  await page.waitForLoadState('load');
  await back('ASSERT_SANDBOX_BAND: a new page of the sandbox shows the band again', state => state?.count === 1);
  await call('chrome.sandbox', { sandbox: ['https://elsewhere.example'] });
  await back('ASSERT_SANDBOX_BAND: a page that is no longer a sandbox loses its band', state => state === null);
  await call('chrome.sandbox', { sandbox: [site] });
  await back('ASSERT_SANDBOX_BAND: turning it on again draws it again', state => state?.count === 1);
  await call('chrome.sandbox', { sandbox: [] });
  await back('ASSERT_SANDBOX_BAND: no sandbox, no band', state => state === null);
  await call('chrome.close', { tabs: [tab] });
  pass('SANDBOX: the band follows the broker list across navigation, change and removal');
}
