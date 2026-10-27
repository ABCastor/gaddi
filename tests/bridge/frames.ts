import type { BrowserContext } from 'playwright-core';
import type { FakeDaemon } from './fake-daemon.ts';
import assert from 'node:assert/strict';
import { callsFor } from './extension-types.ts';
import { waitFor } from './fake-daemon.ts';

interface FramePage {
  clicks: { target: string; trusted: boolean }[];
  events: { type: string; target: string; key?: string; trusted: boolean }[];
}

// A page whose button sits behind a banner, and a cross-origin iframe inside it:
// what a person clicks through every day, and what a same-origin-only agent cannot.
export async function frameChecks({ context, daemon, url, inner, pass }: {
  context: BrowserContext; daemon: FakeDaemon; url: string; inner: string; pass: (label: string) => void;
}) {
  const call = callsFor(daemon);
  const tab = (await call('chrome.open', { url: `${url}frames.html?inner=${encodeURIComponent(inner)}`, group: '● Frames · tests' })).id;
  const page = await waitFor(() => context.pages().find(candidate => candidate.url().includes('frames.html')), 'frames fixture');
  const innerFrame = await waitFor(() => page.frames().find(frame => frame.url().startsWith(inner)), 'inner frame');
  await innerFrame.waitForLoadState('load');
  const top = () => page.evaluate(() => (window as unknown as FramePage).clicks);
  const innerEvents = () => innerFrame.evaluate(() => (window as unknown as FramePage).events);

  // The banner covers the middle of the button: a selector click has nowhere safe to
  // land, so it is refused, and the point the owner sees is what gets clicked.
  const obscured = await daemon.request('chrome.click', { tab, selector: '#covered' });
  assert.match(obscured.error?.message || '', /Element centre is obscured/, 'ASSERT_FRAME_OBSCURED: a covered centre is refused');
  const byPoint = await call('chrome.click', { tab, at: { x: 150, y: 30 } });
  assert.equal(byPoint.clicked, true, 'ASSERT_FRAME_POINT_CLICK: a click by point is reported clicked');
  assert.deepEqual(await top(), [{ target: 'covered', trusted: true }], 'ASSERT_FRAME_POINT_CLICK: the button under the point takes a trusted click');

  // The cross-origin document is invisible to a same-origin read, so the read lists
  // the frames it can address and a read of the frame returns that document instead.
  const whole = await call('chrome.read', { tab });
  assert.ok(!whole.text.includes('Inner heading'), 'ASSERT_FRAME_READ: the top document cannot read the cross-origin frame');
  const frames = whole.frames;
  assert.ok(Array.isArray(frames), 'ASSERT_FRAME_LIST: look lists the frames it can address');
  const target = frames.find(frame => frame.url.startsWith(inner));
  assert.ok(target && target.frameId > 0, `ASSERT_FRAME_LIST: the cross-origin frame is addressable: ${JSON.stringify(frames)}`);
  const inside = await call('chrome.read', { tab, frameId: target.frameId });
  assert.match(inside.text, /Inner heading/, 'ASSERT_FRAME_READ: a frame-targeted read returns the embedded document');
  assert.match(inside.outline, /Inner action/, 'ASSERT_FRAME_READ: the frame outline names its controls');

  // A selector inside the embedded document resolves there and clicks with real input.
  const clicked = await call('chrome.click', { tab, frameId: target.frameId, selector: '#inner-button' });
  assert.equal(clicked.clicked, true, 'ASSERT_FRAME_CLICK: a selector inside the frame is clicked');
  await waitFor(async () => (await innerEvents()).some(event => event.type === 'click' && event.target === 'inner-button' && event.trusted),
    'ASSERT_FRAME_CLICK: the frame button takes a trusted click');

  // Keyboard: the frame is inspected first, so its own field is the checked target.
  await call('chrome.type', { tab, frameId: target.frameId, selector: '#inner-field', text: 'Zurich' });
  assert.equal(await innerFrame.locator('#inner-field').inputValue(), 'Zurich', 'ASSERT_FRAME_TYPE: the embedded field holds the text');
  await call('chrome.press', { tab, frameId: target.frameId, key: 'Enter' });
  const events = await innerEvents();
  assert.ok(events.some(event => event.type === 'input' && event.target === 'inner-field' && event.trusted), 'ASSERT_FRAME_TYPE: the embedded field takes trusted input');
  assert.ok(events.some(event => event.type === 'keydown' && event.target === 'inner-field' && event.key === 'Enter' && event.trusted),
    `ASSERT_FRAME_PRESS: the embedded field takes a trusted key: ${JSON.stringify(events)}`);

  // Keyboard into an uninspected frame stays refused: the top frame's check cannot see
  // which field inside the embedded document would receive the text.
  await page.evaluate(() => (document.querySelector('#inner') as HTMLIFrameElement).focus());
  const refused = await daemon.request('chrome.press', { tab, key: 'Enter' });
  assert.match(refused.error?.message || '', /Refusing keyboard input into an uninspected embedded document/,
    'ASSERT_FRAME_PRESS_REFUSED: an uninspected embedded document still refuses keys');

  // A point measured in the frame reaches the embedded button too, which is how trusted
  // input crosses into an out-of-process frame at all.
  const box = await page.locator('#inner').boundingBox();
  assert.ok(box, 'the frame has a box in the top document');
  const button = await innerFrame.evaluate(() => {
    const rect = document.querySelector('#inner-button')!.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  const border = await page.locator('#inner').evaluate(element => {
    const style = getComputedStyle(element);
    return { left: parseFloat(style.borderLeftWidth), top: parseFloat(style.borderTopWidth) };
  });
  const before = (await innerEvents()).filter(event => event.type === 'click').length;
  await call('chrome.click', { tab, at: { x: box.x + border.left + button.x, y: box.y + border.top + button.y } });
  await waitFor(async () => (await innerEvents()).filter(event => event.type === 'click' && event.target === 'inner-button')
    .length > before, 'ASSERT_FRAME_POINT_CROSSES: a point click reaches the out-of-process frame');

  // A frame that is not there is refused rather than silently clicking the top document.
  const missing = await daemon.request('chrome.read', { tab, frameId: 9999 });
  assert.match(missing.error?.message || '', /frame|Frame/, 'ASSERT_FRAME_UNKNOWN: an unknown frame is refused');

  await call('chrome.close', { tabs: [tab] });
  pass('frames: point click through a banner, cross-origin frame listed and read, selector click, typing and Enter inside it, keys still refused when uninspected');
}
