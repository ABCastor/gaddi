import assert from 'node:assert/strict';
import type { BrowserContext, Worker } from 'playwright-core';
import type { FakeDaemon } from './fake-daemon.ts';
import { callsFor } from './extension-types.ts';
import { waitFor } from './fake-daemon.ts';

export function instrumentVersion(source: string) {
  return source.replace('function pageVersion() {', 'function pageVersion() { const versionStarted = performance.now();')
    .replace('return `v1-${digest()}`;', 'const value = `v1-${digest()}`; (globalThis.versionCosts ||= []).push(performance.now() - versionStarted); return value;');
}

export async function versionPage({ context, worker, daemon, url, pass }: {
  context: BrowserContext; worker: Worker; daemon: FakeDaemon; url: string; pass: (name: string) => void;
}) {
  const call = callsFor(daemon), failures: string[] = [];
  const tab = (await call('chrome.open', { url: `${url}version.html` })).id;
  const page = await waitFor(() => context.pages().find(page => page.url() === `${url}version.html`), 'version fixture');
  const events = () => page.evaluate('window.versionEvents');
  const reset = async () => { await page.goto(`${url}version.html`); return call('chrome.read', { tab }); };
  async function check(name: string, fn: () => Promise<void>) {
    try { await fn(); pass(name); } catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error}`); }
  }
  try {
    await check('ASSERT_VERSION_ACCEPT', async () => {
      const looked = await reset(), selector = looked.outline.split('\n').find(line => line.startsWith('button "Continue"'))!.split(' ').at(-1);
      assert.equal(typeof looked.version, 'string');
      const result = await call('chrome.click', { tab, selector, version: looked.version });
      assert.equal(result.clicked, true); assert.equal(result.version, looked.version);
      assert.deepEqual(await events(), [{ id: 'target', trusted: true }]);
    });
    await check('ASSERT_VERSION_INSERT', async () => {
      const { version } = await reset();
      await page.evaluate(() => document.body.append(document.createElement('button')));
      const result = await daemon.request('chrome.click', { tab, selector: '#target', version });
      assert.deepEqual(result.error, { code: 'stale', message: 'the page changed since you looked' });
      assert.deepEqual(await events(), [], 'no click event reached the document');
    });
    await check('ASSERT_VERSION_REMOVE', async () => {
      const { version } = await reset(); await page.locator('#link').evaluate(el => el.remove());
      const result = await daemon.request('chrome.click', { tab, selector: '#target', version });
      assert.equal(result.error?.code, 'stale'); assert.deepEqual(await events(), []);
    });
    for (const [name, mutate] of [
      ['TYPING', async (version: string) => {
        const one = await call('chrome.type', { tab, selector: '#field', text: 'one', version });
        assert.equal(one.version, version);
        const two = await call('chrome.type', { tab, selector: '#other', text: 'two', version: one.version });
        assert.equal(two.version, version);
      }],
      ['SCROLL', async (version: string) => { assert.equal((await call('chrome.scroll', { tab, dy: 350, version })).version, version); }],
      ['FOCUS', async () => { await page.locator('#other').focus(); }],
      ['TEXT', async () => { await page.locator('#ticker').evaluate(el => { el.textContent = 'Tick 2'; }); }],
    ] as const) await check(`ASSERT_VERSION_${name}`, async () => {
      const { version } = await reset(); assert.ok(version); await mutate(version);
      assert.equal((await call('chrome.read', { tab })).version, version);
      assert.equal((await call('chrome.click', { tab, selector: '#target', version })).clicked, true);
      assert.deepEqual(await events(), [{ id: 'target', trusted: true }]);
    });
    await check('ASSERT_VERSION_RELOAD', async () => {
      const { version, outline } = await reset();
      const selector = outline.split('\n').find(line => line.startsWith('button \"Continue\"'))!.split(' ').at(-1);
      await page.reload();
      assert.equal((await daemon.request('chrome.click', { tab, selector, version })).error?.code, 'stale');
      assert.deepEqual(await events(), []);
    });
    await check('ASSERT_VERSION_NAVIGATION', async () => {
      const { version } = await reset(); await page.evaluate(() => { location.hash = 'next'; });
      assert.equal((await daemon.request('chrome.click', { tab, selector: '#target', version })).error?.code, 'stale');
      assert.deepEqual(await events(), []);
    });
    await check('ASSERT_VERSION_OPTIONAL', async () => {
      await reset(); await page.evaluate(() => document.body.append(document.createElement('button')));
      assert.equal((await call('chrome.click', { tab, selector: '#target' })).clicked, true);
      assert.equal((await call('chrome.click', { tab, selector: '#target', version: '' })).clicked, true);
      assert.deepEqual(await events(), [{ id: 'target', trusted: true }, { id: 'target', trusted: true }]);
    });
    // Measure the digest itself, excluding injection and the existing signature.
    await page.goto(`${url}large.html`);
    await page.evaluate(() => {
      const controls = document.createElement('div');
      controls.innerHTML = '<button>Control</button>'.repeat(2000); document.body.append(controls);
    });
    const { version } = await call('chrome.read', { tab });
    for (let i = 0; i < 20; i++) await call('chrome.hover', { tab, selector: '#heading', version });
    const costs = await worker.evaluate(async tab => {
      const [result] = await chrome.scripting.executeScript({ target: { tabId: tab }, world: 'ISOLATED',
        func: () => ({ elements: document.getElementsByTagName('*').length,
          ms: (globalThis as unknown as { versionCosts: number[] }).versionCosts }) });
      return result.result!;
    }, tab);
    const samples = costs.ms.slice(1).sort((a, b) => a - b);
    console.log(`VERSION_COST elements=${costs.elements} samples=${samples.length} median_ms=${samples[Math.floor(samples.length / 2)]} p95_ms=${samples[Math.floor(samples.length * .95)]} max_ms=${samples.at(-1)}`);
  } finally { await call('chrome.close', { tabs: [tab] }); }
  if (failures.length) throw new Error(`Version assertions failed: ${failures.join(', ')}`);
}
