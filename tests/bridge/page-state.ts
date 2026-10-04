import type { BrowserContext, Worker } from 'playwright-core';
import type { ChromeParams } from '../../shared/protocol.ts';
import type { FakeDaemon } from './fake-daemon.ts';
import assert from 'node:assert/strict';
import { callsFor } from './extension-types.ts';
import { waitFor } from './fake-daemon.ts';

type Fixture = { context: BrowserContext; daemon: FakeDaemon; url: string; pass: (label: string) => void };
const reference = /@[A-Za-z0-9_-]{6}:[0-9a-z]+$/;

export async function pageStateRead({ context, daemon, url, pass }: Fixture) {
  const call = callsFor(daemon);
  const fixtureURL = `${url.replace('127.0.0.1', 'gaddi-fixture.test')}state.html`;
  const tab = (await call('chrome.open', { url: fixtureURL })).id;
  const page = await waitFor(() => context.pages().find(page => page.url() === fixtureURL), 'plain HTTP state fixture');
  assert.deepEqual(await page.evaluate(() => ({ secure: isSecureContext, randomUUID: typeof crypto.randomUUID })),
    { secure: false, randomUUID: 'undefined' }, 'ASSERT_HTTP_NONLOCAL: fixture reproduces missing randomUUID');
  const read = await call('chrome.read', { tab });
  const lines = read.outline.split('\n');
  const line = (name: string) => {
    const found = lines.find(value => value.includes(` ${JSON.stringify(name)} `));
    assert.ok(found, `ASSERT_OUTLINE_STATE: missing ${name}`);
    return found.replace(/ @[A-Za-z0-9_-]{6}:[0-9a-z]+$/, '');
  };
  for (const expected of [
    'searchbox "Search" value="hello"', 'textbox "Notes" value="line one"', 'textbox "Editor" value="edit me"',
    'spinbutton "Count" value="7"', 'spinbutton "ARIA count" value="9"',
    'checkbox "Ticked" checked', 'checkbox "Unticked" unchecked', 'checkbox "Partial" mixed',
    'radio "Selected radio" checked', 'radio "Unselected radio" unchecked', 'switch "Switch" mixed',
    'button "Disclosure" expanded=true', 'button "Toggle" pressed=mixed', 'tab "Unselected tab" selected=false',
    'textbox "Unavailable" value="readable" disabled',
    'combobox "Choice" value="Beta" options="a:Alpha|b:Beta"',
  ]) {
    const name = JSON.parse(expected.match(/"(?:[^"\\]|\\.)*"/)![0]) as string;
    assert.equal(line(name), expected, `ASSERT_OUTLINE_STATE: ${name}`);
  }
  assert.match(line('Long value'), /^textbox "Long value" value="x{79}…"$/, 'long field value is bounded and marked');
  const many = line('Many options');
  assert.ok(many.includes('v19:Option 19') && !many.includes('v20:Option 20') && many.endsWith('|…"'), 'enabled options stop at twenty and show truncation');
  for (const name of ['Password', 'Current password', 'New password', 'Card number', 'Card security', 'Card expiry',
    'Card month', 'Card year', 'One time code', 'Upload']) {
    assert.ok(line(name).includes('value=(hidden)'), `ASSERT_OUTLINE_REDACTION: ${name} remains represented without its value`);
  }
  assert.ok(!read.outline.includes('Hidden field'), 'hidden inputs stay out of the outline: agents cannot act on them');
  assert.ok(!read.outline.includes('private-'), 'ASSERT_OUTLINE_REDACTION: no sensitive fixture marker escapes');
  const refs = lines.map(value => value.split(' ').at(-1)!);
  assert.ok(refs.every(ref => reference.test(ref) && ref.length <= 10), 'ASSERT_COMPACT_REFS: 36-bit document nonce and short base36 counter');
  assert.equal(new Set(refs).size, refs.length, 'every outlined element has a distinct reference');
  assert.equal(new Set(refs.map(ref => ref.slice(0, 7))).size, 1, 'one nonce per document');
  const scroll = await page.evaluate(() => ({ y: scrollY, height: document.documentElement.scrollHeight }));
  assert.deepEqual(read.scroll, scroll);
  assert.ok(read.scroll.height > await page.evaluate(() => innerHeight));
  assert.match(read.outline, /form "Clobbered form"/);
  console.log(`PAGE_STATE_STATE_OUTLINE ${JSON.stringify({ bytes: Buffer.byteLength(read.outline), lines: lines.length, scroll })}`);
  const old = await daemon.request('chrome.describe', { tab, selector: 'gaddi:00000000-0000-0000-0000-000000000000:1' });
  assert.match(old.error?.message || '', /Stale selector; read the page again/);
  const password = await daemon.request('chrome.eval', { tab, expression: '1 + 1' });
  assert.match(password.error?.message || '', /password/i, 'clobbered form does not weaken real password refusal');
  await page.evaluate(() => document.querySelectorAll('input[type=password], input[autocomplete*=password]').forEach(el => el.remove()));
  assert.equal((await call('chrome.eval', { tab, expression: '1 + 1' })).value, 2, 'ASSERT_CLOBBERED_FORM: eval succeeds with a form child named type');
  const moved = await call('chrome.scroll', { tab, dy: 300 });
  assert.equal(moved.changed, true, 'ASSERT_ACTION_CHANGED: plain HTTP wheel reports the observed movement');
  assert.ok((await call('chrome.read', { tab })).scroll.y > 0, 'plain HTTP scroll and scroll metadata work');
  await call('chrome.goto', { tab, url: `${url}next.html` });
  const stale = await daemon.request('chrome.describe', { tab, selector: refs[0] });
  assert.match(stale.error?.message || '', /Stale selector; read the page again/);
  const freshRefs = (await call('chrome.read', { tab })).outline.split('\n').map(value => value.split(' ').at(-1)!);
  assert.ok(freshRefs.every(ref => reference.test(ref) && ref.slice(0, 7) !== refs[0].slice(0, 7)), 'new document gets a fresh nonce');
  await call('chrome.close', { tabs: [tab] });
  pass('plain HTTP look includes control state, bounded options, redaction, scroll and short refs; old-document/legacy refs fail closed');

  const gateURL = `${url}actions.html#gate`;
  const gate = (await call('chrome.open', { url: gateURL })).id;
  const gatePage = await waitFor(() => context.pages().find(page => page.url() === gateURL), 'gate fixture');
  const count = () => gatePage.evaluate('window.actionEvents.length') as Promise<number>;
  for (const selector of ['#button', '#link']) {
    const described = await call('chrome.describe', { tab: gate, selector });
    await gatePage.locator(selector).evaluate(el => {
      if (el.tagName === 'A') el.setAttribute('href', '/next.html?changed-destination');
      else el.textContent = 'Delete everything';
    });
    const before = await count();
    const denied = await daemon.request('chrome.click', { tab: gate, selector: described.selector,
      checkedDescription: { name: described.name, href: described.href } });
    assert.match(denied.error?.message || '', /Element changed since it was checked; look again/, 'ASSERT_CHECKED_DESCRIPTION_CLICK');
    assert.equal(await count(), before, 'renamed or redirected click emits no input event');
  }
  await gatePage.locator('#button').evaluate(el => { el.textContent = 'Continue'; });
  const unchanged = await call('chrome.describe', { tab: gate, selector: '#button' });
  await call('chrome.click', { tab: gate, selector: unchanged.selector, checkedDescription: { name: unchanged.name, href: unchanged.href } });
  assert.equal(await gatePage.evaluate('window.actionEvents.filter(e => e.type === "click" && e.target === "button" && e.trusted).length'), 1);
  const hovered = await call('chrome.describe', { tab: gate, selector: '#hover-race' });
  const beforeHover = await count();
  const hoverRace = await daemon.request('chrome.click', { tab: gate, selector: hovered.selector,
    checkedDescription: { name: hovered.name, href: hovered.href } });
  assert.match(hoverRace.error?.message || '', /Element changed since it was checked; look again/, 'ASSERT_CHECKED_DESCRIPTION_MOUSEENTER');
  assert.equal(await gatePage.locator('#hover-race').textContent(), 'Delete on hover', 'trusted mouse movement triggered the race');
  assert.equal(await count(), beforeHover, 'mouseenter rename is caught before pointerdown or click');
  await gatePage.locator('#submit-field').evaluate(el => (el as HTMLElement).focus());
  const submit = await call('chrome.describe', { tab: gate, selector: ':focus' });
  assert.equal(submit.submitName, 'Preview');
  await gatePage.locator('#submit-button').evaluate(el => { el.textContent = 'Pay'; });
  const before = await count();
  const enter = await daemon.request('chrome.press', { tab: gate, key: 'Enter', checkedDescription: { submitName: submit.submitName } });
  assert.match(enter.error?.message || '', /Element changed since it was checked; look again/, 'ASSERT_CHECKED_DESCRIPTION_ENTER');
  assert.equal(await count(), before, 'changed submit name delivers neither keydown nor click');
  await gatePage.locator('#submit-button').evaluate(el => { el.textContent = 'Preview'; });
  await call('chrome.press', { tab: gate, key: 'Enter', checkedDescription: { submitName: submit.submitName } });
  assert.equal(await gatePage.evaluate('window.actionEvents.filter(e => e.type === "keydown" && e.key === "Enter" && e.trusted).length'), 1);
  await call('chrome.close', { tabs: [gate] });
  pass('click name/href and Enter submit name are checked immediately before trusted input; changed targets get no events');
}

