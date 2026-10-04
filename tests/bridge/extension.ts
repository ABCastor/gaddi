import type { BrowserContext } from 'playwright-core';
import type { Protocol } from '../../node_modules/playwright-core/types/protocol.d.ts';
import type { ChildProcess } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { callsFor } from './extension-types.ts';
import type { ChromeResults } from './extension-types.ts';
import { isRecord } from '../../shared/protocol.ts';
declare global {
  interface Window {
    detachedPay: Element;
    events: { type: string; isTrusted: boolean; key?: string }[];
    motion: Animation;
    laterMotion: Animation;
  }
}
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { FakeDaemon, waitFor } from './fake-daemon.ts';
import { visibleChecks } from './visible.ts';
import { waitChecks } from './wait.ts';
import { approvalPicture } from './approval-picture.ts';
import { versionPage, instrumentVersion } from './version-page.ts';
import { pageStateRead, pageStateInput } from './page-state.ts';
import { pageRecovery } from './page-recovery.ts';
import { nativeInput, typeReplacement } from './native-input.ts';
import { largeFixture, largePage, instrumentLargeSignature, guardedBenchmark } from './large-page.ts';
import { restartDeadline, restartInstrumentation } from './restart-deadline.ts';
import { requireHeadless, watchHeadless } from './background.ts';
import { foreignFrame, writeForeignExtension } from './foreign-frame.ts';
import { autonomousSetup } from './autonomy-browser.ts';
import { uploadChecks } from './upload.ts';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const root = path.join(repo, 'tests/.state-bridge');
fs.mkdirSync(root, { recursive: true });
const state = fs.mkdtempSync(path.join(root, 'e2e-'));
const profile = path.join(state, 'profile');
const extension = path.join(state, 'extension');
const sock = path.join(os.tmpdir(), `gaddi-bridge-extension-${process.pid}.sock`);
const hostName = 'com.abcastor.gaddi.bridge.test';
const daemon = new FakeDaemon(sock);
const call = callsFor(daemon);
let backgroundGuard: ReturnType<typeof watchHeadless> | undefined, context: BrowserContext | undefined, singleClientChrome: ChildProcess | undefined, singleClientExit: Promise<unknown> | undefined, server: http.Server | undefined, passed = 0, stalled = 0, blocked = 0;
const fixtureTimers = new Set<ReturnType<typeof setTimeout>>();
const pass = (label: string) => { passed++; console.log(`PASS ${label}`); };
const restartOnly = process.env.GADDI_BRIDGE_RESTART_ONLY === '1';
const broken = process.env.GADDI_BRIDGE_BREAK_NAMES === '1';
const brokenExplicitClose = process.env.GADDI_BRIDGE_BREAK_EXPLICIT_CLOSE === '1';
const brokenScreenshot = process.env.GADDI_BRIDGE_BREAK_SCREENSHOT === '1';
const brokenDeadline = process.env.GADDI_BRIDGE_BREAK_DEADLINE === '1';
const brokenTypeReplacement = process.env.GADDI_BRIDGE_BREAK_TYPE_REPLACEMENT === '1';
const brokenInputFocus = process.env.GADDI_BRIDGE_BREAK_INPUT_FOCUS === '1';
const brokenOutlineState = process.env.GADDI_BRIDGE_BREAK_OUTLINE_STATE === '1';
const brokenChanged = process.env.GADDI_BRIDGE_BREAK_CHANGED === '1';
const brokenCheckedDescription = process.env.GADDI_BRIDGE_BREAK_CHECKED_DESCRIPTION === '1';

