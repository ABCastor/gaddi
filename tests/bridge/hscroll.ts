import type { BrowserContext } from 'playwright-core';
import type { FakeDaemon } from './fake-daemon.ts';
import assert from 'node:assert/strict';
import { callsFor } from './extension-types.ts';
import { waitFor } from './fake-daemon.ts';

declare global {
  interface Window {
    gridOffset: number;
    wheels: { deltaX: number; deltaY: number; trusted: boolean; target: string }[];
  }
}

// Wheel scrolling, sideways and over an element, in a tab nobody has in front.
export async function hscrollChecks({ context, daemon, url, pass }: {
  context: BrowserContext; daemon: FakeDaemon; url: string; pass: (label: string) => void;
}) {
  const call = callsFor(daemon);
  const active = (await call('chrome.active')).id;
  const tab = (await call('chrome.open', { url: `${url}hscroll.html#hscroll`, group: '● Horizontal scroll · tests' })).id;
  const page = await waitFor(() => context.pages().find(p => p.url().endsWith('#hscroll')), 'horizontal scroll fixture');
  assert.equal(await page.evaluate(() => document.hidden), true, 'ASSERT_HSCROLL_BACKGROUND: the fixture must be a background tab');
  const state = () => page.evaluate(() => ({
    x: scrollX, y: scrollY, plain: document.querySelector('#plain')!.scrollLeft, snap: document.querySelector('#snap')!.scrollLeft,
    gridScrollLeft: document.querySelector('#grid')!.scrollLeft, gridOffset: window.gridOffset, wheels: window.wheels.length,
  }));
  const eventually = (read: () => Promise<boolean>, tag: string) =>
    waitFor(read, tag, 3000).catch(async () => assert.fail(`${tag}: ${JSON.stringify(await state())}`));
  // Wheel scrolling animates; wait for it to stop before reading final numbers or resetting.
  const quiet = async () => {
    let last = JSON.stringify(await state());
    for (let i = 0; i < 40; i++) {
      await page.waitForTimeout(80);
      const now = JSON.stringify(await state());
      if (now === last) return;
      last = now;
    }
  };
  const reset = async () => {
    await page.evaluate(() => {
      scrollTo(0, 0);
      for (const id of ['#plain', '#snap']) document.querySelector(id)!.scrollLeft = 0;
      window.gridOffset = 0; window.wheels.length = 0;
    });
    await quiet();
    assert.deepEqual(await state(), { x: 0, y: 0, plain: 0, snap: 0, gridScrollLeft: 0, gridOffset: 0, wheels: 0 }, 'ASSERT_HSCROLL_RESET');
  };
  // The last wheel the page saw. Exact distances are Chrome's to scale, so only direction, trust and target are pinned.
  const lastWheel = async () => {
    const wheel = await page.evaluate(() => window.wheels.at(-1));
    assert.ok(wheel, 'the page saw a wheel');
    return wheel;
  };
  const gridText = () => page.locator('#track').innerText();
  await reset();

  // dx alone: one wheel at the old point, and the whole document moves sideways.
  const wide = await call('chrome.scroll', { tab, dx: 400 });
  assert.equal(wide.scrolled, true);
  assert.ok(!('position' in wide), 'a wheel with no element reports no position');
  await eventually(async () => (await state()).x > 0, 'ASSERT_HSCROLL_PAGE: dx with no selector must scroll the document sideways');
  await quiet();
  const sideways = await state();
  assert.equal(sideways.y, 0, 'ASSERT_HSCROLL_PAGE: dx must not scroll vertically');
  const pageWheel = await lastWheel();
  assert.ok(pageWheel.trusted && pageWheel.deltaX > 0 && pageWheel.deltaY === 0 && pageWheel.target === '', `ASSERT_HSCROLL_PAGE: a trusted wheel carrying dx: ${JSON.stringify(pageWheel)}`);
  await reset();

  // dy alone keeps working.
  await call('chrome.scroll', { tab, dy: 300 });
  await eventually(async () => (await state()).y > 0, 'ASSERT_HSCROLL_DY_ONLY: dy alone must still scroll the document');
  await quiet();
  assert.equal((await state()).x, 0, 'ASSERT_HSCROLL_DY_ONLY: dy must not scroll sideways');
  const dyWheel = await lastWheel();
  assert.ok(dyWheel.trusted && dyWheel.deltaX === 0 && dyWheel.deltaY > 0 && dyWheel.target === '', `ASSERT_HSCROLL_DY_ONLY: ${JSON.stringify(dyWheel)}`);
  await reset();

  // A selector alone only brings the element into view; no wheel is sent.
  const into = await call('chrome.scroll', { tab, selector: '#grid' });
  assert.equal(into.scrolled, true);
  assert.ok(!('position' in into), 'a selector alone reports no position');
  await eventually(async () => (await state()).y > 0, 'ASSERT_HSCROLL_SELECTOR_ONLY: a selector alone must scroll the element into view');
  await quiet();
  assert.deepEqual({ ...(await state()), y: 0 }, { x: 0, y: 0, plain: 0, snap: 0, gridScrollLeft: 0, gridOffset: 0, wheels: 0 }, 'ASSERT_HSCROLL_SELECTOR_ONLY: no wheel is sent');
  await reset();

  // (a) A plain scroller takes the wheel, not the page, and nothing is scrolled to reach it.
  const plain = await call('chrome.scroll', { tab, selector: '#plain', dx: 250 });
  await eventually(async () => (await state()).plain > 0, 'ASSERT_HSCROLL_PLAIN: dx over a scroller must move its scrollLeft');
  await quiet();
  const plainAfter = await state();
  assert.equal(plainAfter.x, 0, 'ASSERT_HSCROLL_PLAIN: the wheel must go to the scroller, not the page');
  assert.equal(plainAfter.y, 0, 'ASSERT_HSCROLL_PLAIN: an element already in view must not be scrolled to');
  const plainWheel = await lastWheel();
  assert.ok(plainWheel.trusted && plainWheel.deltaX > 0 && plainWheel.deltaY === 0 && plainWheel.target === 'plain', `ASSERT_HSCROLL_PLAIN: a trusted wheel over the element: ${JSON.stringify(plainWheel)}`);
  assert.equal(plainAfter.wheels, 1, 'ASSERT_HSCROLL_PLAIN: exactly one wheel reaches the page');
  assert.ok(plain.position, 'ASSERT_HSCROLL_PLAIN_POSITION: a targeted wheel reports the scroller position');
  assert.deepEqual(plain.position.before, { left: 0, top: 0 }, 'ASSERT_HSCROLL_PLAIN_POSITION');
  assert.ok(plain.position.after.left > 0 && plain.position.after.left <= plainAfter.plain, `ASSERT_HSCROLL_PLAIN_POSITION: ${JSON.stringify(plain.position)} vs ${plainAfter.plain}`);
  assert.equal(plain.changed, true, 'ASSERT_HSCROLL_PLAIN_POSITION: a moved scroller counts as a change');
  await reset();

  // (b) A scroll-snap carousel moves and lands on a slide.
  const snap = await call('chrome.scroll', { tab, selector: '#snap', dx: 320 });
  await eventually(async () => { const s = await state(); return s.snap > 0 && s.snap % 300 === 0; }, 'ASSERT_HSCROLL_SNAP: dx over a carousel must land on a slide');
  await quiet();
  const snapAfter = await state();
  assert.equal(snapAfter.snap % 300, 0, 'ASSERT_HSCROLL_SNAP');
  assert.equal(snapAfter.x, 0, 'ASSERT_HSCROLL_SNAP: the wheel must go to the carousel, not the page');
  assert.equal((await lastWheel()).target, 'snap', 'ASSERT_HSCROLL_SNAP');
  assert.ok(snap.position && snap.position.after.left >= snap.position.before.left, 'ASSERT_HSCROLL_SNAP');
  await reset();

  // (c) A wheel-driven grid: scrollLeft never moves, the text does. It starts below the fold.
  const textBefore = await gridText();
  assert.ok(await page.evaluate(() => document.querySelector('#grid')!.getBoundingClientRect().top > innerHeight), 'the grid starts below the fold');
  const grid = await call('chrome.scroll', { tab, selector: '#grid', dx: 250 });
  await eventually(async () => (await state()).gridOffset > 0, 'ASSERT_HSCROLL_GRID: dx over a wheel-driven grid must reach its wheel handler');
  await quiet();
  const gridAfter = await state();
  assert.equal(gridAfter.gridScrollLeft, 0, 'ASSERT_HSCROLL_GRID: the grid scrolls by wheel handler, never by scrollLeft');
  assert.ok(gridAfter.y > 0, 'ASSERT_HSCROLL_GRID: a grid below the fold is brought into view first');
  assert.equal(gridAfter.x, 0);
  assert.notEqual(await gridText(), textBefore, 'ASSERT_HSCROLL_GRID: the visible text changes');
  const gridWheel = await lastWheel();
  assert.ok(gridWheel.trusted && gridWheel.deltaX > 0 && gridWheel.deltaY === 0 && gridWheel.target === 'grid', `ASSERT_HSCROLL_GRID: a trusted wheel over the grid: ${JSON.stringify(gridWheel)}`);
  assert.equal(grid.changed, true, 'ASSERT_HSCROLL_GRID_CHANGED: the page text changed, so changed is true');
  assert.ok(grid.position, 'ASSERT_HSCROLL_GRID_CHANGED');
  assert.deepEqual(grid.position.after, grid.position.before, 'ASSERT_HSCROLL_GRID_CHANGED: no scroller moved; only the text says it worked');
  await reset();

  // Wheel options are checked, and a stale view is refused before any wheel.
  for (const params of [{ dx: 'far' }, { dx: null }, { dx: 100001 }, { dy: -100001 }, { dx: 5, dy: 'down' }, { selector: '#plain', dx: '5' }]) {
    const refused = await daemon.request('chrome.scroll', { tab, ...params });
    assert.match(refused.error?.message || '', /finite number between/, `ASSERT_HSCROLL_VALIDATION: ${JSON.stringify(params)}`);
  }
  assert.match((await daemon.request('chrome.scroll', { tab })).error?.message || '', /Supply dx, dy or selector/, 'ASSERT_HSCROLL_VALIDATION');
  const stale = await daemon.request('chrome.scroll', { tab, selector: '#plain', dx: 100, version: 'v1-stale' });
  assert.match(stale.error?.message || '', /changed since you looked/, 'ASSERT_HSCROLL_VERSION');
  await page.waitForTimeout(200);
  assert.deepEqual(await state(), { x: 0, y: 0, plain: 0, snap: 0, gridScrollLeft: 0, gridOffset: 0, wheels: 0 }, 'ASSERT_HSCROLL_VALIDATION: a refused scroll sends no wheel');
  const seen = await call('chrome.read', { tab });
  assert.ok(seen.version, 'the page offers a version');
  await call('chrome.scroll', { tab, selector: '#plain', dx: 100, version: seen.version });
  await eventually(async () => (await state()).plain > 0, 'ASSERT_HSCROLL_VERSION: the version the agent saw is accepted');
  await quiet();

  // Everything above happened without the tab ever coming forward.
  assert.equal(await page.evaluate(() => document.hidden), true, 'ASSERT_HSCROLL_BACKGROUND: the fixture stayed in the background');
  assert.equal((await call('chrome.active')).id, active, 'ASSERT_HSCROLL_BACKGROUND: the active tab never changed');
  await call('chrome.close', { tabs: [tab] });
  pass('scroll: dx alone moves the document; dx/dy over a selector moves a plain scroller, a snap carousel and a wheel-driven grid in a background tab; dy-only and selector-only unchanged; bad values and stale views refused');
}
