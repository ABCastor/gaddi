import type { BrowserContext, Worker } from 'playwright-core';
import type { FakeDaemon } from './fake-daemon.ts';
import assert from 'node:assert/strict';
import { callsFor } from './extension-types.ts';
import { waitFor } from './fake-daemon.ts';
import { pageTask } from '../../extension/content.ts';

// Generated per request: roughly 20,000 elements and 300,000 text characters.
export function largeFixture() {
  return `<!doctype html><title>Large page</title><style>
    h1 { margin: 0; } .row { height: 20px; } #noop, #toggle { height: 40px; }
  </style><h1 id="heading">Large unchanged heading</h1>
  ${'<div class="row"><span>Thirty characters of page text.</span></div>'.repeat(10000)}
  <div id="noop" onclick="void 0">No operation</div>
  <div id="toggle" aria-expanded="false" onclick="this.setAttribute('aria-expanded', this.getAttribute('aria-expanded') !== 'true')">Toggle</div>
  <script>window.largeEvents = []; document.addEventListener('click', e => largeEvents.push({id:e.target.id,trusted:e.isTrusted}));</script>`;
}

// Timing probes are inserted only into the disposable extension copy, never the
// shipped source. Page timings use the isolated world and export no page values.
export function instrumentLargeSignature(source: string) {
  const start = 'function signature() {';
  const end = 'return `${performance.timeOrigin}:${hash >>> 0}`;';
  assert.ok(source.includes(start) && source.includes(end));
  return source.replace('try {', `try {
    if (location.pathname === '/large.html') {
      globalThis.largeTiming ||= { signatures: [], stages: [], frameAt: 0 };
      if (action === 'clickPoint' || action === 'hoverPoint')
        requestAnimationFrame(() => { globalThis.largeTiming.frameAt ||= Date.now(); });
    }`).replace(start, start + '\nconst signatureStart = performance.now();')
    .replace('function walk(root) {', 'function walk(root) { const walkStart = performance.now();')
    .replace('add((root === document ? document.body : root)?.textContent);', `const controlsEnd = performance.now();
      add((root === document ? document.body : root)?.textContent);
      const textEnd = performance.now();`)
    .replace('}\n            walk(document);', `if (location.pathname === '/large.html') globalThis.largeTiming.stages.push({controls: controlsEnd - walkStart, text: textEnd - controlsEnd, hosts: performance.now() - textEnd});
        }
        walk(document);`)
    .replace(end, `if (location.pathname === '/large.html') globalThis.largeTiming.signatures.push({action, ms: performance.now() - signatureStart});\n${end}`);
}

export async function guardedBenchmark({ context, daemon, url }: { context: BrowserContext; daemon: FakeDaemon; url: string }) {
  const call = callsFor(daemon), active = await call('chrome.active');
  const tab = (await call('chrome.open', { url: `${url}large.html#guarded-benchmark` })).id;
  const page = await waitFor(() => context.pages().find(p => p.url().endsWith('#guarded-benchmark')), 'guarded benchmark fixture');
  const checked = await call('chrome.describe', { tab, selector: '#noop' });
  const samples: number[] = [];
  try {
    assert.equal(await page.evaluate(() => document.hidden), true);
    for (let i = 0; i < 24; i++) {
      const start = performance.now();
      const reply = await call('chrome.click', { tab, selector: '#noop', checkedDescription: { name: checked.name, href: checked.href } });
      const ms = performance.now() - start;
      assert.equal(reply.changed, false, 'guarded no-op must remain unchanged');
      if (i >= 4) samples.push(ms);
    }
    assert.equal((await call('chrome.active')).id, active.id, 'guarded benchmark never activates the target');
    assert.equal(await page.evaluate(() => document.hidden), true);
    const events = await page.evaluate('window.largeEvents');
    assert.ok(Array.isArray(events));
    assert.equal(events.length, 24, 'each click executes exactly once');
    console.log(`GUARDED_BENCHMARK ${JSON.stringify({ samples, median: [...samples].sort((a,b)=>a-b)[10], count: 20 })}`);
  } finally { await call('chrome.close', { tabs: [tab] }); }
}