export async function pageStateInput({ context, worker, daemon, url, pass }: Fixture & { worker: Worker }) {
  const call = callsFor(daemon);
  const active = (await call('chrome.active')).id;
  const timings: { action: string; expected: boolean; ms: number; settleMs: number }[] = [];
  await worker.evaluate(() => {
    const original = chrome.scripting.executeScript.bind(chrome.scripting);
    const timings: { tab: number; ms: number }[] = [];
    chrome.scripting.executeScript = (async details => {
      if (!('args' in details) || details.args?.[0] !== 'settle') return original(details);
      const started = performance.now();
      try { return await original(details); }
      finally { timings.push({ tab: details.target.tabId!, ms: Math.round(performance.now() - started) }); }
    }) as typeof chrome.scripting.executeScript;
    Object.assign(globalThis, { pageStateSettleTimings: timings, restorePageStateSettleProbe: () => { chrome.scripting.executeScript = original; } });
  });
  for (const action of ['click', 'hover', 'type', 'press', 'select', 'scroll'] as const) {
    for (const expected of [true, false]) {
      const fixtureURL = `${url}actions.html#${action}-${expected}`;
      const tab = (await call('chrome.open', { url: fixtureURL })).id;
      const page = await waitFor(() => context.pages().find(page => page.url() === fixtureURL), 'outcome fixture');
      assert.equal(await page.evaluate(() => document.hidden), true, 'action fixture starts natively hidden');
      await page.evaluate(({ action, expected }) => {
        if (action === 'type' || action === 'press') document.querySelector<HTMLInputElement>('#field')!.focus();
        if (action === 'click' && !expected) document.querySelector<HTMLButtonElement>('#noop')!.focus();
        scrollTo(0, 0);
        if (action === 'hover') document.querySelector(expected ? '#hover' : '#inert')!.scrollIntoView({ block: 'center', behavior: 'instant' });
      }, { action, expected });
      const params: ChromeParams = { tab, ...(action === 'click' ? { selector: expected ? '#button' : '#noop' }
        : action === 'hover' ? { selector: expected ? '#hover' : '#inert' }
        : action === 'type' ? { selector: '#field', text: expected ? 'Zurich' : 'hello' }
        : action === 'press' ? { key: expected ? 'ArrowDown' : 'ArrowRight' }
        : action === 'select' ? { selector: '#choices', value: expected ? 'b' : 'a' }
        : { dy: expected ? 300 : 0 }) };
      const beforeState = await page.evaluate(() => ({ y: scrollY, focus: document.activeElement?.id, text: document.querySelector('#status')!.textContent }));
      const started = performance.now();
      const reply = await call(`chrome.${action}`, params);
      const ms = Math.round(performance.now() - started);
      const settle = await worker.evaluate('globalThis.pageStateSettleTimings') as { tab: number; ms: number }[];
      assert.equal(settle.filter(item => item.tab === tab).length, 1, 'exactly one after-input settle injection');
      const settleMs = settle.find(item => item.tab === tab)!.ms;
      timings.push({ action, expected, ms, settleMs });
      const afterState = await page.evaluate(() => ({ y: scrollY, focus: document.activeElement?.id, text: document.querySelector('#status')!.textContent }));
      console.log(`PAGE_STATE_ACTION ${JSON.stringify({ action, expected, ms, settleMs, beforeState, afterState, reply })}`);
      assert.equal(reply.changed, expected, `ASSERT_ACTION_CHANGED: ${action}, expected ${expected}, ${JSON.stringify(reply)}`);
      assert.equal(reply.url, fixtureURL);
      assert.ok(ms < 1000, `action ${action} settles within existing native-input budget: ${ms}ms`);
      const observed = await page.evaluate(({ action, expected }) => {
        if (action === 'type') return document.querySelector<HTMLInputElement>('#field')!.value === (expected ? 'Zurich' : 'hello');
        if (action === 'select') return document.querySelector<HTMLSelectElement>('#choices')!.value === (expected ? 'b' : 'a');
        if (action === 'scroll') return expected ? scrollY > 0 : scrollY === 0;
        return document.querySelector('#status')!.textContent === (expected ? { click: 'Clicked', hover: 'Hovered', press: 'Key received' }[action] : 'Waiting');
      }, { action, expected });
      assert.ok(observed, `action ${action} has independently observed outcome ${expected}`);
      assert.equal((await call('chrome.active')).id, active);
      await call('chrome.close', { tabs: [tab] });
    }
  }
  console.log(`PAGE_STATE_ACTION_TIMINGS ${JSON.stringify(timings)}`);
  pass('all six input actions return measured changed true/false and the current URL for change and no-op cases');

  const fixtureURL = `${url}actions.html#settle`;
  const tab = (await call('chrome.open', { url: fixtureURL })).id;
  const page = await waitFor(() => context.pages().find(page => page.url() === fixtureURL), 'settle fixture');
  const start = performance.now();
  const typed = await call('chrome.type', { tab, selector: '#combo', text: 'Zurich' });
  const comboMs = Math.round(performance.now() - start);
  assert.equal(typed.changed, true);
  assert.equal(await page.locator('[role=option]').isVisible(), true, 'ASSERT_COMBOBOX_SETTLE: delayed option is visible when typing returns');
  assert.ok(comboMs >= 80 && comboMs < 1000, `combobox waits for useful state within bounded action budget: ${comboMs}ms`);
  await page.evaluate(() => { window.requestAnimationFrame = () => 0; scrollTo(0, 0); });
  const wheelStart = performance.now();
  const wheel = await call('chrome.scroll', { tab, dy: 300 });
  const wheelMs = Math.round(performance.now() - wheelStart);
  assert.equal(wheel.changed, true);
  assert.ok(await page.evaluate(() => scrollY > 0));
  assert.ok(wheelMs < 1000, 'ASSERT_ISOLATED_SETTLE: main-world requestAnimationFrame replacement cannot stall input');
  const extraSettle = (await worker.evaluate('globalThis.pageStateSettleTimings') as { tab: number; ms: number }[]).filter(item => item.tab === tab);
  console.log(`PAGE_STATE_SETTLE_TIMINGS ${JSON.stringify({ comboMs, replacedPageRafWheelMs: wheelMs, injections: extraSettle })}`);
  await worker.evaluate('globalThis.restorePageStateSettleProbe()');
  await call('chrome.close', { tabs: [tab] });
  pass('typing waits for a delayed visible combobox option and page-overridden animation frames cannot stall scroll');

  const navigationURL = `${url}actions.html#navigation`;
  const navigationTab = (await call('chrome.open', { url: navigationURL })).id;
  const navigationPage = await waitFor(() => context.pages().find(page => page.url() === navigationURL), 'navigation action fixture');
  await navigationPage.evaluate(() => {
    sessionStorage.setItem('pageStateClicks', '0');
    document.querySelector('#link')!.addEventListener('click', () => sessionStorage.setItem('pageStateClicks', String(Number(sessionStorage.getItem('pageStateClicks')) + 1)));
  });
  // Inject failure only into this copied extension's after-read, after its input
  // was sent. It must preserve success and never replay a navigation click.
  await worker.evaluate(tab => {
    const original = chrome.scripting.executeScript.bind(chrome.scripting);
    const get = chrome.tabs.get.bind(chrome.tabs);
    let failedAfterRead = false;
    const snapshots: { url?: string; pendingUrl?: string; status?: string }[] = [];
    chrome.tabs.get = (async id => {
      const current = await get(id);
      if (id === tab && failedAfterRead) snapshots.push({ url: current.url, pendingUrl: current.pendingUrl, status: current.status });
      return current;
    }) as typeof chrome.tabs.get;
    chrome.scripting.executeScript = (async details => {
      if (details.target.tabId === tab && 'args' in details && details.args?.[0] === 'settle') {
        failedAfterRead = true;
        throw new Error('Frame was removed during navigation');
      }
      return original(details);
    }) as typeof chrome.scripting.executeScript;
    Object.assign(globalThis, { pageStateNavigationSnapshots: snapshots, restorePageStateScript: () => {
      chrome.scripting.executeScript = original; chrome.tabs.get = get;
    } });
  }, navigationTab);
  try {
    const reply = await call('chrome.click', { tab: navigationTab, selector: '#link' });
    assert.equal(reply.changed, true, 'ASSERT_NAVIGATION_OUTCOME: failed after-read never returns a replayable input error');
    assert.equal(reply.navigating, true);
    await waitFor(() => navigationPage.url() === `${url}next.html`, 'clicked navigation completes');
    assert.equal(await navigationPage.evaluate('sessionStorage.getItem("pageStateClicks")'), '1', 'navigation click is delivered exactly once');
    const snapshots = await worker.evaluate('globalThis.pageStateNavigationSnapshots') as { url?: string; pendingUrl?: string; status?: string }[];
    assert.ok(snapshots.length > 0, 'failed observation obtains a fresh tab snapshot');
    assert.equal(reply.url, snapshots[0].url, 'reply URL matches Chrome at response time, before a future navigation can commit');
    console.log(`PAGE_STATE_NAVIGATION ${JSON.stringify({ reply, snapshot: snapshots[0], deliveredClicks: 1 })}`);
  } finally {
    await worker.evaluate('globalThis.restorePageStateScript()');
    await call('chrome.close', { tabs: [navigationTab] });
  }
  pass('failed after-read during a real document navigation returns changed/navigating and preserves the single delivered click');
}
