import type { BrowserContext } from 'playwright-core';
import type { FakeDaemon } from './fake-daemon.ts';
import { callsFor } from './extension-types.ts';
import { waitFor } from './fake-daemon.ts';
import assert from 'node:assert/strict';

export async function autonomousSetup({ context, daemon, url, pass }: {
  context: BrowserContext; daemon: FakeDaemon; url: string; pass: (name: string) => void;
}) {
  const call = callsFor(daemon);
  const opened = await call('chrome.open', { url: `${url}autonomy.html#settings/Connectors` });
  const tab = opened.id;
  assert.equal(opened.url, `${url}autonomy.html#settings/Apps`, 'ASSERT_APP_REDIRECT');
  const page = await waitFor(() => context.pages().find(page => page.url() === opened.url), 'autonomy fixture');
  const look = await call('chrome.read', { tab });
  const row = look.outline.split('\n').filter(line => line.includes('"ChatGPT plugin"'));
  assert.equal(row.length, 1, 'ASSERT_FLOATING_MENU_REFS');
  assert.ok(!look.outline.includes('Hidden plugin'), 'ASSERT_FLOATING_MENU_REFS');
  await call('chrome.click', { tab, selector: row[0].split(' ').at(-1)! });
  const composer = (await call('chrome.read', { tab })).outline.split('\n').find(line => line.startsWith('textbox "Message"'))!;
  assert.ok(composer, 'ASSERT_APPEND_PRESERVES_CHIP');
  await call('chrome.type', { tab, selector: composer.split(' ').at(-1)!, text: ' wake up', mode: 'append' });
  assert.equal(await page.locator('#composer').textContent(), '@ChatGPT plugin wake up', 'ASSERT_APPEND_PRESERVES_CHIP');
  assert.equal(await page.evaluate(() => document.querySelector('#composer')!.firstChild === (window as unknown as { originalChip: Node }).originalChip), true,
    'ASSERT_APPEND_PRESERVES_CHIP');
  await call('chrome.close', { tabs: [tab] });
  pass('autonomous fixture opens a rewritten fragment route, selects a role-less menu ref and appends after its chip');
}