export async function largePage({ context, worker, daemon, url, pass }: {
  context: BrowserContext; worker: Worker; daemon: FakeDaemon; url: string; pass: (label: string) => void;
}) {
  const call = callsFor(daemon);
  const foreground = await call('chrome.active');
  await worker.evaluate(() => {
    const probe = { tab: 0, enabledAt: 0, costs: [] as { action: string; ms: number }[] };
    Object.assign(globalThis, { largeProbe: probe });
    const execute = chrome.scripting.executeScript.bind(chrome.scripting);
    chrome.scripting.executeScript = async options => {
      const start = performance.now();
      try { return await execute(options); }
      finally { if (options.target.tabId === probe.tab) probe.costs.push({ action: String('args' in options ? options.args?.[0] : 'files'), ms: performance.now() - start }); }
    };
    const send = chrome.debugger.sendCommand.bind(chrome.debugger);
    chrome.debugger.sendCommand = async (target, method, params) => {
      const start = performance.now();
      try { return await send(target, method, params); }
      finally { if (target.tabId === probe.tab) {
        probe.costs.push({ action: method, ms: performance.now() - start });
        if (method === 'Emulation.setFocusEmulationEnabled') probe.enabledAt = Date.now();
      } }
    };
    Object.assign(globalThis, { restoreLargeProbe() { chrome.scripting.executeScript = execute; chrome.debugger.sendCommand = send; } });
  });
  try {
    for (const [action, selector, changed] of [
      ['hover', '#heading', false], ['click', '#noop', false], ['click', '#toggle', true],
    ] as const) {
      const tab = (await call('chrome.open', { url: `${url}large.html#${selector.slice(1)}` })).id;
      const page = await waitFor(() => context.pages().find(p => p.url().endsWith(`large.html#${selector.slice(1)}`)), 'large fixture');
      // Avoid URL-fragment scrolling to the actual target.
      await page.evaluate(() => scrollTo(0, 0));
      const initial = await page.evaluate(selector => ({ hidden: document.hidden, focused: document.hasFocus(),
        count: document.getElementsByTagName('*').length, chars: document.body.textContent!.length,
        y: scrollY, offscreen: document.querySelector(selector)!.getBoundingClientRect().top > innerHeight,
      }), selector);
      assert.equal(initial.hidden, true, 'ASSERT_LARGE_NATIVE: fixture must be natively hidden');
      assert.equal(initial.focused, false);
      assert.ok(initial.count >= 20000 && initial.chars >= 300000);
      if (action === 'click') assert.equal(initial.offscreen, true);
      await worker.evaluate(tab => Object.assign((globalThis as unknown as { largeProbe: object }).largeProbe,
        { tab, enabledAt: 0, costs: [] }), tab);
      const start = performance.now();
      const reply = await call(`chrome.${action}`, { tab, selector });
      const ms = Math.round(performance.now() - start);
      const timing = await worker.evaluate(async tab => {
        const probe = (globalThis as unknown as { largeProbe: { enabledAt: number; costs: unknown[] } }).largeProbe;
        const costs = [...probe.costs];
        const [page] = await chrome.scripting.executeScript({ target: { tabId: tab }, world: 'ISOLATED',
          func: () => (globalThis as unknown as { largeTiming: { signatures: unknown[]; stages: unknown[]; frameAt: number } }).largeTiming });
        return { costs, signatures: page.result!.signatures, stages: page.result!.stages, firstFrameMs: page.result!.frameAt - probe.enabledAt };
      }, tab);
      console.log(`LARGE_PAGE ${JSON.stringify({ action, selector, ms, reply, initial, timing })}`);
      assert.equal(reply.changed, changed, `ASSERT_LARGE_CHANGED_${selector.slice(1).toUpperCase()}`);
      assert.ok(ms < 600, `ASSERT_LARGE_LATENCY: ${selector} took ${ms}ms`);
      assert.equal(await page.evaluate(() => document.hidden), true);
      assert.equal((await call('chrome.active')).id, foreground.id);
      if (action === 'hover') assert.equal(await page.locator(selector).evaluate(el => el.matches(':hover')), true);
      else {
        assert.deepEqual(await page.evaluate('window.largeEvents'), [{ id: selector.slice(1), trusted: true }]);
        assert.ok(await page.evaluate(() => scrollY > 0));
        if (changed) assert.equal(await page.locator(selector).getAttribute('aria-expanded'), 'true');
      }
      await call('chrome.close', { tabs: [tab] });
    }
  } finally { await worker.evaluate('globalThis.restoreLargeProbe()'); }
  pass('native large-page hover/no-op offscreen click are unchanged, aria toggle changes, all under 600 ms');

  const tab = (await call('chrome.open', { url: `${url}large.html#state-coverage` })).id;
  const page = await waitFor(() => context.pages().find(p => p.url().endsWith('#state-coverage')), 'signature coverage fixture');
  await page.evaluate(() => {
    const host = document.createElement('div'); host.id = 'shadow-host'; document.body.append(host);
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<div id="nested"></div><input value="before"><div contenteditable>editable</div>';
    root.querySelector('#nested')!.attachShadow({ mode: 'open' }).innerHTML = '<span>shadow text</span><input type="checkbox"><select multiple><option selected>A</option><option>B</option></select><div aria-valuenow="1"></div>';
    const field = document.createElement('input'); field.id = 'same-value'; field.value = 'unchanged'; document.body.append(field);
  });
  const snapshot = async () => {
    const value = await page.evaluate(pageTask, 'snapshot');
    assert.equal(value.__gaddiError, undefined);
    assert.equal(typeof value.signature, 'string');
    return value.signature;
  };
  // These mutations change no top-level text except the explicit tail case.
  for (const mutation of [
    "document.querySelectorAll('.row span')[9999].textContent = 'tail changed beyond 20k'",
    "root.querySelector('input').value = 'after'",
    "root.querySelector('[contenteditable]').textContent = 'edited'",
    "nested.querySelector('span').textContent = 'changed shadow text'",
    "nested.querySelector('input').checked = true",
    "nested.querySelector('input').indeterminate = true",
    "nested.querySelector('input').disabled = true",
    "nested.querySelectorAll('option')[1].selected = true",
    "nested.querySelector('[aria-valuenow]').setAttribute('aria-valuenow', '2')",
    "nested.querySelector('[aria-valuenow]').setAttribute('aria-checked', 'mixed')",
  ]) {
    const before = await snapshot();
    await page.evaluate(`{
      const root = document.querySelector('#shadow-host').shadowRoot;
      const nested = root.querySelector('#nested').shadowRoot;
      ${mutation};
    }`);
    assert.notEqual(await snapshot(), before, `ASSERT_SIGNATURE_STATE: ${mutation}`);
  }
  const beforeStyle = await snapshot();
  await page.evaluate(() => { document.querySelector<HTMLElement>('#heading')!.style.visibility = 'hidden'; });
  assert.equal(await snapshot(), beforeStyle, 'CSS-only visibility is outside the textContent signature');
  await page.evaluate(() => scrollTo(0, 0));
  const typed = await call('chrome.type', { tab, selector: '#same-value', text: 'unchanged' });
  assert.equal(typed.changed, false, 'ASSERT_TYPE_PREPARATION: own scroll/focus and identical replacement do not count as a change');
  await page.evaluate(() => scrollTo(0, 0));
  assert.equal((await call('chrome.hover', { tab, selector: '#noop' })).changed, false, 'ASSERT_HOVER_PREPARATION: own offscreen scroll does not count as a change');
  await call('chrome.close', { tabs: [tab] });
  pass('signature covers tail text, nested open-shadow text/control/aria state and ignores own type/hover preparation');
}
