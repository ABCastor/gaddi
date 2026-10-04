import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { BrowserContext } from 'playwright-core';
import type { ApprovalCapture } from '../../shared/protocol.ts';
import { isRecord } from '../../shared/protocol.ts';
import { callsFor } from './extension-types.ts';
import { waitFor, type FakeDaemon } from './fake-daemon.ts';

export async function approvalPicture({ context, daemon, url, pass, captureDirectory }: {
  context: BrowserContext; daemon: FakeDaemon; url: string; pass: (message: string) => void; captureDirectory: string;
}) {
  const call = callsFor(daemon), active = await call('chrome.active');
  const tab = await call('chrome.open', { url: `${url}approval.html` });
  const page = await waitFor(() => context.pages().find(page => page.url() === `${url}approval.html`), 'approval fixture page');
  await page.evaluate(() => { document.querySelector<HTMLElement>('#near')!.focus({ preventScroll: true }); scrollTo(60, 90); });
  const before = await page.evaluate(() => ({ x: scrollX, y: scrollY, focus: document.activeElement?.id, hidden: document.hidden }));
  for (const [selector, colour] of [['#near', [214, 35, 143]], ['#far', [20, 170, 100]], [':focus', [214, 35, 143]]] as const) {
    const target = await call('chrome.describe', { tab: tab.id, selector });
    const start = Date.now();
    const raw = await daemon.call('chrome.approvalCapture', { tab: tab.id, selector: target.selector,
      ...(selector === ':focus' ? { key: 'Enter', checkedDescription: { submitName: target.submitName } }
        : { checkedDescription: { name: target.name, href: target.href } }) });
    const ms = Date.now() - start;
    assert.ok(isRecord(raw) && isRecord(raw.box), 'ASSERT_CAPTURE_BOX: exact target box is required');
    const box = raw.box;
    assert.ok(['x', 'y', 'width', 'height'].every(key => typeof box[key] === 'number' && Number.isFinite(box[key])), 'ASSERT_CAPTURE_BOX: numeric box');
    const shot = raw as unknown as ApprovalCapture;
    assert.equal(shot.mimeType, 'image/jpeg');
    const jpeg = Buffer.from(shot.data, 'base64');
    assert.equal(jpeg.subarray(0, 3).toString('hex'), 'ffd8ff');
    assert.deepEqual(await page.evaluate(() => ({ x: scrollX, y: scrollY, focus: document.activeElement?.id, hidden: document.hidden })), before,
      'ASSERT_CAPTURE_NO_SCROLL: capture must preserve scroll, focus and visibility');
    assert.equal((await call('chrome.active')).id, active.id, 'ASSERT_CAPTURE_BACKGROUND');
    assert.equal((await call('chrome.tabs')).tabs.find(info => info.id === tab.id)!.active, false);
    const decoded = await page.evaluate(async shot => {
      const bitmap = await createImageBitmap(await (await fetch(`data:image/jpeg;base64,${shot.data}`)).blob());
      const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d')!; ctx.drawImage(bitmap, 0, 0); bitmap.close();
      const { box } = shot;
      const pixels = [.2, .8].flatMap(x => [.2, .8].map(y => [...ctx.getImageData(Math.floor(box.x + x * box.width), Math.floor(box.y + y * box.height), 1, 1).data]));
      return { width: canvas.width, height: canvas.height, pixels };
    }, shot);
    assert.equal(decoded.width, shot.width); assert.equal(decoded.height, shot.height);
    assert.ok(shot.width <= 960 && shot.height <= 720);
    assert.ok(Math.abs(shot.box.width - 240) <= 1 && Math.abs(shot.box.height - 80) <= 1, 'ASSERT_CAPTURE_BOX: fixture target dimensions');
    for (const pixel of decoded.pixels) assert.ok(colour.every((component, index) => Math.abs(pixel[index] - component) < 12),
      `ASSERT_CAPTURE_COLOUR: ${selector} ${pixel} expected ${colour}`);
    assert.ok(ms < 3000, 'ASSERT_CAPTURE_DEADLINE');
    console.log(`CAPTURE_FIXTURE ${selector} ${ms}ms ${jpeg.length}bytes ${shot.width}x${shot.height} box=${JSON.stringify(shot.box)} hidden=${before.hidden}`);
  }
  const clipped = await daemon.request('chrome.approvalCapture', { tab: tab.id, selector: '#clipped' });
  assert.match(clipped.error?.message || '', /clipped/, 'ASSERT_CAPTURE_CLIPPED: nested scrolling target must not outline unrelated pixels');
  assert.equal(await page.locator('#clipping').evaluate(el => el.scrollTop), 0);
  const scaled = await daemon.request('chrome.approvalCapture', { tab: tab.id, selector: '#scaled-clipped' });
  assert.match(scaled.error?.message || '', /clipp/, 'ASSERT_CAPTURE_SCALED_CLIPPED');
  assert.equal(await page.locator('#scaled-clipping').evaluate(el => el.scrollTop), 0);
  assert.deepEqual(await page.evaluate(() => ({ x: scrollX, y: scrollY, focus: document.activeElement?.id, hidden: document.hidden })), before);
  for (const [property, value] of [['transform', 'rotate(10deg)'], ['translate', '10px'], ['scale', '1.1'], ['zoom', '1.1']]) {
    await page.locator('#small').evaluate((el, [property, value]) => (el as HTMLElement).style.setProperty(property, value), [property, value]);
    const transformed = await daemon.request('chrome.approvalCapture', { tab: tab.id, selector: '#small' });
    assert.match(transformed.error?.message || '', /transformed/, `ASSERT_CAPTURE_TRANSFORMED: ${property}`);
    await page.locator('#small').evaluate((el, property) => (el as HTMLElement).style.removeProperty(property), property);
  }
  // Pin the checked Enter reference, then change focus to another button with
  // the same submission name before dispatch. No key may reach that new target.
  const focused = await call('chrome.describe', { tab: tab.id, selector: ':focus' });
  await page.evaluate(() => {
    document.querySelector('#far')!.setAttribute('aria-label', 'Pay now');
    document.querySelector<HTMLElement>('#far')!.focus({ preventScroll: true });
    document.addEventListener('keydown', () => document.body.dataset.keyDelivered = 'yes');
  });
  const movedFocus = await daemon.request('chrome.press', { tab: tab.id, key: 'Enter', selector: focused.selector,
    checkedDescription: { submitName: focused.submitName } });
  assert.match(movedFocus.error?.message || '', /Focused target changed/);
  assert.equal(await page.evaluate(() => document.body.dataset.keyDelivered), undefined, 'ASSERT_CAPTURE_ENTER_REFERENCE');
  // Real document context, including two document edges and an already-scrolled
  // viewport. Observers detect transient changes, not only the final position.
  const measurements = [];
  fs.mkdirSync(captureDirectory, { recursive: true });
  for (const [name, selector, scroll] of [
    ['small', '#small', 0], ['wide', '#wide', 0], ['top-left', '#top-left', 0],
    ['bottom-right', '#bottom-right', 0], ['scrolled', '#small', 1080],
    ['oversized', '#oversized', 0],
  ] as const) {
    await page.evaluate(scroll => { scrollTo(60, scroll); }, scroll);
    // Paint the fixture's deliberate scroll before installing observers. Hidden
    // tabs defer its scroll event until a paint; a timer/rAF cannot drain it.
    // This setup screenshot is discarded and never changes the active tab.
    await page.screenshot({ timeout: 3000 });
    const geometry = await page.locator(selector).evaluate(el => {
      const rect = el.getBoundingClientRect();
      return { x: rect.left + scrollX, y: rect.top + scrollY, width: rect.width, height: rect.height,
        documentWidth: Math.max(document.documentElement.scrollWidth, innerWidth),
        documentHeight: Math.max(document.documentElement.scrollHeight, innerHeight) };
    });
    await page.evaluate(() => {
      document.body.dataset.captureEvents = '';
      document.body.dataset.captureMutations = '';
      const events = ['scroll', 'focusin', 'focusout', 'click', 'input', 'keydown'];
      const record = (event: Event) => { document.body.dataset.captureEvents += event.type + ','; };
      const observer = new MutationObserver(records => {
        if (records.some(record => !(record.target === document.body && record.attributeName?.startsWith('data-capture'))))
          document.body.dataset.captureMutations = 'changed';
      });
      observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
      events.forEach(event => document.addEventListener(event, record, true));
      // Only the fixture owns this cleanup function, never the capture code.
      Object.assign(window, { endCaptureObservation: () => {
        observer.disconnect(); events.forEach(event => document.removeEventListener(event, record, true));
      } });
    });
    const initial = await page.evaluate(() => ({ x: scrollX, y: scrollY, focus: document.activeElement?.id, hidden: document.hidden }));
    const raw = await daemon.call('chrome.approvalCapture', { tab: tab.id, selector });
    assert.ok(isRecord(raw) && isRecord(raw.box), `ASSERT_CAPTURE_BOX: ${name}`);
    const shot = raw as unknown as ApprovalCapture;
    assert.deepEqual(await page.evaluate(() => ({ x: scrollX, y: scrollY, focus: document.activeElement?.id, hidden: document.hidden })), initial,
      `ASSERT_CAPTURE_NO_SCROLL: ${name}`);
    assert.deepEqual(await page.evaluate(() => [document.body.dataset.captureEvents, document.body.dataset.captureMutations]), ['', ''],
      `ASSERT_CAPTURE_NO_MUTATION: ${name}`);
    await page.evaluate(() => (window as unknown as { endCaptureObservation: () => void }).endCaptureObservation());
    assert.equal((await call('chrome.active')).id, active.id, `ASSERT_CAPTURE_BACKGROUND: ${name}`);
    const scale = shot.box.width / geometry.width;
    const region = { x: geometry.x - shot.box.x / scale, y: geometry.y - shot.box.y / scale,
      width: shot.width / scale, height: shot.height / scale };
    const expectedRegions = {
      small: [310, 1060, 700, 320], wide: [100, 1650, 1200, 480],
      'top-left': [0, 0, 418, 188], 'bottom-right': [982, 3412, 418, 188], scrolled: [310, 1060, 700, 320],
    };
    if (name === 'oversized') {
      // The 120px surround wins over both preferred caps; raster scaling must
      // retain the complete target even when integer JPEG dimensions round.
      [40, 2080, 1320, 740].forEach((value, index) => assert.ok(Math.abs(Object.values(region)[index] - value) < 1,
        `ASSERT_CAPTURE_REGION: oversized dimension ${index}`));
      assert.equal(shot.width, 1200, 'ASSERT_CAPTURE_DOWNSCALE');
      assert.ok(scale < 1, 'ASSERT_CAPTURE_DOWNSCALE: oversized raster is reduced');
    } else assert.deepEqual(Object.values(region), expectedRegions[name], `ASSERT_CAPTURE_REGION: ${name}`);
    assert.ok(shot.width <= 1200 && shot.height <= 720, `ASSERT_CAPTURE_LIMIT: ${name}`);
    assert.ok(region.x >= -1 && region.y >= -1 && region.x + region.width <= geometry.documentWidth + 1
      && region.y + region.height <= geometry.documentHeight + 1, `ASSERT_CAPTURE_DOCUMENT: ${name}`);
    const margins = [shot.box.x / scale, shot.box.y / scale,
      (shot.width - shot.box.x - shot.box.width) / scale, (shot.height - shot.box.y - shot.box.height) / scale];
    const available = [geometry.x, geometry.y, geometry.documentWidth - geometry.x - geometry.width,
      geometry.documentHeight - geometry.y - geometry.height];
    margins.forEach((margin, index) => assert.ok(margin >= Math.min(120, available[index]) - 1,
      `ASSERT_CAPTURE_CONTEXT: ${name} side ${index} has ${margin}px`));
    assert.ok(Math.abs(shot.box.height / scale - geometry.height) < 1, `ASSERT_CAPTURE_BOX: ${name} aspect ratio`);
    const pixel = await page.evaluate(async shot => {
      const bitmap = await createImageBitmap(await (await fetch(`data:image/jpeg;base64,${shot.data}`)).blob());
      const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d')!; ctx.drawImage(bitmap, 0, 0); bitmap.close();
      return [...ctx.getImageData(Math.floor(shot.box.x + shot.box.width * .2), Math.floor(shot.box.y + shot.box.height * .8), 1, 1).data];
    }, shot);
    const colour = name === 'wide' || name === 'oversized' ? [20, 170, 100] : [214, 35, 143];
    assert.ok(colour.every((component, index) => Math.abs(pixel[index] - component) < 12), `ASSERT_CAPTURE_COLOUR: ${name} ${pixel}`);
    const imagePath = path.join(captureDirectory, `${name}.jpg`);
    fs.writeFileSync(imagePath, Buffer.from(shot.data, 'base64'));
    const measurement = { name, imagePath, geometry, region, width: shot.width, height: shot.height, box: shot.box,
      targetImageShare: shot.box.width * shot.box.height / (shot.width * shot.height) };
    measurements.push(measurement);
    console.log(`CAPTURE_CONTEXT ${JSON.stringify(measurement)}`);
  }
  fs.writeFileSync(path.join(captureDirectory, 'measurements.json'), JSON.stringify(measurements, null, 2));
  pass('small, wide, document-edge and scrolled captures include real context without page input, focus, scroll or DOM changes');
  // Fixed/sticky captures stay inside the current viewport so CDP does not
  // repaint those controls at a different location in an expanded viewport.
  for (const position of ['fixed', 'sticky']) {
    await page.evaluate(position => {
      const el = document.querySelector<HTMLElement>('#near')!;
      el.style.position = position; el.style.top = '140px'; el.style.left = '260px';
      el.focus({ preventScroll: true }); scrollTo(0, 300);
    }, position);
    const initial = await page.evaluate(() => ({ y: scrollY, focus: document.activeElement?.id }));
    const raw = await daemon.call('chrome.approvalCapture', { tab: tab.id, selector: focused.selector });
    assert.ok(isRecord(raw) && isRecord(raw.box));
    const shot = raw as unknown as ApprovalCapture;
    const pixel = await page.evaluate(async shot => {
      const bitmap = await createImageBitmap(await (await fetch(`data:image/jpeg;base64,${shot.data}`)).blob());
      const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d')!; ctx.drawImage(bitmap, 0, 0); bitmap.close();
      return [...ctx.getImageData(Math.floor(shot.box.x + shot.box.width * .2), Math.floor(shot.box.y + shot.box.height * .8), 1, 1).data];
    }, shot);
    assert.ok([214, 35, 143].every((value, i) => Math.abs(value - pixel[i]) < 12), `ASSERT_CAPTURE_PINNED: ${position}: ${pixel}`);
    assert.deepEqual(await page.evaluate(() => ({ y: scrollY, focus: document.activeElement?.id })), initial);
    assert.equal((await call('chrome.active')).id, active.id);
  }
  await call('chrome.close', { tabs: [tab.id] });
  pass('approval JPEG target colours and boxes, including offscreen and focused targets, preserve scroll/focus/background');
}
