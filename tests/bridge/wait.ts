import type { BrowserContext, Worker } from 'playwright-core';
import type { FakeDaemon } from './fake-daemon.ts';
import assert from 'node:assert/strict';
import { callsFor } from './extension-types.ts';
import { waitFor } from './fake-daemon.ts';
import { isRecord } from '../../shared/protocol.ts';

export async function waitChecks({ context, worker, daemon, url, pass }: {
  context: BrowserContext; worker: Worker; daemon: FakeDaemon; url: string; pass: (label: string) => void;
}) {
  const call = callsFor(daemon), foreground = await call('chrome.active');
  const tab = (await call('chrome.open', { url: `${url}next.html#wait` })).id;
  const page = await waitFor(() => context.pages().find(p => p.url().endsWith('#wait')), 'wait fixture');
  const wait = async (params: Record<string, unknown>) => {
    const result = await daemon.call('chrome.wait', { tab, ...params });
    assert.ok(isRecord(result) && typeof result.met === 'boolean' && typeof result.ms === 'number' && typeof result.url === 'string');
    return result as { met: boolean; ms: number; url: string };
  };
  assert.equal(await page.evaluate(() => document.hidden), true, 'ASSERT_WAIT_NATIVE_BACKGROUND');
  await page.evaluate(() => {
    document.body.innerHTML = '<div id="target">Waiting</div>';
    Object.assign(window, { waitFrames: 0 });
    requestAnimationFrame(() => { (window as unknown as { waitFrames: number }).waitFrames++; });
  });
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(await page.evaluate('window.waitFrames'), 0, 'native background has no frames without emulation');
  for (const kind of ['timer', 'frame']) {
    await page.evaluate(kind => {
      document.querySelector('#target')!.textContent = 'Waiting';
      if (kind === 'timer') setTimeout(() => { document.querySelector('#target')!.textContent = 'READY timer'; }, 500);
      else {
        const end = performance.now() + 500;
        function frame() { if (performance.now() >= end) document.querySelector('#target')!.textContent = 'READY frame'; else requestAnimationFrame(frame); }
        requestAnimationFrame(frame);
      }
    }, kind);
    const result = await wait({ text: `ready ${kind}`, timeout: 1800 });
    console.log(`WAIT_BACKGROUND ${kind} ${JSON.stringify(result)}`);
    assert.equal(result.met, true, `ASSERT_WAIT_${kind.toUpperCase()}`);
    assert.ok(result.ms >= 350 && result.ms < 1500, `ASSERT_WAIT_TIMING ${result.ms}`);
    assert.equal(await page.evaluate(() => document.hidden), true, 'focus emulation cleaned after wait');
    assert.equal((await call('chrome.active')).id, foreground.id, 'wait never activates tab');
  }
  const outline = (await call('chrome.read', { tab })).outline;
  // Both CSS and look references use the same isolated-world nodes.
  await page.evaluate(() => { document.body.insertAdjacentHTML('beforeend', '<button id="remove">Remove me</button>'); });
  const ref = (await call('chrome.read', { tab })).outline.match(/button "Remove me" (\S+)/)![1];
  assert.equal((await wait({ selector: ref, timeout: 0 })).met, true);
  await page.evaluate(() => setTimeout(() => document.querySelector('#remove')!.remove(), 500));
  assert.equal((await wait({ selector: ref, gone: true, timeout: 1600 })).met, true);
  assert.equal((await wait({ selector: '#remove', gone: true, timeout: 0 })).met, true);
  await page.evaluate(() => { document.body.insertAdjacentHTML('beforeend', '<div hidden>secret hidden token</div><script type="text/plain">script secret token</script>'); });
  assert.equal((await wait({ text: 'secret hidden token', timeout: 120 })).met, false);
  assert.equal((await wait({ text: 'script secret token', timeout: 120 })).met, false);
  await page.evaluate(() => { document.body.insertAdjacentHTML('beforeend', '<div>Ready <span hidden>x</span>now</div><div>Across</div><div>blocks</div><div>Line<br>break</div><div><span>Inline</span> <span>space</span></div><span style="display:contents;visibility:hidden">contents secret</span><span>İİİİİİİİ</span><span hidden>unicode secret</span>'); });
  assert.equal((await wait({ text: 'ready now', timeout: 0 })).met, true, 'ASSERT_WAIT_VISIBLE_TEXT');
  assert.equal((await wait({ text: 'across blocks', timeout: 0 })).met, true);
  assert.equal((await wait({ text: 'inline space', timeout: 0 })).met, true);
  assert.equal((await wait({ text: 'line break', timeout: 0 })).met, true);
  assert.equal((await wait({ text: 'contents secret', timeout: 100 })).met, false);
  assert.equal((await wait({ text: 'unicode secret', timeout: 100 })).met, false);
  const timeout = await wait({ selector: '#missing', timeout: 350 });
  assert.equal(timeout.met, false, 'ASSERT_WAIT_TIMEOUT');
  assert.ok(timeout.ms >= 330 && timeout.ms < 800);
  console.log(`WAIT_TIMEOUT ${JSON.stringify(timeout)}`);
  await page.evaluate(() => setTimeout(() => document.body.insertAdjacentHTML('beforeend', '<span>late arrival</span>'), 180));
  assert.equal((await wait({ text: 'late arrival', timeout: 200 })).met, true, 'ASSERT_WAIT_FINAL_CHECK');
  for (const params of [{}, { text: 'x', selector: 'div' }, { text: '' }, { text: 'x', timeout: 20001 }, { url: 'x', gone: true }, { selector: '[' }]) {
    assert.ok((await daemon.request('chrome.wait', { tab, ...params })).error, `invalid wait: ${JSON.stringify(params)}`);
  }
  for (const kind of ['url', 'text', 'selector']) {
    await page.evaluate(url => setTimeout(() => { location.href = url; }, 300), `${url}next.html?wait=${kind}#${kind}-arrived`);
    const params = kind === 'url' ? { url: '#url-arrived' } : kind === 'text' ? { text: 'Navigation worked' } : { selector: 'h1' };
    // Ensure DOM predicates cannot match the previous document.
    await page.evaluate(() => { document.body.innerHTML = '<div>before navigation</div>'; });
    const result = await wait({ ...params, timeout: 2500 });
    console.log(`WAIT_NAVIGATION ${kind} ${JSON.stringify(result)}`);
    assert.equal(result.met, true, `ASSERT_WAIT_NAVIGATION_${kind}`);
    assert.ok(result.url.endsWith(`#${kind}-arrived`));
    await page.waitForURL(`${url}next.html?wait=${kind}#${kind}-arrived`, { waitUntil: 'load' });
  }
  await call('chrome.goto', { tab, url: `${url}large.html` });
  await page.waitForURL(`${url}large.html`, { waitUntil: 'load' });
  await page.evaluate(() => { document.body.insertAdjacentHTML('beforeend', '<span hidden>hidden needle</span>'); });
  const costs: number[] = [];
  await worker.evaluate(tab => {
    Object.assign(globalThis, { waitCosts: [] });
    const execute = chrome.scripting.executeScript.bind(chrome.scripting);
    Object.assign(globalThis, { restoreWaitProbe() { chrome.scripting.executeScript = execute; } });
    chrome.scripting.executeScript = async options => {
      const result = await execute(options);
      if (options.target.tabId === tab && 'args' in options && options.args?.[0] === 'wait') {
        const [probe] = await execute({ target: { tabId: tab }, world: 'ISOLATED', func: () => (globalThis as unknown as { waitCheckCosts?: number[] }).waitCheckCosts });
        Object.assign(globalThis, { waitCosts: probe.result });
      }
      return result;
    };
  }, tab);
  try {
    assert.equal((await wait({ text: 'hidden needle', timeout: 550 })).met, false);
    costs.push(...await worker.evaluate(async tab => {
      const [probe] = await chrome.scripting.executeScript({ target: { tabId: tab }, world: 'ISOLATED', func: () => (globalThis as unknown as { waitCheckCosts: number[] }).waitCheckCosts });
      return probe.result!;
    }, tab));
    console.log(`WAIT_LARGE checks=${costs.length} maxMs=${Math.max(...costs)} all=${JSON.stringify(costs)}`);
    const reads = await worker.evaluate(async tab => {
      const [probe] = await chrome.scripting.executeScript({ target: { tabId: tab }, world: 'ISOLATED', func: () => (globalThis as unknown as { waitTextReads: number }).waitTextReads });
      return probe.result!;
    }, tab);
    assert.ok(reads < costs.length, 'ASSERT_WAIT_CACHE: rendered text is not read on every check');
    assert.ok(costs.length >= 2);
    assert.ok(Math.max(...costs) < 100, 'ASSERT_WAIT_LARGE_CYCLE');
  } finally { await worker.evaluate('globalThis.restoreWaitProbe()'); }
  await call('chrome.close', { tabs: [tab] });
  pass('wait covers native timers/frames, references/gone, timeout, validation, navigation and large-page checks under100ms');
}
