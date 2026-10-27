import type { BrowserContext, Frame } from 'playwright-core';
import type { FakeDaemon } from './fake-daemon.ts';
import assert from 'node:assert/strict';
import { isRecord } from '../../shared/protocol.ts';
import { callsFor } from './extension-types.ts';
import { waitFor } from './fake-daemon.ts';

interface Recorder {
  clicks: { target: string; trusted: boolean }[];
  events: { type: string; target: string; key?: string; trusted: boolean }[];
}
type Point = { x: number; y: number };
interface Answers { answers: number[]; verified: boolean }
interface Hidden { hiddenClicked: boolean }
interface PointDescription {
  name: string; tag: string; role: string; choice: boolean; href: string;
  frameId?: number; frameUrl?: string; blind?: boolean;
}

// A tab with a banner over a button and cross-origin documents inside it: what a person clicks
// through every day, and what a same-origin-only agent cannot reach or judge.
export async function frameChecks({ context, daemon, url, inner, pass }: {
  context: BrowserContext; daemon: FakeDaemon; url: string; inner: string; pass: (label: string) => void;
}) {
  const call = callsFor(daemon);
  const tab = (await call('chrome.open', { url: `${url}frames.html?inner=${encodeURIComponent(inner)}`, group: '● Frames · tests' })).id;
  const page = await waitFor(() => context.pages().find(candidate => candidate.url().includes('frames.html')), 'frames fixture');
  const innerFrame = await waitFor(() => page.frames().find(frame => frame.url().startsWith('http://localhost')), 'inner frame');
  await innerFrame.waitForLoadState('load');
  const widget = await waitFor(() => innerFrame.childFrames().find(frame => frame.url().includes('/vendor/recaptcha/')), 'verification widget');
  const nested = await waitFor(() => innerFrame.childFrames().find(frame => frame.url().includes('/nested.html')), 'nested frame');
  await Promise.all([widget.waitForLoadState('load'), nested.waitForLoadState('load')]);
  const top = () => page.evaluate(() => (window as unknown as Recorder).clicks);
  const innerEvents = () => innerFrame.evaluate(() => (window as unknown as Recorder).events);
  const nestedEvents = () => nested.evaluate(() => (window as unknown as Recorder).events);
  // Playwright composes an element's box through every frame on its own, so it is an
  // independent answer to "where would a person click", never the extension's arithmetic.
  type FrameLike = Pick<Frame, 'locator' | 'evaluate'>;
  const boxOf = async (frame: FrameLike, selector: string): Promise<Point> => {
    const box = await frame.locator(selector).boundingBox();
    assert.ok(box, `ASSERT_FRAME_BOX: ${selector} has a box`);
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  const describeAt = async (at: Point) => {
    const info = await call('chrome.describe', { tab, at });
    assert.ok(isRecord(info), 'describe by point returns an object');
    return info as unknown as PointDescription;
  };
  const clicksOn = async (frame: FrameLike, id: string) => (await frame.evaluate(() => (window as unknown as Recorder).events))
    .filter((event: Recorder['events'][number]) => event.type === 'click' && event.target === id);

  // The banner covers the middle of the button, so a selector click has nowhere safe to land.
  // The point a person sees is what gets clicked, and the gate judged that same button.
  const obscured = await daemon.request('chrome.click', { tab, selector: '#covered' });
  assert.match(obscured.error?.message || '', /Element centre is obscured/, 'ASSERT_FRAME_OBSCURED: a covered centre is refused');
  const coveredAt = { x: (await boxOf(page, '#covered')).x, y: 30 };
  const covered = await describeAt(coveredAt);
  assert.equal(covered.name, 'Covered action', 'ASSERT_FRAME_POINT_GATE: the gate sees the button under the point');
  assert.equal(covered.blind, undefined, 'ASSERT_FRAME_POINT_GATE: a plain button is not a blind click');
  const byPoint = await call('chrome.click', { tab, at: coveredAt });
  assert.equal(byPoint.clicked, true, 'ASSERT_FRAME_POINT_CLICK: a click by point is reported clicked');
  assert.deepEqual(await top(), [{ target: 'covered', trusted: true }], 'ASSERT_FRAME_POINT_CLICK: the button under the point takes a trusted click');

  // The press only goes in while the point still holds the control the gate named: a page that
  // swaps what sits there between the check and the click receives no input at all.
  const swapped = await daemon.request('chrome.click', { tab, at: coveredAt, checkedDescription: { name: 'Something else', href: '' } });
  assert.match(swapped.error?.message || '', /changed since it was checked/, 'ASSERT_FRAME_POINT_RECHECK: a point whose control changed is refused');
  assert.equal((await top()).length, 1, 'ASSERT_FRAME_POINT_RECHECK: nothing was pressed at that point');
  await call('chrome.click', { tab, at: coveredAt, checkedDescription: { name: 'Covered action', href: '' } });
  assert.equal((await top()).length, 2, 'ASSERT_FRAME_POINT_RECHECK: the same point with its real control still clicks');

  // A marker that takes no pointer events is not in the way: the point resolves to the button
  // underneath, so an agent never has to know the marker exists.
  const ghostAt = await boxOf(page, '#ghosted');
  const ghost = await describeAt(ghostAt);
  assert.equal(ghost.name, 'Ghost action', 'ASSERT_FRAME_POINT_THROUGH: a pointer-events:none marker is not the click target');
  assert.equal(ghost.choice, false, 'ASSERT_FRAME_POINT_THROUGH: a button is an action, not a choice');
  await call('chrome.click', { tab, at: ghostAt });
  assert.ok((await top()).some(click => click.target === 'ghosted' && click.trusted), 'ASSERT_FRAME_POINT_THROUGH: the marker does not swallow the trusted click');
  assert.equal((await top()).length, 3, 'ASSERT_FRAME_POINT_THROUGH: three trusted clicks in total, one per point');

  // The cross-origin documents are invisible to a same-origin read, so the read lists the
  // documents it can address, and a read of one returns that document instead of the tab's.
  const whole = await call('chrome.read', { tab });
  assert.ok(!whole.text.includes('Inner heading'), 'ASSERT_FRAME_READ: the top document cannot read the cross-origin frame');
  const frames = whole.frames;
  assert.ok(Array.isArray(frames), 'ASSERT_FRAME_LIST: look lists the documents it can address');
  const target = frames.find(frame => frame.url.startsWith('http://localhost'));
  assert.ok(target && target.frameId > 0, `ASSERT_FRAME_LIST: the cross-origin frame is addressable: ${JSON.stringify(frames)}`);
  const widgetFrame = frames.find(frame => frame.url.includes('/vendor/recaptcha/'));
  assert.ok(widgetFrame && widgetFrame.frameId > 0, 'ASSERT_FRAME_LIST: a doubly nested document is listed too');
  const nestedFrame = frames.find(frame => frame.url.includes('/nested.html'));
  assert.ok(nestedFrame && nestedFrame.frameId > 0, 'ASSERT_FRAME_LIST: its sibling is listed as well');
  assert.equal(widgetFrame.challenge, true, 'ASSERT_FRAME_CHALLENGE: a verification widget is named as one, not as a puzzle to solve');
  assert.equal(target.challenge, undefined, 'ASSERT_FRAME_CHALLENGE: an ordinary embedded page is not flagged');
  const inside = await call('chrome.read', { tab, frameId: target.frameId });
  assert.match(inside.text, /Inner heading/, 'ASSERT_FRAME_READ: a frame-targeted read returns the embedded document');
  assert.match(inside.outline, /Inner action/, 'ASSERT_FRAME_READ: the frame outline names its controls');
  assert.equal(inside.frames, undefined, 'ASSERT_FRAME_SCOPE: a read inside a document stays that document');

  // A selector inside the embedded document resolves there. The frame sits well away from the
  // tab's origin, so a click without the composed offset would land somewhere else entirely.
  const quiet = await call('chrome.click', { tab, frameId: target.frameId, selector: '#inner-heading' });
  assert.equal(quiet.changed, false, 'ASSERT_FRAME_CHANGED: a click that changes nothing inside a frame reports changed:false');
  const clicked = await call('chrome.click', { tab, frameId: target.frameId, selector: '#inner-button' });
  assert.equal(clicked.clicked, true, 'ASSERT_FRAME_CLICK: a selector inside the frame is clicked');
  assert.equal(clicked.changed, true, 'ASSERT_FRAME_CHANGED: a click inside a frame reports that document own change, not the tab');
  assert.equal(clicked.url.startsWith(url), true, 'ASSERT_FRAME_URL: the answer still reports the tab, not the embedded address');

  // The offset is measured for this click, not remembered: move the frame and click again.
  await page.evaluate(() => { (document.querySelector('#inner') as HTMLElement).style.left = '60px'; });
  await call('chrome.click', { tab, frameId: target.frameId, selector: '#inner-button' });
  assert.equal((await clicksOn(innerFrame, 'inner-button')).length, 2,
    'ASSERT_FRAME_MOVED: a moved frame is measured again, and the click still lands');
  await page.evaluate(() => { (document.querySelector('#inner') as HTMLElement).style.left = '0px'; });

  // Two documents deep, by name: the composed offset covers both levels.
  await call('chrome.click', { tab, frameId: nestedFrame.frameId, selector: '#nested-button' });
  await waitFor(async () => (await nestedEvents()).some(event => event.type === 'click' && event.target === 'nested-button' && event.trusted),
    'ASSERT_FRAME_NESTED: a selector two documents deep takes a trusted click');

  // The quiz radio's own name is prose about the answer, counted once: the word "post" inside a
  // sentence is what a hold once fired on, and a choice must never be read as an action.
  const quiz = await call('chrome.describe', { tab, frameId: target.frameId, selector: '#quiz-radio' });
  assert.equal(quiz.name, 'The windshield centre post reduces blind spots', 'ASSERT_CHOICE_NAME: a label names its control once');
  assert.equal(quiz.choice, true, 'ASSERT_CHOICE_NAME: a radio is a choice, so its prose is not an action name');

  // A point inside the frame resolves to the control there, not to the frame element.
  // Earlier steps scrolled the page (a control brought into view inside its own document can also
  // move the page around it); start from the top so the point below is one a person could see.
  await page.evaluate(() => scrollTo(0, 0));
  await innerFrame.evaluate(() => scrollTo(0, 0));
  const buttonAt = await boxOf(innerFrame, '#inner-button');
  const innerTarget = await describeAt(buttonAt);
  assert.equal(innerTarget.name, 'Inner action', 'ASSERT_FRAME_POINT_GATE: a point inside a frame is judged on the control inside it');
  assert.equal(innerTarget.frameId, target.frameId, 'ASSERT_FRAME_POINT_GATE: the description names the document that holds it');
  assert.match(innerTarget.frameUrl || '', /^http:\/\/localhost:\d+\/iframe\.html/, 'ASSERT_FRAME_POINT_GATE: the description names that document address');
  await call('chrome.click', { tab, at: buttonAt });
  await waitFor(async () => (await clicksOn(innerFrame, 'inner-button')).length === 3,
    'ASSERT_FRAME_POINT_CROSSES: a point click reaches the out-of-process frame');

  // Two documents deep: the verification widget on its own origin. Its checkbox is a choice, and
  // the gate sees the checkbox rather than the two frames around it.
  // A point inside the widget, taken the way Gaddi measures it: the document's own place in the
  // tab, plus the position inside that document. Playwright's box for a doubly nested frame is
  // not that place, and an agent aims with the extension's answer, not with a test runner's.
  const widgetShot = await call('chrome.screenshot', { tab, frameId: widgetFrame.frameId });
  const robotLocal = await widget.evaluate(() => {
    const r = document.querySelector('#robot')!.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  const robotAt = { x: Math.round(widgetShot.box!.x + robotLocal.x), y: Math.round(widgetShot.box!.y + robotLocal.y) };

  console.log('DEBUG widgetElementAt', JSON.stringify(await widget.evaluate(() => {
    const out: Record<string, string | null> = {};
    for (const [x, y] of [[28, 87], [28, 30], [28, 200], [100, 87]]) {
      const el = document.elementFromPoint(x, y);
      out[`${x},${y}`] = el ? (el.id || el.tagName) : null;
    }
    return { out, vw: innerWidth, vh: innerHeight, body: document.body.getBoundingClientRect().height };
  })));
  const robot = await describeAt(robotAt);
  assert.equal(robot.name, "I'm not a robot", 'ASSERT_FRAME_POINT_ACROSS: two levels down, the point resolves to the checkbox');
  assert.equal(robot.choice, true, 'ASSERT_FRAME_POINT_ACROSS: a checkbox is a choice, so no action verb hides in its words');
  assert.match(robot.frameUrl || '', /\/vendor\/recaptcha\/anchor$/, 'ASSERT_FRAME_POINT_ACROSS: the acting document is the widget own origin');
  await call('chrome.click', { tab, at: robotAt });
  assert.deepEqual(await widget.evaluate(() => (window as unknown as Recorder).events), [{ trusted: true }],
    'ASSERT_CHALLENGE_CLICK: the widget only ever sees a trusted click, never a synthesised one');
  assert.equal(await widget.locator('#robot').isChecked(), true, 'ASSERT_CHALLENGE_CLICK: the checkbox is really checked');
  // And by name, inside the widget, for an agent that has read the challenge instead of a picture.
  const bySelector = await call('chrome.click', { tab, frameId: widgetFrame.frameId, selector: '#robot' });
  assert.equal(bySelector.clicked, true, 'ASSERT_CHALLENGE_SELECTOR: the checkbox is clickable by name inside the widget');
  assert.deepEqual(await widget.evaluate(() => (window as unknown as Recorder).events), [{ trusted: true }, { trusted: true }],
    'ASSERT_CHALLENGE_SELECTOR: the second press is a person click too, and the widget undid nothing');

  // A picture challenge, answered by the agent itself: the widget is captured as a picture, the
  // caller is told where that picture sits in the tab, and the tiles it chose are pressed as the
  // person's own clicks. No card, no solver, no synthesised event.
  assert.equal(await widget.locator('#puzzle').isVisible(), true, 'ASSERT_CHALLENGE_PICTURE: the puzzle appeared after the checkbox');
  // A person scrolls the panel to the tile first; that can move the page around the frame too, so
  // the picture is taken after it, and its box is read from that same moment.
  const tile = await widget.evaluate(() => {
    const element = document.querySelector('[data-tile="4"]')!;
    element.scrollIntoView({ block: 'center' });
    const r = element.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  const shot = await call('chrome.screenshot', { tab, frameId: widgetFrame.frameId });
  assert.equal(shot.frame?.frameId, widgetFrame.frameId, 'ASSERT_CHALLENGE_PICTURE: the picture says which document it shows');
  assert.match(shot.frame?.url || '', /\/vendor\/recaptcha\/anchor$/, 'ASSERT_CHALLENGE_PICTURE: and that document own address');
  assert.ok(shot.box && shot.box.width > 100 && shot.box.height > 100, 'ASSERT_CHALLENGE_PICTURE: the crop carries its place in the tab');
  assert.ok(shot.width! / shot.box!.width > 0.5 && shot.width! / shot.box!.width <= 3,
    'ASSERT_CHALLENGE_PICTURE: the image is a crop at a knowable scale, not the whole tab');
  assert.ok(shot.box!.width < 1000, 'ASSERT_CHALLENGE_PICTURE: the crop is the widget, not the page around it');
  // A tile has no name, so it is only reachable by the point its picture shows: the tile position
  // inside the widget plus the place the widget sits in the tab.
  const tileAt = { x: Math.round(shot.box!.x + tile.x), y: Math.round(shot.box!.y + tile.y) };
  const tileName = await describeAt(tileAt);
  assert.equal(tileName.role, 'button', 'ASSERT_CHALLENGE_PICTURE: the point lands on the tile the picture shows');
  await call('chrome.click', { tab, at: tileAt });
  assert.deepEqual(await widget.evaluate(() => (window as unknown as Answers).answers), [4],
    'ASSERT_CHALLENGE_PICTURE: the tile the agent chose is the tile the widget saw pressed');
  await call('chrome.click', { tab, frameId: widgetFrame.frameId, selector: '#verify' });
  assert.equal(await widget.evaluate(() => (window as unknown as Answers).verified), true,
    'ASSERT_CHALLENGE_PICTURE: the challenge verifies itself, with no help from the owner');
  // A course player wraps its real controls in aria-hidden. A person presses those controls, so an
  // agent may too; and its quizzes use a native select, which is set inside that document.
  await call('chrome.click', { tab, frameId: widgetFrame.frameId, selector: '#hidden-ui' });
  assert.equal(await widget.evaluate(() => (window as unknown as Hidden).hiddenClicked), true,
    'ASSERT_ARIA_HIDDEN_CLICK: a control a person can press is pressable inside aria-hidden');
  const picked = await call('chrome.select', { tab, frameId: widgetFrame.frameId, selector: '#inner-select', value: 'two' });
  assert.equal(picked.selected, true, 'ASSERT_ARIA_HIDDEN_CLICK: a native select inside the document is set');
  assert.equal(await widget.evaluate(() => (document.querySelector('#inner-select') as HTMLSelectElement).value), 'two',
    'ASSERT_ARIA_HIDDEN_CLICK: the document own select really changed');

  // A wheel inside an embedded document is aimed the same way a click is: the box is measured, the
  // point is checked from the tab's side, and only then does the wheel go there.
  const scrollerAt = await boxOf(widget, '#scroller');
  const scrollBefore = await widget.evaluate(() => document.querySelector('#scroller')!.scrollTop);
  const wheeled = await call('chrome.scroll', { tab, frameId: widgetFrame.frameId, selector: '#scroller', dy: 120 });
  assert.equal(wheeled.scrolled, true, 'ASSERT_FRAME_SCROLL: a wheel inside an embedded document is sent');
  assert.ok(await widget.evaluate(() => document.querySelector('#scroller')!.scrollTop) > scrollBefore,
    'ASSERT_FRAME_SCROLL: the embedded document own scroller moved');
  assert.ok(scrollerAt.x > 0, 'ASSERT_FRAME_SCROLL: the scroller had a real place in the tab');

  // Keyboard: the frame is inspected first, so its own field is the checked target.
  const typed = await call('chrome.type', { tab, frameId: target.frameId, selector: '#inner-field', text: 'Zurich' });
  assert.equal(await innerFrame.locator('#inner-field').inputValue(), 'Zurich', 'ASSERT_FRAME_TYPE: the embedded field holds the text');
  assert.equal(typed.changed, true, 'ASSERT_FRAME_TYPE: typing inside a frame reports the change that document saw');
  await call('chrome.press', { tab, frameId: target.frameId, key: 'Enter' });
  const events = await innerEvents();
  assert.ok(events.some(event => event.type === 'input' && event.target === 'inner-field' && event.trusted), 'ASSERT_FRAME_TYPE: the embedded field takes trusted input');
  assert.ok(events.some(event => event.type === 'keydown' && event.target === 'inner-field' && event.key === 'Enter' && event.trusted),
    `ASSERT_FRAME_PRESS: the embedded field takes a trusted key: ${JSON.stringify(events)}`);

  // Keyboard into an uninspected frame stays refused: the top frame's check cannot see which
  // field inside the embedded document would receive the text.
  await page.evaluate(() => (document.querySelector('#inner') as HTMLIFrameElement).focus());
  const refused = await daemon.request('chrome.press', { tab, key: 'Enter' });
  assert.match(refused.error?.message || '', /Refusing keyboard input into an uninspected embedded document/,
    'ASSERT_FRAME_PRESS_REFUSED: an uninspected embedded document still refuses keys');
  assert.match(refused.error?.message || '', /frameId/, 'ASSERT_FRAME_PRESS_REFUSED: the refusal says how to inspect it');
  // Keys follow the focus: while the tab's own field holds it, a press aimed at the frame is refused.
  await call('chrome.type', { tab, selector: '#outer-field', text: 'outer' });
  const elsewhere = await daemon.request('chrome.press', { tab, frameId: target.frameId, key: 'Enter' });
  assert.match(elsewhere.error?.message || '', /does not hold the focus/, 'ASSERT_FRAME_PRESS_FOCUS: a frame that lost the focus refuses keys');
  await call('chrome.type', { tab, frameId: target.frameId, selector: '#inner-field', text: 'Bern' });
  const again = await call('chrome.press', { tab, frameId: target.frameId, key: 'Enter' });
  assert.equal(again.pressed, true, 'ASSERT_FRAME_PRESS_FOCUS: once the frame holds the focus, its keys go through');

  // The page may be scrolled away from the embed when the click is asked for: the control is
  // brought into view and aimed again, and the click still lands where it belongs.
  await page.evaluate(() => scrollTo(0, 1200));
  await call('chrome.click', { tab, frameId: target.frameId, selector: '#inner-button' });
  assert.equal((await clicksOn(innerFrame, 'inner-button')).length, 4,
    'ASSERT_FRAME_SCROLLED_PAGE: a page scrolled away from the embed is aimed again and the click lands');
  await page.evaluate(() => scrollTo(0, 0));

  // A frame that is not on the page is refused rather than silently acting on the tab's document,
  // and a point outside the viewport is refused rather than clamped onto something else.
  const missing = await daemon.request('chrome.read', { tab, frameId: 9999 });
  assert.match(missing.error?.message || '', /frame|Frame/, 'ASSERT_FRAME_UNKNOWN: an unknown frame is refused');
  const outside = await daemon.request('chrome.describe', { tab, at: { x: 5000, y: 5000 } });
  assert.match(outside.error?.message || '', /Nothing is at that point/, 'ASSERT_FRAME_POINT_OUTSIDE: a point off the viewport is refused');

  await call('chrome.close', { tabs: [tab] });
  pass('frames: point click through a banner, point through a transparent marker, cross-origin documents listed and read, selector clicks one and two levels deep, typing and Enter inside a frame, a verification checkbox pressed by point and by name, keys refused when uninspected or unfocused');
}
