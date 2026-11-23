import type { BrowserContext } from 'playwright-core';
import type { FakeDaemon } from './fake-daemon.ts';
import assert from 'node:assert/strict';
import { callsFor } from './extension-types.ts';
import { waitFor } from './fake-daemon.ts';

declare global {
  interface Window {
    strokes: { type: string; x: number; y: number; buttons: number; trusted: boolean; t: number }[];
    hold: { type: string; t: number; trusted: boolean }[]; confirmed: number; dropped: string[]; slid: number | null;
  }
}

// DRAG-HOLD in a real page: a drag and a press-and-hold are the owner's own pointer, through Chrome's debugger
// (Input.dispatchMouseEvent, as a point click), in a tab nobody has in front. The broker gates them
// (tests/gates/click-verbs.test.sh); here the input itself is held to what the page saw.
export async function gestureChecks({ context, daemon, url, pass }: {
  context: BrowserContext; daemon: FakeDaemon; url: string; pass: (label: string) => void;
}) {
  const call = callsFor(daemon);
  const tab = (await call('chrome.open', { url: `${url}gestures.html`, group: '● Gestures · tests' })).id;
  const page = await waitFor(() => context.pages().find(candidate => candidate.url().includes('gestures.html')), 'gestures fixture');
  await page.waitForLoadState('load');
  assert.equal(await page.evaluate(() => document.hidden), true, 'ASSERT_GESTURE_BACKGROUND: the fixture must be a background tab');
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  assert.ok(viewport.width >= 700 && viewport.height >= 310, `ASSERT_GESTURE_VIEWPORT: the fixture fits the viewport: ${JSON.stringify(viewport)}`);
  const box = (selector: string) => page.evaluate(s => { const r = document.querySelector(s)!.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; }, selector);
  const centre = async (selector: string) => { const r = await box(selector); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; };

  // Drag-selecting text: from the boundary before character 4 to the boundary before character 19 of a monospace line.
  const charLeft = (index: number) => page.evaluate(i => {
    const node = document.querySelector('#text')!.firstChild!, range = document.createRange();
    range.setStart(node, i); range.setEnd(node, i + 1);
    const r = range.getBoundingClientRect(); return { x: Math.round(r.left + 2), y: Math.round(r.top + r.height / 2) };
  }, index);
  const text = await page.evaluate(() => document.querySelector('#text')!.textContent!);
  await call('chrome.click', { tab, at: await charLeft(4), to: await charLeft(19) });
  assert.equal(await page.evaluate(() => getSelection()!.toString()), text.slice(4, 19), 'ASSERT_DRAG_SELECTS_TEXT: the selection is the span dragged over');
  pass('drag: selecting text with the pointer selects exactly the span dragged over');

  // A stroke over a canvas: one press, at least 10 moves with the button down at steadily growing positions, one release.
  const pad = await box('#pad');
  const from = { x: Math.round(pad.x + 20), y: Math.round(pad.y + 30) }, to = { x: Math.round(pad.x + 360), y: Math.round(pad.y + 150) };
  await call('chrome.click', { tab, at: from, to, holdMs: 400 });
  const strokes = await page.evaluate(() => window.strokes);
  const types = strokes.map(event => event.type);
  assert.equal(types[0], 'mousedown', `ASSERT_DRAG_STROKE: starts with one press: ${types.join(',')}`);
  assert.equal(types.at(-1), 'mouseup', 'ASSERT_DRAG_STROKE: ends with one release');
  assert.equal(types.filter(type => type === 'mousedown').length, 1, 'ASSERT_DRAG_STROKE: one press');
  assert.equal(types.filter(type => type === 'mouseup').length, 1, 'ASSERT_DRAG_STROKE: one release');
  const moves = strokes.filter(event => event.type === 'mousemove');
  assert.ok(moves.length >= 10, `ASSERT_DRAG_STROKE: at least 10 moves with the button down, saw ${moves.length}`);
  assert.ok(strokes.every(event => event.trusted), 'ASSERT_DRAG_STROKE: every event is trusted input');
  assert.ok(moves.every(event => event.buttons === 1), 'ASSERT_DRAG_STROKE: the button stays down between press and release');
  for (let i = 1; i < moves.length; i++) {
    assert.ok(moves[i].x >= moves[i - 1].x && moves[i].y >= moves[i - 1].y, `ASSERT_DRAG_STROKE: positions grow steadily at move ${i}`);
    // No gap: a person's stroke has no jump wider than a few steps of the path.
    assert.ok(Math.hypot(moves[i].x - moves[i - 1].x, moves[i].y - moves[i - 1].y) <= 60, `ASSERT_DRAG_STROKE: no gap at move ${i}`);
  }
  const down = strokes[0], up = strokes.at(-1)!;
  assert.ok(Math.abs(down.x - 20) <= 1 && Math.abs(down.y - 30) <= 1 && Math.abs(up.x - 360) <= 1 && Math.abs(up.y - 150) <= 1,
    `ASSERT_DRAG_STROKE: from the start point to the end point: ${JSON.stringify([down, up])}`);
  assert.ok(up.t - down.t >= 350, `ASSERT_DRAG_STROKE: the stroke takes the time asked for: ${Math.round(up.t - down.t)} ms`);
  pass('drag: a canvas stroke is one press, continuous moves with the button down, one release');

  // Press and hold: down, at least the duration, up; the page's hold-to-confirm completes only after its 1.5 s.
  const confirm = await centre('#confirm');
  await call('chrome.click', { tab, at: confirm, holdMs: 600 });
  let hold = await page.evaluate(() => ({ events: window.hold, confirmed: window.confirmed }));
  assert.deepEqual(hold.events.map(event => event.type), ['down', 'up'], 'ASSERT_HOLD_DOWN_UP: one press, one release');
  assert.ok(hold.events[1].t - hold.events[0].t >= 580, `ASSERT_HOLD_DURATION: held at least the duration: ${Math.round(hold.events[1].t - hold.events[0].t)} ms`);
  assert.equal(hold.confirmed, 0, 'ASSERT_HOLD_CONFIRMS: a hold shorter than the page asks for confirms nothing');
  await call('chrome.click', { tab, at: confirm, holdMs: 1800 });
  hold = await page.evaluate(() => ({ events: window.hold, confirmed: window.confirmed }));
  const [pressed, released] = hold.events.slice(2);
  assert.ok(released.t - pressed.t >= 1780 && released.t - pressed.t <= 1800 + 1500, `ASSERT_HOLD_DURATION: ${Math.round(released.t - pressed.t)} ms`);
  assert.ok(hold.events.every(event => event.trusted), 'ASSERT_HOLD_DOWN_UP: trusted input');
  assert.equal(hold.confirmed, 1, 'ASSERT_HOLD_CONFIRMS: a hold of the asked duration confirms once');
  pass('hold: press, wait the duration, release; hold-to-confirm completes only after its time');

  // A slider knob dragged by the pointer lands where it was let go, as a drag puzzle's does.
  const knob = await centre('#knob');
  assert.equal((await call('chrome.click', { tab, at: knob, to: { x: knob.x + 200, y: knob.y }, holdMs: 300 })).dragged, 'pointer', 'ASSERT_DRAG_SLIDER: a pointer drag');
  assert.equal(await page.evaluate(() => window.slid), 200, 'ASSERT_DRAG_SLIDER: the knob moved by the distance dragged');
  pass('drag: a slider knob moves by the distance dragged');

  // The drop target the broker judged is checked again before the press: another target there, or another document,
  // gets no input at all.
  const cardAt = await centre('#card'), binAt = await centre('#bin');
  const facts = async (at: { x: number; y: number }) => {
    const d = await daemon.request('chrome.describe', { tab, at });
    const r = d.result as { name: string; href: string; origin: string; documentId: string; frameId?: number };
    return { name: r.name, href: r.href, frame: { id: r.frameId ?? 0, origin: r.origin, document: r.documentId } };
  };
  const start = await facts(cardAt), target = await facts(binAt);
  for (const drop of [{ ...target, name: 'Trash' }, { name: target.name, frame: { ...target.frame, document: 'another-document' } }]) {
    const refused = await daemon.request('chrome.click', { tab, at: cardAt, to: binAt, checkedDescription: { ...start, drop: { name: drop.name, frame: drop.frame } } });
    assert.match(refused.error?.message ?? '', /drop point changed since it was checked/, `ASSERT_DROP_FINAL_CHECK: ${JSON.stringify(refused)}`);
  }
  assert.deepEqual(await page.evaluate(() => window.dropped), [], 'ASSERT_DROP_FINAL_CHECK: nothing was dropped');
  pass('drag: a drop target that changed since the check gets no input');

  // HTML5 drag and drop: the card lands on the drop zone with its data, bound to the target judged.
  const dropped = await call('chrome.click', { tab, at: cardAt, to: binAt, checkedDescription: { ...start, drop: { name: target.name, frame: target.frame } } });
  assert.equal(dropped.dragged, 'html5', 'ASSERT_DRAG_DROP: the page started an HTML5 drag, carried by Chrome to the drop point');
  assert.deepEqual(await page.evaluate(() => window.dropped), ['Card A'], 'ASSERT_DRAG_DROP: the drop zone received the card');
  pass('drag: HTML5 drag and drop delivers the card to the drop zone');
  await call('chrome.close', { tabs: [tab] });
}
