import type { BrowserContext } from 'playwright-core';
import type { FakeDaemon } from './fake-daemon.ts';
import assert from 'node:assert/strict';
import { callsFor } from './extension-types.ts';
import { waitFor } from './fake-daemon.ts';
import { isRecord } from '../../shared/protocol.ts';

export async function visibleChecks({ context, daemon, url, pass }: {
  context: BrowserContext; daemon: FakeDaemon; url: string; pass: (label: string) => void;
}) {
  const call = callsFor(daemon);
  const tab = (await call('chrome.open', { url: `${url}next.html#visible` })).id;
  const page = await waitFor(() => context.pages().find(p => p.url().endsWith('#visible')), 'visible fixture');
  await page.evaluate(() => {
    document.body.innerHTML = `<style>body{height:2200px;margin:0} button{position:absolute;left:40px;width:150px;height:40px}
      #above{top:0} #inside{top:420px} #below{top:1800px}</style>
      <button id="above">Above control</button><button id="inside">Inside control</button><button id="below">Below control</button>
      <span hidden>Hidden words</span><span style="visibility:hidden">Invisible words</span><script type="text/plain">Script words</script>`;
    scrollTo(0, 300);
  });
  const full = await call('chrome.read', { tab });
  const visible = await daemon.call('chrome.read', { tab, visible: true });
  assert.ok(isRecord(visible) && typeof visible.outline === 'string' && typeof visible.text === 'string');
  assert.doesNotMatch(visible.outline, /Above control|Below control/, 'ASSERT_VISIBLE_OUTLINE');
  assert.match(visible.outline, /Inside control/);
  assert.deepEqual(visible.offscreen, { above: 1, below: 1 }, 'ASSERT_VISIBLE_COUNTS');
  assert.equal(visible.text, 'Inside control', 'ASSERT_VISIBLE_TEXT');
  assert.match(full.outline, /Above control/); assert.match(full.outline, /Below control/);
  assert.match(full.text, /Above control/); assert.match(full.text, /Below control/);
  assert.ok(!Object.hasOwn(full, 'offscreen'));
  assert.deepEqual(await call('chrome.read', { tab, visible: false }), full, 'default and explicit false look unchanged');
  assert.ok((await daemon.request('chrome.read', { tab, visible: 'yes' })).error);
  await page.evaluate(() => {
    const inside = document.querySelector('#inside')!; inside.innerHTML = 'con<strong>firm</strong> ';
    const host = document.createElement('span'); inside.append(host); host.attachShadow({ mode: 'open' }).innerHTML = 'Visible label';
  });
  const inline = await daemon.call('chrome.read', { tab, visible: true });
  assert.ok(isRecord(inline));
  assert.equal(inline.text, 'confirm Visible label', 'ASSERT_VISIBLE_INLINE_SHADOW');
  await call('chrome.goto', { tab, url: `${url}large.html` });
  await page.waitForURL(`${url}large.html`, { waitUntil: 'load' });
  await page.evaluate(() => {
    const rows = document.querySelectorAll('.row');
    for (let i = 0; i < rows.length; i += 5) {
      const button = document.createElement('button'); button.textContent = `Action ${i}`; rows[i].append(button);
    }
    scrollTo(0, 0);
  });
  const start = performance.now(), large = await call('chrome.read', { tab });
  const defaultMs = performance.now() - start, next = performance.now();
  const small = await daemon.call('chrome.read', { tab, visible: true });
  const visibleMs = performance.now() - next;
  assert.ok(isRecord(small) && typeof small.text === 'string' && typeof small.outline === 'string');
  const count = await page.evaluate(() => document.getElementsByTagName('*').length);
  console.log(`VISIBLE_LARGE ${JSON.stringify({ elements: count, defaultMs: Math.round(defaultMs), visibleMs: Math.round(visibleMs), defaultText: large.text.length, visibleText: small.text.length, defaultOutline: large.outline.length, visibleOutline: small.outline.length, offscreen: small.offscreen })}`);
  assert.ok(count >= 22000);
  assert.ok(small.text.length < large.text.length / 4 && small.outline.length < large.outline.length / 4, 'ASSERT_VISIBLE_SIZE');
  assert.deepEqual(await call('chrome.read', { tab }), large, 'visible look leaves default output and page state unchanged');
  await call('chrome.close', { tabs: [tab] });
  pass('visible look filters above/inside/below text and controls, preserves default output, reduces large fixture size');
}
