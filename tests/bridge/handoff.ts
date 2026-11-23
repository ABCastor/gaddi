import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright-core';
import type { BrowserContext, Worker } from 'playwright-core';
import { FakeDaemon, waitFor } from './fake-daemon.ts';
import { requireHeadless, watchHeadless } from './background.ts';

// HANDOFF-SHOW against a real Chrome for Testing with the unpacked extension and real native host.
// Agents work in Gaddi's own window, created minimized. An explicit handoff (show, foreground open) must make the
// tab visible: the window that holds it leaves the minimized state with that tab active, keeping the user's own
// size and position. Ordinary background work (open, look, click, type) leaves every window as it was: still
// minimized, unfocused, no other window restored or focused. The oracle is Chrome's own chrome.windows state,
// read from the extension's service worker, never the extension's return values.
// Disposable profile; headless=new by default (GADDI_HANDOFF_HEADFUL=1 runs the same journey with a visible window).
const repo = path.resolve(import.meta.dirname, '../..');
fs.mkdirSync(path.join(repo, 'tests/.state-bridge'), { recursive: true });
const state = fs.mkdtempSync(path.join(repo, 'tests/.state-bridge/handoff-'));
const profile = path.join(state, 'profile'), extension = path.join(state, 'extension');
const socket = path.join(os.tmpdir(), `gaddi-handoff-${process.pid}.sock`);
// The shipped default: agents in Gaddi's own window, show asks for attention without taking focus.
const daemon = new FakeDaemon(socket, { window: 'own', show: 'attention' });
const headful = process.env.GADDI_HANDOFF_HEADFUL === '1';
const mutation = process.env.GADDI_HANDOFF_BREAK ?? '';
let context: BrowserContext | undefined, guard: ReturnType<typeof watchHeadless> | undefined, passed = 0;
const pass = (label: string) => { passed++; console.log(`PASS ${label}`); };
const PAGE = (title: string, text: string) => `<!doctype html><title>${title}</title><main><h1>${text}</h1>
<input id="code" aria-label="Code"><button id="go" onclick="this.textContent='pressed'">Continue</button></main>`;
const server = http.createServer((req, res) => {
  const route = req.url?.split(/[?#]/)[0];
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (route === '/key.html') res.end(PAGE('Security key', 'Security key needed: touch your key'));
  else if (route === '/owner.html') res.end(PAGE('Owner work', 'The owner is working here'));
  else if (route === '/other.html') res.end(PAGE('Other window', 'An unrelated minimized window'));
  else if (route === '/quiet.html') res.end(PAGE('Background', 'Background agent work'));
  else { res.writeHead(404); res.end(); }
});
// Each mutation undoes or widens one piece of HANDOFF-SHOW in the disposable copy only.
const mutations: Record<string, [string | RegExp, string]> = {
  // Show goes back to the 16 Nov behaviour: activate the tab and ask for attention, never restore.
  SHOW: [/await handOff\(tab\.windowId, (\{ \.\.\.\(browser\.show === 'front' \? \{ focused: true \} : \{\}\), drawAttention: true \}), check\);/,
    'await chrome.windows.update(tab.windowId, $1);'],
  // Foreground open selects its tab but no longer restores the window.
  OPEN: ['await handOff(opened.windowId, {}, check);', 'void 0;'],
  // Background open restores too: ordinary work would surface the window.
  QUIET: [/if \(params\.foreground === true\)(\s+await handOff\(opened\.windowId)/, 'if (true)$1'],
  // The handoff restores every window, not only the one holding the tab.
  OTHER: ['await chrome.windows.update(windowId, { ...(current.state',
    'for (const other of await chrome.windows.getAll()) await chrome.windows.update(other.id, { ...(current.state'],
  // The restore replaces the user's own size and position with fixed bounds.
  BOUNDS: ["{ state: 'normal' }", "{ state: 'normal', left: 0, top: 0, width: 640, height: 480 }"],
};
try {
  const bin = path.join(os.homedir(), 'Library/Application Support/Gaddi/bin');
  const candidates = fs.existsSync(bin) ? fs.readdirSync(bin, { recursive: true, encoding: 'utf8' })
    .filter(name => name.endsWith('Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')).sort() : [];
  const executablePath = process.env.GADDI_CHROME || (candidates.length ? path.join(bin, candidates.at(-1)!) : '');
  if (!executablePath) { console.log('SKIP handoff: Chrome for Testing is not installed under Gaddi/bin'); process.exit(77); }
  assert.ok(fs.realpathSync(executablePath).startsWith(fs.realpathSync(bin) + path.sep), 'Testing binary must be under Gaddi/bin');
  assert.match(executablePath, /Google Chrome for Testing\.app\/Contents\/MacOS\/Google Chrome for Testing$/, 'Only Chrome for Testing may run this suite');
  fs.cpSync(path.join(repo, 'extension'), extension, { recursive: true });
  const hostName = 'com.abcastor.gaddi.bridge.test';
  const bg = path.join(extension, 'dist/extension/bg.js');
  let source = fs.readFileSync(bg, 'utf8').replace("const NATIVE_HOST = 'com.abcastor.gaddi.bridge';", `const NATIVE_HOST = '${hostName}';`);
  if (mutation) {
    const [marker, replacement] = mutations[mutation] ?? assert.fail(`unknown mutation ${mutation}`);
    const count = typeof marker === 'string' ? source.split(marker).length - 1 : (source.match(new RegExp(marker, 'g')) ?? []).length;
    assert.equal(count, 1, `handoff mutation point ${mutation} exists once`);
    source = source.replace(marker, replacement);
  }
  fs.writeFileSync(bg, source);
  const manifest = JSON.parse(fs.readFileSync(path.join(extension, 'manifest.json'), 'utf8')) as { key: string };
  const id = [...crypto.createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32)]
    .map(c => String.fromCharCode(97 + parseInt(c, 16))).join('');
  const nativeDir = path.join(profile, 'NativeMessagingHosts');
  fs.mkdirSync(nativeDir, { recursive: true });
  fs.writeFileSync(path.join(nativeDir, `${hostName}.json`), JSON.stringify({
    name: hostName, description: 'Handoff test host', type: 'stdio', path: path.join(repo, 'bridge/host.sh'), allowed_origins: [`chrome-extension://${id}/`],
  }));
  await daemon.start();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const site = `http://localhost:${(server.address() as AddressInfo).port}`;
  const args = [...(headful ? [] : ['--headless=new']), `--load-extension=${extension}`, `--disable-extensions-except=${extension}`,
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update'];
  if (!headful) { requireHeadless(args); guard = watchHeadless(executablePath, [profile]); }
  else console.log('NOTE handoff: headful run requested (GADDI_HANDOFF_HEADFUL=1); a Chrome for Testing window will appear');
  context = await chromium.launchPersistentContext(profile, {
    executablePath, headless: !headful, chromiumSandbox: true, viewport: null,
    ignoreDefaultArgs: ['--disable-extensions', '--headless'], args,
    env: { ...process.env, GADDI_SOCKET: socket, GADDI_BRIDGE_LOG: path.join(state, 'bridge.log') },
  });
  const worker: Worker = await waitFor(() => context!.serviceWorkers().find(w => w.url().startsWith(`chrome-extension://${id}/`)), 'extension worker');
  await waitFor(() => daemon.attachments.length > 0, 'native host attaches', 20000);
  const call = async <T = Record<string, unknown>>(method: string, params: object = {}) => await daemon.call(method, params) as T;
  type Win = { id: number; state: string; focused: boolean; left: number; top: number; width: number; height: number; active?: number; tabs: number[] };
  const windows = async (): Promise<Win[]> => await worker.evaluate(async () => (await chrome.windows.getAll({ populate: true })).map(w => ({
    id: w.id!, state: w.state!, focused: w.focused, left: w.left!, top: w.top!, width: w.width!, height: w.height!,
    active: w.tabs?.find(t => t.active)?.id, tabs: (w.tabs ?? []).map(t => t.id!) })));
  const win = async (windowId: number) => (await windows()).find(w => w.id === windowId) ?? assert.fail(`window ${windowId} is gone`);
  const record = async (label: string) => console.log(`STATE ${label}: ${JSON.stringify(await windows())}`);
  // Headless Chrome restores a window asked to minimize while already minimized, so ask only once.
  // Headless Chrome restores a window asked to minimize while already minimized, so ask only when needed.
  const minimize = async (windowId: number) => {
    if ((await win(windowId)).state === 'minimized') return;
    await worker.evaluate(async windowId => { await chrome.windows.update(windowId, { state: 'minimized' }); }, windowId);
    await waitFor(async () => (await win(windowId)).state === 'minimized', `window ${windowId} minimized`);
  };
  const settle = () => new Promise(resolve => setTimeout(resolve, 400));

  // The user's own window, with their page in front, and an unrelated second window they minimized.
  const ownerPage = context.pages()[0] ?? await context.newPage();
  await ownerPage.goto(`${site}/owner.html`);
  const owner = await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    return tab.windowId;
  });
  const other = await worker.evaluate(async url => {
    const created = (await chrome.windows.create({ url, focused: false, type: 'normal' }))!;
    await chrome.windows.update(created.id!, { state: 'minimized' });
    return created.id!;
  }, `${site}/other.html`);
  await waitFor(async () => (await win(other)).state === 'minimized', 'unrelated window minimized');
  const otherBefore = await win(other);

  // Background work creates Gaddi's window minimized and leaves it so (QUIET).
  const keyTab = (await call<{ id: number; windowId: number }>('chrome.open', { url: `${site}/key.html` }));
  const gaddi = keyTab.windowId;
  assert.notEqual(gaddi, owner, 'agent tabs live in Gaddi\'s own window');
  // Chrome asks for a minimized window at creation; headful macOS Chrome creates it normal (observed 23 Nov 2026),
  // headless honours it. Either way the field state is a minimized Gaddi window, so the journey starts from there.
  console.log(`OBSERVED Gaddi window state at creation: ${(await win(gaddi)).state}`);
  await minimize(gaddi);
  await call('chrome.read', { tab: keyTab.id });
  await call('chrome.click', { tab: keyTab.id, selector: '#go' });
  await call('chrome.type', { tab: keyTab.id, selector: '#code', text: '123' });
  const quiet = await call<{ id: number; windowId: number }>('chrome.open', { url: `${site}/quiet.html` });
  await settle();
  await record('after background open/look/click/type');
  {
    const g = await win(gaddi), o = await win(other);
    assert.equal(quiet.windowId, gaddi, 'background tabs share Gaddi\'s window');
    assert.equal(g.state, 'minimized', 'ASSERT_HANDOFF_QUIET: background open/look/click/type keep Gaddi\'s window minimized');
    assert.equal(g.focused, false, 'ASSERT_HANDOFF_QUIET: background work never focuses Gaddi\'s window');
    assert.equal(o.state, 'minimized', 'ASSERT_HANDOFF_OTHER_WINDOW: background work leaves the unrelated window minimized');
  }
  pass('background open/look/click/type: Gaddi window stays minimized and unfocused, unrelated window untouched');

  // The user once gave Gaddi's window their own size and position, then minimized it.
  await worker.evaluate(async windowId => {
    await chrome.windows.update(windowId, { state: 'normal' });
    await chrome.windows.update(windowId, { left: 120, top: 90, width: 900, height: 640 });
  }, gaddi);
  await waitFor(async () => { const g = await win(gaddi); return g.state === 'normal' && g.width === 900; }, 'owner bounds applied');
  const ownBounds = await win(gaddi);
  await minimize(gaddi);
  await worker.evaluate(async windowId => { await chrome.windows.update(windowId, { focused: true }); }, owner);
  await record('baseline before show (Gaddi minimized)');

  // HANDOFF-SHOW: an explicit show of the security-key tab.
  const shown = await call<{ id: number; active: boolean; windowId: number }>('chrome.show', { tab: keyTab.id });
  assert.equal(shown.id, keyTab.id);
  await settle();
  await record('after chrome.show');
  {
    const g = await win(gaddi), o = await win(other);
    assert.notEqual(g.state, 'minimized', 'ASSERT_HANDOFF_SHOW: show restores Gaddi\'s window from minimized');
    assert.equal(g.active, keyTab.id, 'ASSERT_HANDOFF_SHOW: the shown tab is the active tab of its window');
    assert.deepEqual([g.left, g.top, g.width, g.height], [ownBounds.left, ownBounds.top, ownBounds.width, ownBounds.height],
      'ASSERT_HANDOFF_BOUNDS: the restored window keeps the owner\'s own size and position');
    assert.equal(o.state, 'minimized', 'ASSERT_HANDOFF_OTHER_WINDOW: show leaves the unrelated window minimized');
    assert.equal(o.focused, false, 'ASSERT_HANDOFF_OTHER_WINDOW: show never focuses the unrelated window');
    assert.deepEqual([o.left, o.top, o.width, o.height], [otherBefore.left, otherBefore.top, otherBefore.width, otherBefore.height],
      'ASSERT_HANDOFF_OTHER_WINDOW: the unrelated window keeps its bounds');
  }
  pass('show from minimized: Gaddi window restored with the owner\'s bounds, the shown tab active, unrelated window untouched');

  // After the handoff, background work again leaves the window as the user left it.
  await minimize(gaddi);
  const later = await call<{ id: number; windowId: number }>('chrome.open', { url: `${site}/quiet.html` });
  await call('chrome.read', { tab: later.id });
  await settle();
  assert.equal((await win(gaddi)).state, 'minimized', 'ASSERT_HANDOFF_QUIET: background open after a handoff keeps the window minimized');
  pass('background open after a handoff: still minimized');

  // HANDOFF-SHOW also covers foreground open.
  const front = await call<{ id: number; windowId: number }>('chrome.open', { url: `${site}/key.html`, foreground: true });
  await settle();
  await record('after foreground chrome.open');
  {
    const g = await win(front.windowId), o = await win(other);
    assert.equal(front.windowId, gaddi, 'foreground open uses Gaddi\'s window');
    assert.notEqual(g.state, 'minimized', 'ASSERT_HANDOFF_OPEN: foreground open restores Gaddi\'s window from minimized');
    assert.equal(g.active, front.id, 'ASSERT_HANDOFF_OPEN: the new tab is the active tab of its window');
    assert.equal(o.state, 'minimized', 'ASSERT_HANDOFF_OTHER_WINDOW: foreground open leaves the unrelated window minimized');
    assert.equal(o.focused, false, 'ASSERT_HANDOFF_OTHER_WINDOW: foreground open never focuses the unrelated window');
  }
  pass('foreground open from minimized: Gaddi window restored, the new tab active, unrelated window untouched');
  guard?.verify();
  if (guard) pass('background browser guard: Chrome ran in new headless mode throughout');
  console.log(`== handoff: ${passed} passed, 0 failed`);
} catch (error) {
  const log = path.join(state, 'bridge.log');
  if (fs.existsSync(log)) console.log(fs.readFileSync(log, 'utf8').split('\n').slice(-10).join('\n'));
  throw error;
} finally {
  guard?.stop();
  await context?.close().catch(() => {});
  await daemon.stop();
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  fs.rmSync(state, { recursive: true, force: true }); // Only this disposable fixture/profile.
}
