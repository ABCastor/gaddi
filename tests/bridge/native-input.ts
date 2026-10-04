import type { BrowserContext, Worker } from 'playwright-core';
import type { FakeDaemon } from './fake-daemon.ts';
import assert from 'node:assert/strict';
import { callsFor } from './extension-types.ts';
import { waitFor } from './fake-daemon.ts';

export async function typeReplacement({ context, daemon, url, pass }: {
  context: BrowserContext; daemon: FakeDaemon; url: string; pass: (label: string) => void;
}) {
  const call = callsFor(daemon);
  const tab = (await call('chrome.open', { url: `${url}input.html#replacement` })).id;
  const page = await waitFor(() => context.pages().find(page => page.url().endsWith('#replacement')), 'replacement fixture');
  for (const selector of ['#field', '#area', '#editable']) {
    for (const text of ['Zurich', '']) {
      const before = await page.evaluate('window.inputEvents.length') as number;
      await call('chrome.type', { tab, selector, text });
      assert.equal(await page.locator(selector).evaluate(el => 'value' in el ? el.value : el.textContent), text,
        `ASSERT_TYPE_REPLACES: ${selector} must contain exactly ${JSON.stringify(text)}`);
      const events = await page.evaluate('window.inputEvents') as { type: string; target: string; trusted: boolean }[];
      assert.ok(events.slice(before).some(e => e.type === 'input' && e.target === selector.slice(1) && e.trusted),
        `ASSERT_TYPE_TRUSTED: ${selector} replacement, including empty text, emits trusted input`);
    }
  }
  await page.evaluate(() => {
    const editor = document.querySelector('#editable')!;
    editor.innerHTML = '<span contenteditable="false" id="mention">@plugin</span>';
    Object.assign(window, { originalMention: editor.firstChild });
  });
  const appendStyle = await page.locator('#editable').getAttribute('style');
  const appendEvents = await page.evaluate('window.inputEvents.length') as number;
  for (const text of [' wake up', '', ' again']) await call('chrome.type', { tab, selector: '#editable', text, mode: 'append' });
  assert.equal(await page.locator('#editable').textContent(), '@plugin wake up again', 'ASSERT_APPEND_PRESERVES_CHIP');
  assert.equal(await page.evaluate(() => document.querySelector('#mention') === (window as unknown as { originalMention: Node }).originalMention), true,
    'ASSERT_APPEND_PRESERVES_CHIP: existing mention node identity survives');
  assert.equal(await page.locator('#editable').getAttribute('style'), appendStyle, 'ASSERT_APPEND_LAYOUT_CLEANUP: restore editor CSS');
  assert.equal(await page.locator('#editable br').count(), 0, 'ASSERT_APPEND_LAYOUT_CLEANUP: leave no caret placeholder');
  const insertedEvents = await page.evaluate('window.inputEvents') as { type: string; target: string; trusted: boolean }[];
  assert.equal(insertedEvents.slice(appendEvents).filter(event => event.type === 'input' && event.target === 'editable' && event.trusted).length, 2,
    'ASSERT_APPEND_TRUSTED: both nonempty appends use native input');
  const whitespaceRules = await page.locator('#editable').evaluate(editor => {
    const style = (editor as HTMLElement).style;
    style.setProperty('white-space-collapse', 'collapse', 'important');
    style.setProperty('text-wrap-mode', 'nowrap');
    return ['white-space-collapse', 'text-wrap-mode'].map(property => [property, style.getPropertyValue(property), style.getPropertyPriority(property)]);
  });
  await call('chrome.type', { tab, selector: '#editable', text: ' extra', mode: 'append' });
  assert.equal(await page.locator('#editable').textContent(), '@plugin wake up again extra', 'ASSERT_APPEND_LITERAL_WHITESPACE');
  assert.deepEqual(await page.locator('#editable').evaluate(editor => {
    const style = (editor as HTMLElement).style;
    return ['white-space-collapse', 'text-wrap-mode'].map(property => [property, style.getPropertyValue(property), style.getPropertyPriority(property)]);
  }), whitespaceRules, 'ASSERT_APPEND_LAYOUT_CLEANUP: preserve separate CSS rules and priorities');
  for (const selector of ['#field', '#area']) {
    await call('chrome.type', { tab, selector, text: 'first' });
    await call('chrome.type', { tab, selector, text: ' second', mode: 'append' });
    assert.equal(await page.locator(selector).inputValue(), 'first second', 'ASSERT_APPEND_PRESERVES_CHIP');
  }
  await call('chrome.type', { tab, selector: '#email', text: '@example.test', mode: 'append' });
  await call('chrome.type', { tab, selector: '#number', text: '3', mode: 'append' });
  assert.equal(await page.locator('#email').inputValue(), 'user@example.test', 'ASSERT_APPEND_NATIVE_END');
  assert.equal(await page.locator('#number').inputValue(), '123', 'ASSERT_APPEND_NATIVE_END');
  await call('chrome.close', { tabs: [tab] });
  pass('type replaces prefilled input, textarea and rich contenteditable; empty text clears each with trusted input');
  pass('ASSERT_APPEND_PRESERVES_CHIP');
}

