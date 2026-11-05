import type { BrowserContext, Worker } from 'playwright-core';
import type { FakeDaemon } from './fake-daemon.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { callsFor } from './extension-types.ts';
import { waitFor } from './fake-daemon.ts';

// Chrome raises its window for any tab a page opens, so a background agent click
// must open the page's new tab itself, behind the owner's tab (extension/popups.ts).
export async function newContexts({ context, worker, daemon, url, pass }: {
  context: BrowserContext; worker: Worker; daemon: FakeDaemon; url: string; pass: (label: string) => void;
}) {
  const call = callsFor(daemon);
  const tabInfo = (id: number) => worker.evaluate(id => chrome.tabs.get(id), id);
  const activeIn = (windowId: number) => worker.evaluate(windowId => chrome.tabs.query({ active: true, windowId }).then(tabs => tabs[0]?.id), windowId);
  const owner = await call('chrome.open', { url: `${url}next.html?owner`, foreground: true });
  await call('chrome.show', { tab: owner.id });
  const tab = (await call('chrome.open', { url: `${url}popups.html` })).id;
  const page = await waitFor(() => context.pages().find(page => page.url().endsWith('/popups.html')), 'popups fixture');
  const { windowId, groupId } = await tabInfo(tab);
  const windows = (await worker.evaluate(() => chrome.windows.getAll())).length;
  for (const [selector, path] of [['#blank-link', 'next.html?from=link'], ['#open-button', 'next.html?from=open']] as const) {
    const result = await call('chrome.click', { tab, selector }) as { changed: boolean; opened?: { tab: number; url: string }[] };
    assert.equal(result.opened?.length, 1, `ASSERT_POPUP_BACKGROUND: ${selector} opens its page through Gaddi`);
    assert.equal(result.opened![0].url, `${url}${path}`, `ASSERT_POPUP_BACKGROUND: ${selector} keeps the page's address`);
    assert.equal(result.changed, true, `${selector} reports that something happened`);
    const created = await tabInfo(result.opened![0].tab);
    assert.equal(created.active, false, `ASSERT_POPUP_BACKGROUND: ${selector} opens behind the owner's tab`);
    assert.equal(created.windowId, windowId, `${selector} opens beside its page`);
    assert.equal(created.groupId, groupId, `${selector} joins its page's agent group`);
    assert.equal(await activeIn(windowId), owner.id, `ASSERT_POPUP_BACKGROUND: ${selector} leaves the owner's tab selected`);
    await call('chrome.close', { tabs: [result.opened![0].tab] });
  }
  assert.equal(await page.evaluate('window.openResult'), 'object', 'the page still gets a window back from window.open');
  assert.equal((await worker.evaluate(() => chrome.windows.getAll())).length, windows, 'a popup request never becomes a window');
  pass('background click: a new-tab link and a window.open popup open as background tabs in the agent group; the owner tab stays selected');

  await page.locator('#blank-link').evaluate(link => (link as HTMLElement).focus());
  const pressed = await call('chrome.press', { tab, key: 'Enter' }) as { opened?: { tab: number; url: string }[] };
  assert.equal(pressed.opened?.[0]?.url, `${url}next.html?from=link`, 'ASSERT_POPUP_BACKGROUND: Enter on a new-tab link opens it behind the owner tab');
  assert.equal((await tabInfo(pressed.opened![0].tab)).active, false);
  await call('chrome.close', { tabs: [pressed.opened![0].tab] });
  const two = await call('chrome.click', { tab, selector: '#second-open' }) as { opened?: { tab: number; url: string }[] };
  assert.deepEqual(two.opened?.map(entry => entry.url), [`${url}next.html?from=first`], 'one popup per click, as Chrome allows');
  assert.deepEqual(await page.evaluate('window.openResults'), ['object', 'null'], 'a second popup is refused like Chrome refuses it');
  await call('chrome.close', { tabs: two.opened!.map(entry => entry.tab) });
  const handled = await call('chrome.click', { tab, selector: '#handled-link' }) as { opened?: unknown };
  assert.equal(handled.opened, undefined, 'a link the page handles itself opens nothing');
  assert.equal(await page.evaluate('window.handled'), true);
  pass('background Enter on a new-tab link opens it behind the owner tab');
  pass('background click: one popup per click; a page that handles its own link keeps it');

  // This browser has no download directory of its own; keep the fixture file out of ~/Downloads.
  const downloads = fs.mkdtempSync(path.join(os.tmpdir(), 'gaddi-popup-downloads-'));
  const cdp = await context.browser()!.newBrowserCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
  const before = (await worker.evaluate(() => chrome.tabs.query({}))).length;
  const download = await call('chrome.click', { tab, selector: '#download-link' }) as { opened?: { tab: number }[] };
  assert.equal(download.opened?.length, 1, 'a new-tab download goes through a background tab');
  await waitFor(async () => (await worker.evaluate(() => chrome.tabs.query({}))).length === before, 'download tab closes by itself', 5000);
  await waitFor(() => fs.readdirSync(downloads).includes('gaddi-fixture.bin'), 'fixture download arrives', 5000);
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'default' });
  fs.rmSync(downloads, { recursive: true, force: true }); // Disposable test directory.
  pass('background click: a new-tab download completes behind the owner tab and leaves no tab behind');

  const self = await call('chrome.click', { tab, selector: '#self-link' }) as { opened?: unknown };
  assert.equal(self.opened, undefined, 'a same-tab link is untouched');
  await waitFor(() => page.url().endsWith('from=self'), 'same-tab link navigates');
  pass('background click: same-tab links behave as before');
  await call('chrome.close', { tabs: [tab, owner.id] });
}