try {
  // Tests use Chrome for Testing beneath Gaddi/bin with a disposable profile.
  const bin = path.join(os.homedir(), 'Library/Application Support/Gaddi/bin');
  const candidates = fs.existsSync(bin) ? fs.readdirSync(bin, { recursive: true, encoding: 'utf8' })
    .filter(name => name.endsWith('Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')) : [];
  const executablePath = process.env.GADDI_CHROME || (candidates[0] && path.join(bin, candidates.sort().at(-1)!));
  if (!executablePath) {
    console.log('SKIP bridge extension: Chrome for Testing is not installed under Gaddi/bin');
    process.exitCode = 77;
  } else {
  assert.ok(fs.realpathSync(executablePath).startsWith(fs.realpathSync(bin) + path.sep), 'Testing binary must be under Gaddi/bin');
  assert.match(executablePath, /Google Chrome for Testing\.app\/Contents\/MacOS\/Google Chrome for Testing$/, 'Only Chrome for Testing may run this suite');
  fs.accessSync(executablePath, fs.constants.X_OK);
  const browserVersion = execFileSync(executablePath, ['--version'], { encoding: 'utf8', timeout: 10000 }).trim();
  console.log(`BROWSER binary: ${fs.realpathSync(executablePath)}`);
  console.log(`BROWSER version: ${browserVersion}`);
  backgroundGuard = watchHeadless(executablePath, [profile, path.join(state, 'single-client-profile')]);
  fs.cpSync(path.join(repo, 'extension'), extension, { recursive: true });
  const contentFile = path.join(extension, 'dist/extension/content.js');
  fs.writeFileSync(contentFile, instrumentVersion(instrumentLargeSignature(fs.readFileSync(contentFile, 'utf8'))));
  {
    const source = fs.readFileSync(contentFile, 'utf8');
    fs.writeFileSync(contentFile, source.replace('textReadAt = performance.now();', 'textReadAt = performance.now(); globalThis.waitTextReads = (globalThis.waitTextReads || 0) + 1;').replace('function matches() {', 'function matches() { const started = performance.now(); try {')
      .replace('/* WAIT_TEXT_END */', '/* WAIT_TEXT_END */ } finally { (globalThis.waitCheckCosts ||= []).push(performance.now() - started); }'));
  }
  if (process.env.GADDI_BRIDGE_BREAK_VISIBLE === '1') {
    const source = fs.readFileSync(contentFile, 'utf8');
    const marker = 'const viewportOnly = params.visible === true;';
    assert.ok(source.includes(marker));
    fs.writeFileSync(contentFile, source.replace(marker, 'const viewportOnly = false;'));
  }
  if (process.env.GADDI_BRIDGE_BREAK_WAIT === '1') {
    const source = fs.readFileSync(contentFile, 'utf8');
    assert.ok(source.includes('/* WAIT_CHECK_TEST_POINT */'));
    fs.writeFileSync(contentFile, source.replace('/* WAIT_CHECK_TEST_POINT */', 'return false;'));
  }
  if (process.env.GADDI_BRIDGE_BREAK_PRE_SCROLL_SIGNATURE === '1') {
    const source = fs.readFileSync(contentFile, 'utf8');
    const order = "el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });\n            const before = action === 'clickCheck' ? '' : signature();";
    assert.ok(source.includes(order), 'pre-scroll mutation point exists');
    fs.writeFileSync(contentFile, source.replace(order,
      "const before = action === 'clickCheck' ? '' : signature();\n            el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });"));
  }
  const bg = path.join(extension, 'dist/extension/bg.js');
  fs.writeFileSync(bg, fs.readFileSync(bg, 'utf8').replace("const NATIVE_HOST = 'com.abcastor.gaddi.bridge';", `const NATIVE_HOST = '${hostName}';`));
  for (const [variable, file, marker, replacement] of [
    ['GADDI_BRIDGE_BREAK_CAPTURE_SCROLL', contentFile, '/* CAPTURE_SCROLL_TEST_POINT */', "el.scrollIntoView({ block: 'center' });"],
    ['GADDI_BRIDGE_BREAK_CAPTURE_BOX', bg, 'box /* CAPTURE_BOX_TEST_POINT */', '/* target box omitted */'],
  ]) {
    if (process.env[variable] !== '1') continue;
    const source = fs.readFileSync(file, 'utf8');
    assert.ok(source.includes(marker), `capture mutation marker ${marker}`);
    fs.writeFileSync(file, source.replace(marker, replacement));
  }
  if (brokenInputFocus) {
    const source = fs.readFileSync(bg, 'utf8');
    const enable = "await send('Emulation.setFocusEmulationEnabled', { enabled: input });";
    assert.ok(source.includes(enable));
    fs.writeFileSync(bg, source.replace(enable, '/* focus enable removed in disposable copy */'));
  }
  for (const [enabled, file, marker, replacement] of [
    [brokenOutlineState, path.join(extension, 'dist/extension/content.js'), '/* OUTLINE_STATE_TEST_POINT */', 'return "";'],
    [brokenCheckedDescription, path.join(extension, 'dist/extension/content.js'), '/* CHECKED_DESCRIPTION_TEST_POINT */', 'return;'],
    [brokenChanged, bg, 'changed: before.signature !== after.signature', 'changed: false'],
  ] as const) {
    if (!enabled) continue;
    const source = fs.readFileSync(file, 'utf8');
    assert.ok(source.includes(marker), `Missing page state mutation marker: ${marker}`);
    fs.writeFileSync(file, source.replace(marker, replacement));
  }
  // Disposable copies only: each part of removing another extension's frame broken alone.
  for (const [variable, marker, replacement] of [
    ['GADDI_BRIDGE_BREAK_FOREIGN_REMOVE', 'el.remove();', ';'],
    ['GADDI_BRIDGE_BREAK_FOREIGN_SHADOW', 'shadow = globalThis.chrome?.dom?.openOrClosedShadowRoot(el) ?? null;', 'shadow = null;'],
  ]) {
    if (process.env[variable] !== '1') continue;
    const source = fs.readFileSync(contentFile, 'utf8');
    assert.equal(source.split(marker).length, 2, `foreign-frame mutation marker ${marker}`);
    fs.writeFileSync(contentFile, source.replace(marker, replacement));
  }
  if (brokenTypeReplacement) {
    const content = path.join(extension, 'dist/extension/content.js');
    const source = fs.readFileSync(content, 'utf8');
    assert.ok(source.includes('el.select();') && source.includes('selection?.addRange(range);'));
    fs.writeFileSync(content, source.replace('el.select();', ';').replace('selection?.addRange(range);', ';'));
  }
  if (restartOnly) {
    let source = fs.readFileSync(bg, 'utf8');
    if (process.env.GADDI_BRIDGE_BREAK_REQUEST_DEADLINE === '1') {
      const entry = 'withinDeadline(scope => dispatch(message, scope), message.deadline, () => nativePort === port)';
      assert.ok(source.includes(entry));
      source = source.replace(entry, 'dispatch(message, { check() {}, expired: new Promise(() => {}) })');
    }
    fs.writeFileSync(bg, restartInstrumentation + source);
  }
  if (brokenDeadline) {
    const source = fs.readFileSync(bg, 'utf8');
    const deadline = "return Promise.race([work, scope.expired]).finally";
    assert.ok(source.includes(deadline));
    fs.writeFileSync(bg, source.replace(deadline, 'return work.finally').replace('const running = Promise.race([work, scope.expired]);', 'const running = work;'));
  }
  if (brokenScreenshot) {
    const source = fs.readFileSync(bg, 'utf8');
    assert.ok(source.includes('y: cssVisualViewport.pageY'));
    fs.writeFileSync(bg, source.replace('y: cssVisualViewport.pageY', 'y: 0'));
  }
  if (brokenExplicitClose) {
    const source = fs.readFileSync(bg, 'utf8');
    const branch = "if (method === 'chrome.close') {";
    assert.ok(source.includes(branch));
    // Falsification changes only the disposable copy. Missing IDs must never
    // acquire authority to close whatever tab happens to be active.
    fs.writeFileSync(bg, source.replace(branch, branch + "\n    if (params.tabs === undefined) params.tabs = [(await getTab()).id];"));
  }
  if (broken) {
    const content = path.join(extension, 'dist/extension/content.js');
    const source = fs.readFileSync(content, 'utf8');
    assert.ok(source.includes('/* NAME_RESOLUTION_TEST_POINT */'));
    fs.writeFileSync(content, source.replace('/* NAME_RESOLUTION_TEST_POINT */', "return 'BROKEN_NAME_RESOLUTION';"));
  }
  const manifest: unknown = JSON.parse(fs.readFileSync(path.join(extension, 'manifest.json'), 'utf8'));
  assert.ok(isRecord(manifest) && typeof manifest.key === 'string');
  const id = [...crypto.createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32)]
    .map(c => String.fromCharCode(97 + parseInt(c, 16))).join('');
  const native: unknown = JSON.parse(fs.readFileSync(path.join(repo, 'bridge/com.abcastor.gaddi.bridge.json'), 'utf8'));
  assert.ok(isRecord(native));
  assert.deepEqual(native.allowed_origins, [`chrome-extension://${id}/`]);
  native.name = hostName; native.path = path.join(repo, 'bridge/host.sh');
  // Current Chrome uses --user-data-dir/NativeMessagingHosts. No registration is
  // made in the everyday Chrome directory or in the user's CfT default profile.
  const nativeDir = path.join(profile, 'NativeMessagingHosts');
  fs.mkdirSync(nativeDir, { recursive: true });
  fs.writeFileSync(path.join(nativeDir, `${hostName}.json`), JSON.stringify(native), { mode: 0o600 });
  await daemon.start();
  const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url));
  server = http.createServer((req, res) => {
    if (req.url === '/large.html') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(largeFixture()); return;
    }
    if (req.url === '/blocked-started') { blocked++; res.writeHead(204); res.end(); return; }
    if (req.url === '/redirect') { res.writeHead(302, { Location: '/slow' }); res.end(); return; }
    if (req.url === '/fail') { req.socket.destroy(); return; }
    if (req.url === '/stall') { stalled++; return; }
    if (req.url === '/slow') {
      const timer = setTimeout(() => {
        fixtureTimers.delete(timer);
        res.setHeader('Content-Type', 'text/html');
        res.end('<!doctype html><title>Delayed fixture</title><main>Delayed document complete</main>');
      }, 200);
      fixtureTimers.add(timer);
      return;
    }
    const filename = req.url?.split(/[?#]/)[0] === '/autonomy.html' ? 'autonomy.html' : req.url?.split(/[?#]/)[0] === '/foreign.html' ? 'foreign.html' : req.url === '/upload.html' ? 'upload.html' : req.url === '/version.html' ? 'version.html' : req.url === '/approval.html' ? 'approval.html' : req.url === '/state.html' ? 'state.html' : req.url === '/actions.html' ? 'actions.html' : req.url === '/input.html' ? 'input.html' : req.url === '/busy.html' ? 'busy.html' : req.url === '/bands.html' ? 'bands.html' : req.url?.split('?')[0] === '/next.html' ? 'next.html' : req.url === '/' ? 'index.html' : null;
    if (!filename) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(fs.readFileSync(path.join(fixtures, filename)));
  });
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  const launchOptions = {
    executablePath, headless: true, chromiumSandbox: true,
    viewport: { width: 1000, height: 760 },
    // Playwright defaults to a light-mode CDP override. Clearing the extension's
    // override restores Chrome's native preference, not that other client's
    // cached override. Leave media native so the reset baseline is meaningful.
    colorScheme: null, deviceScaleFactor: 2,
    ignoreDefaultArgs: ['--disable-extensions', '--headless'],
    // Match the headless display scale to the fixture's Retina CDP emulation.
    args: ['--headless=new', '--force-device-scale-factor=2', `--load-extension=${extension}`, `--disable-extensions-except=${extension}`, '--no-first-run', '--no-default-browser-check', '--host-resolver-rules=MAP gaddi-fixture.test 127.0.0.1'],
    env: { ...process.env, GADDI_SOCKET: sock, GADDI_BRIDGE_LOG: path.join(state, 'bridge.log') },
  };
  requireHeadless(launchOptions.args, launchOptions.headless);
  context = await chromium.launchPersistentContext(profile, launchOptions);
  backgroundGuard.check();
  let worker = await waitFor(() => context!.serviceWorkers().find(w => w.url().startsWith(`chrome-extension://${id}/`)), 'pinned extension service worker');
  await waitFor(() => daemon.attachments.length > 0, 'real Chrome native host attaches', 20000);
  pass(`native host attached from throwaway profile; extension id ${id}`);

  const page = context!.pages()[0] || await context.newPage();
  await page.goto(url);
  // Keep the fixture in the background for all bridge operations.
  const foreground = await context.newPage();
  await foreground.goto(`${url}next.html`);
  await foreground.bringToFront();
  if (restartOnly) {
    await restartDeadline({ context, worker, daemon, page, url, id, pass });
  } else {
  const { tabs } = await call('chrome.tabs');
  const tab = tabs.find(tab => tab.url === url)?.id;
  assert.ok(Number.isInteger(tab), 'Fixture tab is listed');
  const active = await call('chrome.active');
  assert.notEqual(active.id, tab);
  const beforeOrder = tabs.map(tab => tab.id);
  pass('chrome.tabs lists fixture and chrome.active identifies foreground tab');

  const description = await call('chrome.describe', { tab, selector: '#pay' });
  assert.equal(description.name, 'Procedi al pagamento', 'ASSERT_DESCRIBE_NAME');
  assert.equal(description.role, 'button');
  assert.equal((await call('chrome.describe', { tab, selector: '#icon' })).name, 'Continue safely');
  assert.equal((await call('chrome.describe', { tab, selector: '#referenced' })).name, 'Referenced button name');
  assert.equal((await call('chrome.describe', { tab, selector: '#icon span' })).name, 'Continue safely');
  assert.equal((await call('chrome.describe', { tab, selector: '#link' })).href, `${url}next.html`);
  await page.locator('#pay-submit').evaluate(el => (el as HTMLElement).focus());
  assert.equal((await call('chrome.describe', { tab, selector: ':focus' })).submitName, 'Pay');
  await page.locator('#implicit-submit').evaluate(el => (el as HTMLElement).focus());
  assert.equal((await call('chrome.describe', { tab, selector: ':focus' })).submitName, 'Preview');
  pass('chrome.describe resolves contents, aria-label, and aria-labelledby names');

  const read = await call('chrome.read', { tab });
  assert.match(read.text, /Local checkout/);
  assert.match(read.outline, /button "Procedi al pagamento" @[A-Za-z0-9_-]{6}:[0-9a-z]+/);
  assert.match(read.outline, /main "Checkout fixture" @[A-Za-z0-9_-]{6}:[0-9a-z]+/);
  assert.match(read.outline, /link "Next fixture page" @[A-Za-z0-9_-]{6}:[0-9a-z]+/);
  assert.match(read.outline, /textbox "Notes" value="" @[A-Za-z0-9_-]{6}:[0-9a-z]+/, 'ASSERT_OUTLINE_STATE');
  console.log(`PAGE_STATE_OUTLINE ${JSON.stringify({ beforeBytes: 1158, afterBytes: Buffer.byteLength(read.outline), lines: read.outline.split('\n').length })}`);
  const paySelector = read.outline.split('\n').find(line => line.startsWith('button "Procedi al pagamento"'))!.split(' ').at(-1);
  assert.equal((await call('chrome.describe', { tab, selector: paySelector })).name, description.name);
  assert.equal((await call('chrome.describe', { tab, selector: '#pay' })).selector, paySelector);
  await page.evaluate(() => { window.detachedPay = document.querySelector('#pay')!; window.detachedPay.remove(); });
  await call('chrome.read', { tab });
  await page.evaluate(() => document.querySelector('main')!.append(window.detachedPay));
  await call('chrome.read', { tab });
  assert.equal((await call('chrome.describe', { tab, selector: paySelector })).name, description.name);
  pass('chrome.read returns text, landmarks, interactive outline, and reusable selectors');

  await approvalPicture({ context, daemon, url, pass, captureDirectory: path.join(repo, 'tests/.state/context-captures') });
  await pageStateRead({ context, daemon, url, pass });

  const html = await call('chrome.html', { tab });
  assert.match(html.html, /id="pay"/);
  assert.equal(html.truncated, false);
  pass('chrome.html returns the fixture HTML');

  const imageSize = async (shot: ChromeResults['chrome.screenshot'], samples: [number, number][] = []) => {
    assert.equal(shot.mimeType, 'image/jpeg');
    const jpeg = Buffer.from(shot.data, 'base64');
    assert.equal(jpeg.subarray(0, 3).toString('hex'), 'ffd8ff');
    assert.ok(jpeg.length > 1000);
    return worker.evaluate(async ({ data, samples }) => {
      const image = await createImageBitmap(await (await fetch(`data:image/jpeg;base64,${data}`)).blob());
      const canvas = new OffscreenCanvas(image.width, image.height);
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(image, 0, 0);
      const pixels = samples.map(([x, y]) => [...ctx.getImageData(Math.floor(x * image.width), Math.floor(y * image.height), 1, 1).data].slice(0, 3));
      const size = { width: image.width, height: image.height, pixels }; image.close(); return size;
    }, { data: shot.data, samples });
  };
  const shot = await call('chrome.screenshot', { tab });
  const viewportImage = await imageSize(shot);
  const cssViewport = await page.evaluate(() => ({ width: document.documentElement.clientWidth, height: document.documentElement.clientHeight }));
  assert.ok(viewportImage.width <= cssViewport.width && viewportImage.height <= cssViewport.height);
  assert.ok(Math.max(viewportImage.width, viewportImage.height) <= 1568);
  assert.equal((await call('chrome.active')).id, active.id);
  assert.ok(viewportImage.width >= cssViewport.width - 2, `JPEG width ${viewportImage.width}, CSS width ${cssViewport.width}`);
  pass(`chrome.screenshot captures a ${viewportImage.width}x${viewportImage.height} JPEG at CSS size without raising the tab`);

  const bandsTab = (await call('chrome.open', { url: `${url}bands.html` })).id;
  const bandViewport = (await call('chrome.eval', { tab: bandsTab,
    expression: 'scrollTo(0, 1200); ({ width: innerWidth, height: innerHeight, contentHeight: document.documentElement.scrollHeight, y: scrollY })' })).value as { width: number; height: number; contentHeight: number; y: number };
  assert.equal(bandViewport.y, 1200, 'fixture scrolled by exactly one band');
  assert.ok(bandViewport.height < 1200, 'lower band fills the viewport');
  const scrolledImage = await imageSize(await call('chrome.screenshot', { tab: bandsTab }), [[0.5, 0.5]]);
  const matchesColor = (pixel: number[], expected: number[]) => pixel.every((v, i) => Math.abs(v - expected[i]) <= 3); // JPEG rounding
  assert.ok(matchesColor(scrolledImage.pixels[0], [0, 255, 0]),
    `ASSERT_SCROLLED_VIEWPORT_CENTER: expected green lower band, got ${scrolledImage.pixels[0]}`);
  assert.ok(Math.abs(scrolledImage.height - bandViewport.height) <= 2);
  assert.equal((await call('chrome.active')).id, active.id);
  pass('scrolled viewport JPEG centre is the green lower band, not the red top band');
  const fullBands = await imageSize(await call('chrome.screenshot', { tab: bandsTab, fullPage: true }),
    [[0.5, 1 / 6], [0.5, 0.5], [0.5, 5 / 6]]);
  for (const [i, color] of [[255, 0, 0], [0, 255, 0], [0, 0, 255]].entries()) {
    assert.ok(matchesColor(fullBands.pixels[i], color), `full-page band ${i}: ${fullBands.pixels[i]}`);
  }
  assert.ok(Math.abs(fullBands.height / fullBands.width - bandViewport.contentHeight / bandViewport.width) < 0.02);
  assert.ok(Math.max(fullBands.width, fullBands.height) <= 1568);
  assert.equal((await call('chrome.eval', { tab: bandsTab, expression: 'scrollY' })).value, bandViewport.y);
  await call('chrome.close', { tabs: [bandsTab] });
  pass('full-page JPEG includes all three bands while preserving the scrolled position');

  await call('chrome.click', { tab, selector: paySelector });
  assert.deepEqual(await page.evaluate(() => window.events.find(event => event.type === 'click')), { type: 'click', isTrusted: true });
  assert.ok(await page.evaluate(() => scrollY > 0));
  assert.equal((await call('chrome.active')).id, active.id);
  pass('chrome.click scrolls and fires trusted input without raising the tab');

  for (const selector of ['#password', '#current', '#new', '#focus-race']) {
    const denied = await daemon.request('chrome.type', { tab, selector, text: 'synthetic-test-value' });
    assert.match(denied.error?.message || '', /password/i, `Password refusal for ${selector}`);
    assert.equal(await page.locator(selector).inputValue(), '');
  }
  pass('chrome.type refuses password, both autocomplete values, and a focus-time type change');

  await call('chrome.type', { tab, selector: '#text', text: 'A local note' });
  assert.equal(await page.locator('#text').inputValue(), 'A local note');
  assert.deepEqual(await page.evaluate(() => window.events.find(event => event.type === 'input')), { type: 'input', isTrusted: true });
  await call('chrome.press', { tab, key: 'Enter' });
  assert.deepEqual(await page.evaluate(() => window.events.find(event => event.type === 'keydown')), { type: 'keydown', key: 'Enter', isTrusted: true });
  pass('chrome.type and chrome.press dispatch trusted input to an ordinary field');

  const blockedURL = await daemon.request('chrome.goto', { tab, url: 'javascript:document.title="wrong"' });
  assert.match(blockedURL.error?.message || '', /http/);
  for (const params of [{}, { tab }, { tabs: [] }, { tabs: null }, { tabs: '1' },
    { tabs: [tab, -1] }, { tabs: [1.5] }, { tabs: ['1'] }, { tabs: [Number.MAX_SAFE_INTEGER + 1] }, { tabs: Array(101).fill(tab) }]) {
    const prior = (await call('chrome.tabs')).tabs.map(info => info.id);
    const refused = await daemon.request('chrome.close', params);
    assert.match(refused.error?.message || '', /tabs/, 'ASSERT_EXPLICIT_CLOSE_TABS');
    assert.deepEqual((await call('chrome.tabs')).tabs.map(info => info.id), prior);
  }
  const externalPage = await context.newPage();
  await externalPage.goto(`${url}#external-tab`);
  const externalId = (await call('chrome.tabs')).tabs.find(info => info.url === `${url}#external-tab`)!.id;
  const humanId = await worker.evaluate(async url => {
    const human = await chrome.tabs.create({ url, active: false });
    const groupId = await chrome.tabs.group({ tabIds: [human.id!] });
    await chrome.tabGroups.update(groupId, { title: 'Human research', color: 'blue' });
    return human.id!;
  }, url);
  const external = [externalId, humanId];
  await foreground.bringToFront();
  const mixedClose = await call('chrome.close', { tabs: [external[0], 2147483647, external[1], external[0]] });
  assert.deepEqual(mixedClose.closed, external);
  assert.deepEqual(mixedClose.failed.map(item => item.tab), [2147483647]);
  assert.equal(typeof mixedClose.failed[0].reason, 'string');
  for (const restrictedURL of ['about:blank', 'chrome://extensions', `${url}fail`]) {
    const id = await worker.evaluate(async url => (await chrome.tabs.create({ url, active: false })).id!, restrictedURL);
    if (restrictedURL.endsWith('/fail')) await waitFor(async () => (await worker.evaluate(id => chrome.tabs.get(id), id)).status === 'complete', 'error page settles');
    assert.deepEqual(await call('chrome.close', { tabs: [id] }), { closed: [id], failed: [] });
  }
  assert.ok((await call('chrome.tabs')).tabs.every(info => !Object.hasOwn(info, 'owned')));
  pass('explicit close handles external tabs, human groups, mixed failures and restricted pages; malformed requests preserve every tab');

  await worker.evaluate(async url => {
    const root = (await chrome.bookmarks.getTree())[0].children!.find(node => node.children)!;
    const folder = await chrome.bookmarks.create({ parentId: root.id, title: 'Design fixtures' });
    await chrome.bookmarks.create({ parentId: folder.id, title: 'Checkout', url });
    await chrome.bookmarks.create({ parentId: folder.id, title: 'Next page', url: `${url}next.html` });
  }, url);
  const bookmarks = (await call('chrome.bookmarks')).bookmarks;
  assert.ok(bookmarks.some(mark => mark.path.endsWith('/Design fixtures') && mark.title === 'Checkout' && mark.url === url));
  assert.equal((await call('chrome.bookmarks', { query: 'DESIGN FIXTURES' })).bookmarks.length, 2);
  assert.equal((await call('chrome.bookmarks', { query: 'CHECKOUT' })).bookmarks.length, 1);
  assert.equal((await call('chrome.bookmarks', { query: 'NEXT.HTML' })).bookmarks.length, 1);
  pass('bookmarks list and case-insensitive folder, title and URL queries read the test tree');

  const evalDenied = await daemon.request('chrome.eval', { tab, expression: 'document.title' });
  assert.match(evalDenied.error?.message || '', /password/);
  await page.locator('#password').evaluate(el => el.setAttribute('value', 'synthetic-password-marker'));
  assert.ok(!(await call('chrome.html', { tab })).html.includes('synthetic-password-marker'));
  assert.equal(await page.locator('#password').getAttribute('value'), 'synthetic-password-marker');
  pass('password pages refuse eval and HTML redaction leaves the real DOM intact');

  await call('chrome.hover', { tab, selector: '#icon' });
  assert.equal(await page.locator('#icon').evaluate(el => el.matches(':hover')), true);
  await call('chrome.select', { tab, selector: '#choices', value: 'b' });
  assert.equal(await page.locator('#choices').inputValue(), 'b');
  await call('chrome.scroll', { tab, selector: '#pay' });
  assert.ok(await page.evaluate(() => scrollY > 100));
  const scrollBefore = await page.evaluate(() => scrollY);
  await call('chrome.scroll', { tab, dy: -300 });
  await waitFor(async () => (await page.evaluate(() => scrollY)) < scrollBefore, 'wheel scroll');
  const fullSize = await imageSize(await call('chrome.screenshot', { tab, fullPage: true }));
  assert.ok(fullSize.height > viewportImage.height, 'full-page JPEG is taller than viewport');
  assert.ok(Math.max(fullSize.width, fullSize.height) <= 1568);
  assert.ok(fullSize.height >= 1567, `full-page JPEG uses available resolution: ${fullSize.height}`);
  pass('hover, select, both scroll modes and full-page screenshots work on the background fixture');

  const oldRead = await call('chrome.read', { tab });
  await page.evaluate(() => {
    const node = document.createElement('p'); node.textContent = 'x'.repeat(25000); document.body.append(node);
  });
  assert.equal((await call('chrome.read', { tab })).text.length, 20000);
  assert.ok(oldRead.text.length < 20000);
  pass('chrome.read caps visible text at 20000 characters');

  const attachments = daemon.attachments.length;
  await daemon.stop();
  await daemon.start();
  await waitFor(() => daemon.attachments.length > attachments, 'native host reconnects to daemon');
  assert.ok((await call('chrome.tabs')).tabs.some(info => info.id === tab));
  pass('real extension connection survives a fake daemon restart');

  // Scoped to this copied .test extension; never enumerate or kill live hosts.
  const count = daemon.attachments.length;
  await worker.evaluate(() => globalThis.__gaddiBridgeTest!.disconnectNativePort());
  await waitFor(() => daemon.attachments.length > count, 'test native port reconnects', 15000);
  assert.ok((await call('chrome.tabs')).tabs.some(info => info.id === tab));
  pass('test native-port disconnect reconnects a fresh host');

  await call('chrome.goto', { tab, url: `${url}next.html` });
  assert.match((await call('chrome.html', { tab })).html, /Navigation worked/);
  const stale = await daemon.request('chrome.describe', { tab, selector: paySelector });
  assert.match(stale.error?.message || '', /Stale selector/);
  assert.equal((await call('chrome.active')).id, active.id);
  assert.deepEqual((await call('chrome.tabs')).tabs.map(info => info.id), beforeOrder);
  pass('chrome.goto navigates without activation or reordering; old selectors fail closed');

  const groupTitle = '● Design review · tests';
  const opened = await call('chrome.open', { url, group: groupTitle });
  assert.equal(opened.active, false);
  assert.equal((await call('chrome.active')).id, active.id);
  const afterOpen = (await call('chrome.tabs')).tabs;
  assert.deepEqual(afterOpen.filter(info => info.id !== opened.id).map(info => info.id), beforeOrder);
  assert.equal(afterOpen.length, beforeOrder.length + 1);
  pass('chrome.open creates a background tab and preserves existing tabs');

  assert.ok(!Object.hasOwn(opened, 'owned'));
  assert.equal(opened.group, groupTitle);
  const groupInfo = await worker.evaluate(async id => chrome.tabGroups.get((await chrome.tabs.get(id)).groupId), opened.id);
  assert.equal(groupInfo.title, groupTitle); assert.equal(groupInfo.color, 'cyan'); assert.equal(groupInfo.collapsed, true);
  const second = await call('chrome.open', { url, group: groupTitle });
  assert.equal(await worker.evaluate(async id => (await chrome.tabs.get(id)).groupId, second.id), groupInfo.id);
  await call('chrome.close', { tabs: [second.id] });
  pass('opens join a cyan collapsed circle group and the same label reuses it');

  const restarted = daemon.attachments.length;
  const workerControl = await context.newCDPSession(page);
  const versions = new Map<string, Protocol.ServiceWorker.ServiceWorkerVersion>();
  workerControl.on('ServiceWorker.workerVersionUpdated', ({ versions: updates }) => {
    for (const version of updates) versions.set(version.versionId, version);
  });
  await workerControl.send('ServiceWorker.enable');
  const version = await waitFor(() => [...versions.values()].find(version => version.scriptURL === worker.url()), 'test worker version');
  await workerControl.send('ServiceWorker.stopWorker', { versionId: version.versionId });
  await waitFor(() => versions.get(version.versionId)?.runningStatus === 'stopped', 'worker stopped');
  await workerControl.send('ServiceWorker.startWorker', { scopeURL: `chrome-extension://${id}/` });
  await waitFor(() => daemon.attachments.length > restarted, 'worker restart reconnects', 20000);
  worker = await waitFor(() => context!.serviceWorkers().find(w => w.url().startsWith(`chrome-extension://${id}/`)), 'restarted worker');
  await workerControl.detach();
  assert.equal((await call('chrome.tabs')).tabs.find(info => info.id === opened.id)!.group, groupTitle);
  pass('group membership survives an actual extension service-worker restart');
  await call('chrome.close', { tabs: [opened.id] });
  assert.deepEqual((await call('chrome.tabs')).tabs.map(info => info.id), beforeOrder);
  assert.equal((await call('chrome.active')).id, active.id);
  const fg = await call('chrome.open', { url, foreground: true });
  assert.equal((await call('chrome.active')).id, fg.id);
  await call('chrome.close', { tabs: [fg.id] });
  pass('explicit tabs close and foreground opt-in is explicit');

  const organizer = await worker.evaluate(async url => {
    const first = await chrome.tabs.create({ url, active: false });
    const neighbor = await chrome.tabs.create({ url, active: false });
    const other = await chrome.windows.create({ url, focused: false });
    return { first: first.id!, neighbor: neighbor.id!, foreign: other!.tabs![0].id!, window: first.windowId, foreignWindow: other!.id! };
  }, url);
  const shown = await call('chrome.show', { tab: organizer.foreign });
  assert.equal(shown.id, organizer.foreign); assert.equal(shown.active, true);
  // Window focus is the OS's to grant (a locked screen or another frontmost app refuses it),
  // so assert what the extension controls: the tab is the active tab of its own window.
  assert.equal((await worker.evaluate(id => chrome.tabs.query({ windowId: id, active: true }), organizer.foreignWindow))[0].id, organizer.foreign);
  await call('chrome.show', { tab: active.id });
  const regrouped = await call('chrome.group', { tabs: [organizer.first, organizer.foreign, organizer.first], group: groupTitle });
  assert.equal(regrouped.group, groupTitle);
  assert.deepEqual(regrouped.tabs.map(info => info.id), [organizer.first, organizer.foreign]);
  assert.ok(regrouped.tabs.every(info => info.windowId === organizer.window && info.group === groupTitle));
  const foreignFirst = await worker.evaluate(async url => (await chrome.windows.create({ url, focused: false }))!.tabs![0].id!, url);
  const reused = await call('chrome.group', { tabs: [foreignFirst, organizer.neighbor], group: groupTitle });
  assert.equal(reused.groupId, regrouped.groupId);
  assert.ok(reused.tabs.every(info => info.windowId === organizer.window));
  const groupBeforeOpen = await worker.evaluate(id => chrome.tabGroups.get(id), regrouped.groupId);
  assert.equal(groupBeforeOpen.title, groupTitle); assert.equal(groupBeforeOpen.color, 'cyan');
  const existingOrder = (await call('chrome.tabs')).tabs.map(info => info.id);
  const groupedOpen = await call('chrome.open', { url, group: groupTitle });
  assert.equal((await worker.evaluate(id => chrome.tabs.get(id), groupedOpen.id)).groupId, regrouped.groupId);
  assert.equal(groupedOpen.active, false);
  assert.deepEqual((await call('chrome.tabs')).tabs.filter(info => info.id !== groupedOpen.id).map(info => info.id), existingOrder);
  assert.deepEqual((await call('chrome.close', { tabs: [organizer.first, organizer.foreign, organizer.neighbor, foreignFirst, groupedOpen.id] })).failed, []);
  assert.equal((await call('chrome.active')).id, active.id);
  pass('show activates and focuses another window; grouping moves existing tabs into the first window and open reuses that group');

  assert.deepEqual((await call('chrome.eval', { tab, expression: 'window.fixtureState' })).value, { source: 'next fixture' });
  const baseWidth = await page.evaluate(() => document.documentElement.clientWidth);
  // Read through the same bridge that applies/resets the override.
  const darkNow = async () => (await call('chrome.eval', { tab, expression: "matchMedia('(prefers-color-scheme: dark)').matches" })).value;
  const baseDark = await darkNow();
  await call('chrome.emulate', { tab, width: 420, height: 700, mobile: false, colorScheme: baseDark ? 'light' : 'dark' });
  await call('chrome.screenshot', { tab });
  assert.equal(await page.evaluate(() => document.documentElement.clientWidth), 420);
  assert.equal(await darkNow(), !baseDark);
  await page.evaluate(() => {
    const element = document.createElement('div'); element.id = 'motion-fixture';
    element.style.cssText = 'width:10px;height:10px;background:red'; document.body.append(element);
    const style = document.createElement('style');
    style.textContent = '@keyframes fixture-motion { from { opacity: .2 } to { opacity: 1 } } #motion-fixture { animation: fixture-motion 100s linear infinite }';
    document.head.append(style);
    window.motion = element.getAnimations()[0];
  });
  const motionRatio = async () => page.evaluate(async () => {
    const wall = performance.now(), animation = Number(window.motion.currentTime), timeline = Number(document.timeline.currentTime);
    await new Promise(resolve => setTimeout(resolve, 650));
    const elapsed = performance.now() - wall;
    return { animation: (Number(window.motion.currentTime) - animation) / elapsed,
      timeline: (Number(document.timeline.currentTime) - timeline) / elapsed };
  });
  await call('chrome.emulate', { tab, animationSpeed: 0.1 });
  await waitFor(() => page.evaluate(() => window.motion.playbackRate === 0.1), 'CSS animation speed applied');
  const slowRatio = await motionRatio();
  assert.ok(slowRatio.animation > 0.03 && slowRatio.animation < 0.25, `slow animation ratio ${slowRatio.animation}`);
  assert.ok(slowRatio.timeline > 0.7 && slowRatio.timeline < 1.3, `document.timeline remains wall time ${slowRatio.timeline}`);
  await page.evaluate(() => { window.laterMotion = document.body.animate([{ opacity: 1 }, { opacity: .9 }], { duration: 100000, iterations: Infinity }); });
  await waitFor(() => page.evaluate(() => window.laterMotion.playbackRate === 0.1), 'later WAAPI animation slows');
  await call('chrome.emulate', { tab, reset: true });
  await waitFor(() => page.evaluate(() => window.motion.playbackRate === 1 && window.laterMotion.playbackRate === 1), 'animation rates restored');
  const resetRatio = await motionRatio();
  assert.ok(resetRatio.animation > 0.7 && resetRatio.animation < 1.3, `reset animation ratio ${resetRatio.animation}`);
  pass(`animationSpeed slows CSS/WAAPI motion (${slowRatio.animation.toFixed(3)}) and resets (${resetRatio.animation.toFixed(3)}); document.timeline stays wall time (${slowRatio.timeline.toFixed(3)})`);
  // Clearing the override restores the window; a scrollbar may toggle with the content, so allow 2 px.
  assert.ok(Math.abs((await page.evaluate(() => document.documentElement.clientWidth)) - baseWidth) <= 2, 'width restored after reset');
  assert.equal(await darkNow(), baseDark);
  await call('chrome.back', { tab });
  assert.match((await call('chrome.html', { tab })).html, /Local checkout/);
  assert.equal((await call('chrome.active')).id, active.id);
  pass('eval reads page globals, emulation persists through screenshot then resets, and back preserves focus');

  for (const endpoint of ['slow', 'redirect']) {
    const delayed = await call('chrome.open', { url: `${url}${endpoint}` });
    assert.match((await call('chrome.html', { tab: delayed.id })).html, /Delayed document complete/);
    await call('chrome.goto', { tab: delayed.id, url: `${url}next.html` });
    assert.match((await call('chrome.read', { tab: delayed.id })).text, /Navigation worked/);
    await call('chrome.back', { tab: delayed.id });
    assert.match((await call('chrome.html', { tab: delayed.id })).html, /Delayed document complete/);
    await call('chrome.close', { tabs: [delayed.id] });
  }
  pass('delayed and redirected open, goto and back support immediate reads without test-side waits');

  const originalIds = (await call('chrome.tabs')).tabs.map(info => info.id);
  for (const endpoint of ['fail', 'stall']) {
    // The extension owns a 20-second navigation deadline; the harness must wait
    // beyond it to assert the error reply and cleanup, not time out first.
    const failed = await daemon.request('chrome.open', { url: `${url}${endpoint}` }, 25000);
    assert.match(failed.error?.message || '', /Navigation/);
    assert.deepEqual((await call('chrome.tabs')).tabs.map(info => info.id), originalIds);
  }
  pass('failed and timed-out original opens clean up their own temporary tabs');

  const priorStalls = stalled;
  const takeoverOpen = daemon.request('chrome.open', { url: `${url}stall` });
  await waitFor(() => stalled > priorStalls, 'takeover fixture request started');
  const takeoverTab = (await call('chrome.tabs')).tabs.find(info => !originalIds.includes(info.id));
  assert.ok(takeoverTab && Number.isSafeInteger(takeoverTab.id));
  await worker.evaluate(({ id, url }) => chrome.tabs.update(id, { url }), { id: takeoverTab.id, url: `${url}next.html` });
  const takeoverReply = await takeoverOpen;
  assert.match(takeoverReply.error?.message || '', new RegExp(`tab ${takeoverTab.id} was preserved`));
  assert.ok((await call('chrome.tabs')).tabs.some(info => info.id === takeoverTab.id));
  assert.deepEqual(await call('chrome.close', { tabs: [takeoverTab.id] }), { closed: [takeoverTab.id], failed: [] });
  pass('navigation superseded from outside the bridge preserves the newly opened tab');

  // Prove reset with the extension as the ONLY CDP client as well. A passing
  // two-client check alone could hide a retained override behind Playwright's.
  await context.close();
  context = undefined;
  const singleProfile = path.join(state, 'single-client-profile');
  const singleNative = path.join(singleProfile, 'NativeMessagingHosts');
  fs.mkdirSync(singleNative, { recursive: true });
  fs.writeFileSync(path.join(singleNative, `${hostName}.json`), JSON.stringify(native), { mode: 0o600 });
  const beforeSingle = daemon.attachments.length;
  const foreignExtension = writeForeignExtension(state);
  const singleArgs = [
    '--headless=new',
    // The second extension is a test-only stand-in for a password manager's inline frame.
    `--user-data-dir=${singleProfile}`, `--load-extension=${extension},${foreignExtension}`,
    `--disable-extensions-except=${extension},${foreignExtension}`, '--no-first-run', '--no-default-browser-check', '--host-resolver-rules=MAP gaddi-fixture.test 127.0.0.1',
    '--disable-background-networking', '--disable-component-update', '--remote-debugging-port=0', 'about:blank',
  ];
  requireHeadless(singleArgs);
  singleClientChrome = spawn(executablePath, singleArgs, {
    env: { ...process.env, GADDI_SOCKET: sock, GADDI_BRIDGE_LOG: path.join(state, 'single-client-bridge.log') },
    stdio: 'ignore',
  });
  let launchError: Error | undefined;
  singleClientChrome.on('error', error => { launchError = error; });
  singleClientExit = new Promise(resolve => singleClientChrome!.once('close', resolve));
  await waitFor(() => {
    if (launchError) throw launchError;
    assert.equal(singleClientChrome!.exitCode, null, 'single-client Chrome remains running');
    return daemon.attachments.length > beforeSingle;
  }, 'single-client native host attaches', 20000);
  backgroundGuard.check();
  const singleTab = (await call('chrome.open', { url: `${url}next.html` })).id;
  const inspect = async (expression: string) => (await call('chrome.eval', { tab: singleTab, expression })).value;
  const nativeState = await inspect(`({ dark: matchMedia('(prefers-color-scheme: dark)').matches,
    width: document.documentElement.clientWidth, height: innerHeight })`) as { dark: boolean; width: number; height: number };
  await inspect('window.resetMarker = "keep this document"');
  for (const colorScheme of ['light', 'dark'] as const) {
    await call('chrome.emulate', { tab: singleTab, width: 420, height: 700, colorScheme });
    await call('chrome.screenshot', { tab: singleTab });
    assert.equal(await inspect("matchMedia('(prefers-color-scheme: dark)').matches"), colorScheme === 'dark');
    assert.equal(await inspect('document.documentElement.clientWidth'), 420);
    await call('chrome.emulate', { tab: singleTab, reset: true });
    assert.equal(await inspect("matchMedia('(prefers-color-scheme: dark)').matches"), nativeState.dark,
      `single-client ${colorScheme} reset restores native media immediately`);
    assert.ok(Math.abs(Number(await inspect('document.documentElement.clientWidth')) - nativeState.width) <= 2);
    assert.equal(await inspect('innerHeight'), nativeState.height);
    assert.equal(await inspect('window.resetMarker'), 'keep this document', 'reset preserves page state without reloading');
  }
  await call('chrome.goto', { tab: singleTab, url: `${url}slow` });
  assert.equal(await inspect("matchMedia('(prefers-color-scheme: dark)').matches"), nativeState.dark);
  pass('single-client light and dark reset restore native media and dimensions without reload or a lingering navigation override');

  // Lifecycle checks need native background visibility. A normal Playwright
  // launch forces focus emulation on every page; noDefaults keeps Chrome's state.
  if (!broken && !brokenExplicitClose && !brokenScreenshot) {
    const devtoolsPort = await waitFor(() => {
      const file = path.join(singleProfile, 'DevToolsActivePort');
      return fs.existsSync(file) && fs.readFileSync(file, 'utf8').split('\n')[0];
    }, 'isolated Chrome CDP port');
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${devtoolsPort}`, { noDefaults: true });
    context = browser.contexts()[0];
    worker = await waitFor(() => context!.serviceWorkers().find(w => w.url().startsWith(`chrome-extension://${id}/`)), 'native-visibility worker');
    if (process.env.GADDI_GUARDED_BENCHMARK_ONLY === '1') {
      await guardedBenchmark({ context, daemon, url });
    } else {
    await approvalPicture({ context, daemon, url, pass, captureDirectory: path.join(repo, 'tests/.state/context-captures-native') });
    await typeReplacement({ context, daemon, url, pass });
    await autonomousSetup({ context, daemon, url, pass });
    await nativeInput({ context, worker, daemon, url, pass });
    await pageStateInput({ context, worker, daemon, url, pass });
    await largePage({ context, worker, daemon, url, pass });
    await versionPage({ context, worker, daemon, url, pass });
    await waitChecks({ context, worker, daemon, url, pass });
    await visibleChecks({ context, daemon, url, pass });
    await pageRecovery({ context, worker, daemon, url, blockedCount: () => blocked, pass });
    await foreignFrame({ context, worker, daemon, url, pass });
    await uploadChecks({ context, daemon, url, pass });
    }
    await browser.close();
    context = undefined;
  }

  backgroundGuard.verify();
  pass('background browser guard: both Chrome processes used new headless mode throughout');
  }
  console.log(`== bridge extension: ${passed} passed`);
  }
} catch (error) {
  console.error(`FAIL bridge extension: ${error instanceof Error ? error.stack : String(error)}`);
  const hostLog = path.join(state, 'bridge.log');
  if (fs.existsSync(hostLog)) console.error(fs.readFileSync(hostLog, 'utf8'));
  process.exitCode = 1;
} finally {
  backgroundGuard?.stop();
  await context?.close();
  if (singleClientChrome) {
    singleClientChrome.kill('SIGTERM');
    const killTimer = setTimeout(() => singleClientChrome!.kill('SIGKILL'), 5000);
    await singleClientExit;
    clearTimeout(killTimer);
  }
  await daemon.stop();
  for (const timer of fixtureTimers) clearTimeout(timer);
  if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); }
  fs.rmSync(state, { recursive: true, force: true }); // Disposable profile and test host registration only.
  try { fs.rmdirSync(root); } catch { /* Another test owns a sibling run. */ }
}