export async function nativeInput({ context, worker, daemon, url, pass }: {
  context: BrowserContext; worker: Worker; daemon: FakeDaemon; url: string; pass: (label: string) => void;
}) {
  const call = callsFor(daemon);
  const active = await call('chrome.open', { url: `${url}input.html#foreground`, foreground: true });
  await call('chrome.show', { tab: active.id });
  const foreground = await waitFor(() => context.pages().find(page => page.url().endsWith('#foreground')), 'foreground input fixture');
  await foreground.evaluate(() => document.querySelector<HTMLInputElement>('#field')!.focus());
  // Give the disposable headless window's foreground WebContents native focus.
  await foreground.bringToFront();
  // Window focus arrives asynchronously after bringToFront; wait for it rather than racing it.
  const foregroundState = () => foreground.evaluate(() => ({ visibility: document.visibilityState, focus: document.hasFocus(), element: document.activeElement?.id }));
  await waitFor(async () => (await foregroundState()).focus, 'foreground document focus', 3000);
  const foregroundBefore = await foregroundState();
  assert.deepEqual(foregroundBefore, { visibility: 'visible', focus: true, element: 'field' });
  const windowsBefore = await worker.evaluate(async () => (await chrome.windows.getAll()).map(w => ({ id: w.id, focused: w.focused, state: w.state })));
  const foregroundEvents = await foreground.evaluate('window.inputEvents.length') as number;

  // Instrument only this disposable extension. Observe both tabs before each
  // input dispatch and measure the actual attach/detach API promises.
  await worker.evaluate(active => {
    const data = { tab: 0, costs: [] as { method: string; ms: number }[], samples: [] as unknown[] };
    Object.assign(globalThis, { nativeInputProbe: data });
    const attach = chrome.debugger.attach.bind(chrome.debugger);
    const detach = chrome.debugger.detach.bind(chrome.debugger);
    chrome.debugger.attach = async (target, version) => {
      const start = performance.now();
      try { return await attach(target, version); } finally { data.costs.push({ method: 'attach', ms: performance.now() - start }); }
    };
    chrome.debugger.detach = async target => {
      const start = performance.now();
      try { return await detach(target); } finally { data.costs.push({ method: 'detach', ms: performance.now() - start }); }
    };
    const send = chrome.debugger.sendCommand.bind(chrome.debugger);
    chrome.debugger.sendCommand = async (target, method, params) => {
      if (target.tabId === data.tab && method.startsWith('Input.')) {
        const [agent, foreground] = await Promise.all([data.tab, active].map(tabId => chrome.scripting.executeScript({
          target: { tabId }, injectImmediately: true, func: () => ({ visibility: document.visibilityState, focus: document.hasFocus(), element: document.activeElement?.id }),
        })));
        data.samples.push({ method, agent: agent[0].result, foreground: foreground[0].result,
          tabs: (await chrome.tabs.query({ active: true })).map(t => ({ id: t.id, windowId: t.windowId })),
          windows: (await chrome.windows.getAll()).map(w => ({ id: w.id, focused: w.focused, state: w.state })) });
      }
      return send(target, method, params);
    };
    Object.assign(globalThis, { restoreNativeInputProbe() {
      chrome.debugger.attach = attach; chrome.debugger.detach = detach; chrome.debugger.sendCommand = send;
    } });
  }, active.id);
  for (const retained of [false, true]) {
  for (const action of ['click', 'hover', 'scroll', 'press', 'type'] as const) {
    // A stalled browser command can finish after its deadline. A fresh tab per
    // action prevents that late effect from contaminating the next measurement.
    const tab = (await call('chrome.open', { url: `${url}input.html#${action}`, group: '● Native input · tests' })).id;
    const page = await waitFor(() => context.pages().find(page => page.url().endsWith(`#${action}`)), 'native background input fixture');
    assert.deepEqual(await page.evaluate(() => ({ hidden: document.hidden, focus: document.hasFocus() })),
      { hidden: true, focus: false }, 'ASSERT_NATIVE_BACKGROUND: no other CDP client may force visibility');
    if (action === 'click') {
      await page.waitForTimeout(1300);
      assert.equal(await page.evaluate('window.framesSeen'), 0, 'native hidden fixture produces no animation frames');
    }
    if (retained) await call('chrome.emulate', { tab, colorScheme: 'dark' });
    await worker.evaluate(`Object.assign(globalThis.nativeInputProbe, { tab: ${tab}, costs: [], samples: [] })`);
    if (action === 'press') await page.evaluate(() => document.querySelector<HTMLInputElement>('#field')!.focus());
    if (action === 'scroll') await page.evaluate(() => scrollTo(0, 0));
    const start = performance.now();
    const reply = await daemon.request(`chrome.${action}`, { tab, ...(action === 'click' ? { selector: '#button' }
      : action === 'hover' ? { selector: '#hover' } : action === 'scroll' ? { dy: 300 }
      : action === 'type' ? { selector: '#field', text: 'Zurich' } : { key: 'Enter' }) }, 29000);
    const ms = Math.round(performance.now() - start);
    // Read-only polling permits compositor scroll completion, never action replay.
    const observed = await waitFor(async () => page.evaluate(action => {
      const events = (window as unknown as { inputEvents: { type: string; target: string; key?: string; trusted: boolean }[] }).inputEvents;
      if (action === 'click') return events.some(e => e.type === 'click' && e.target === 'button' && e.trusted) && document.activeElement?.id === 'button';
      if (action === 'hover') return document.querySelector('#hover')!.matches(':hover');
      if (action === 'scroll') return scrollY > 0;
      if (action === 'type') return document.querySelector<HTMLInputElement>('#field')!.value === 'Zurich'
        && events.some(e => e.type === 'input' && e.target === 'field' && e.trusted);
      return events.some(e => e.type === 'keydown' && e.target === 'field' && e.key === 'Enter' && e.trusted);
    }, action), `native ${action} effect`, 1000).catch(() => false);
    const effectMs = Math.round(performance.now() - start);
    const row = { action, retained, ms, effectMs, reply, observed };
    console.log(`NATIVE_INPUT ${JSON.stringify(row)}`);
    const probe = await worker.evaluate('globalThis.nativeInputProbe') as { samples: {
      agent: { visibility: string; focus: boolean }; foreground: typeof foregroundBefore;
      tabs: { id: number; windowId: number }[]; windows: typeof windowsBefore;
    }[] };
    console.log(`NATIVE_INPUT_PROBE ${JSON.stringify(probe)}`);
    console.log(`NATIVE_INPUT_AFTER ${JSON.stringify(await page.evaluate('({ visibility: document.visibilityState, focus: document.hasFocus(), events: window.inputEvents })'))}`);
    assert.ok(!reply.error && observed && effectMs < 1000, `ASSERT_NATIVE_INPUT_${action.toUpperCase()}: ${JSON.stringify(row)}`);
    assert.ok(probe.samples.length > 0);
    for (const sample of probe.samples) {
      assert.deepEqual(sample.foreground, foregroundBefore, 'foreground keeps document and element focus during input');
      assert.deepEqual(sample.tabs, [{ id: active.id, windowId: active.windowId }], 'input never activates the agent tab');
      assert.deepEqual(sample.windows, windowsBefore, 'input never changes window focus or visibility');
    }
    assert.equal(await page.evaluate(() => document.visibilityState), 'hidden', 'temporary focus emulation ends after input, including on retained sessions');
    assert.equal((await call('chrome.active')).id, active.id, 'background input preserves the active tab');
    assert.deepEqual(await foreground.evaluate(() => ({ visibility: document.visibilityState, focus: document.hasFocus(), element: document.activeElement?.id })), foregroundBefore);
    await call('chrome.close', { tabs: [tab] });
  }
  }
  assert.deepEqual(await foreground.evaluate(`window.inputEvents.slice(${foregroundEvents})`), [], 'foreground received no blur, focus or visibility events during background input');
  await worker.evaluate('globalThis.restoreNativeInputProbe()');
  await call('chrome.close', { tabs: [active.id] });
  pass('native background click/hover/wheel/Enter arrive within 1000 ms without moving foreground focus');
}
