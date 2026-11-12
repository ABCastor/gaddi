import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { FakeDaemon, waitFor } from './fake-daemon.ts';
import { requireHeadless, watchHeadless } from './background.ts';

// Clicks on React-driven widgets must change the app's state, not only the DOM: a radio hidden inside its
// label, and an rc-select option in a list that closes when its input loses focus. Real extension and native
// host, disposable headless Chrome, the fixture tab kept behind another tab as an agent's tab is.
const repo = path.resolve(import.meta.dirname, '../..');
fs.mkdirSync(path.join(repo, 'tests/.state-bridge'), { recursive: true });
const state = fs.mkdtempSync(path.join(repo, 'tests/.state-bridge/react-'));
const profile = path.join(state, 'profile'), extension = path.join(state, 'extension');
const socket = path.join(os.tmpdir(), `gaddi-react-${process.pid}.sock`);
const daemon = new FakeDaemon(socket);
let chromeProcess: ReturnType<typeof spawn> | undefined, chromeExit: Promise<unknown> | undefined;
let guard: ReturnType<typeof watchHeadless> | undefined, passed = 0;
// The fixture reports its state here; the newest report wins (beacons can arrive out of order).
let reported: { seq: number; state: Record<string, string>; events: unknown[]; focus: boolean } = { seq: 0, state: {}, events: [], focus: false };
const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/event') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => { const next = JSON.parse(body) as typeof reported; if (next.seq > reported.seq) reported = next; res.writeHead(204); res.end(); });
    return;
  }
  if (req.url?.split('?')[0] === '/front.html') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Front</title><main>The person works here</main>'); return; }
  if (req.url?.split('?')[0] !== '/react.html') { res.writeHead(404); res.end(); return; }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(fs.readFileSync(path.join(repo, 'tests/bridge/fixtures/react.html')));
});
type Described = { selector: string; name: string; href: string };
async function click(tab: number, selector: string) {
  // As the broker does: describe first, then click with the description it checked.
  const described = await daemon.call('chrome.describe', { tab, selector }) as Described;
  return await daemon.call('chrome.click', { tab, selector: described.selector, checkedDescription: { name: described.name, href: described.href } }) as { changed?: boolean };
}
// A beacon leaves after the handler ran; give it a moment to land.
const appState = async () => { await new Promise(resolve => setTimeout(resolve, 150)); return reported.state; };
const appEvents = () => JSON.stringify(reported.events);
try {
  const bin = path.join(os.homedir(), 'Library/Application Support/Gaddi/bin');
  const candidates = fs.existsSync(bin) ? fs.readdirSync(bin, { recursive: true, encoding: 'utf8' })
    .filter(name => name.endsWith('Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')).sort() : [];
  const executablePath = process.env.GADDI_CHROME || (candidates.length ? path.join(bin, candidates.at(-1)!) : '');
  if (!executablePath) { console.log('SKIP react widgets: Chrome for Testing is not installed under Gaddi/bin'); process.exit(77); }
  assert.ok(fs.realpathSync(executablePath).startsWith(fs.realpathSync(bin) + path.sep));
  assert.match(executablePath, /Google Chrome for Testing\.app\/Contents\/MacOS\/Google Chrome for Testing$/);
  fs.cpSync(path.join(repo, 'extension'), extension, { recursive: true });
  const hostName = 'com.abcastor.gaddi.bridge.test';
  const bg = path.join(extension, 'dist/extension/bg.js');
  fs.writeFileSync(bg, fs.readFileSync(bg, 'utf8').replace("const NATIVE_HOST = 'com.abcastor.gaddi.bridge';", `const NATIVE_HOST = '${hostName}';`));
  const mutation = process.env.GADDI_REACT_BREAK;
  if (mutation) {
    // Disposable copy only: one guarantee removed, so its assertion must go red.
    const markers: Record<string, [string, string, string]> = {
      // No patience: a choice the page answers late reads as no change.
      PATIENT: [bg, 'for (const until = Date.now() + patientMs; /* PATIENT_TEST_POINT */', 'for (const until = Date.now(); /* PATIENT_TEST_POINT */'],
      // No page click for a hidden choice: the closed list's option cannot be pressed.
      HIDDEN: [path.join(extension, 'dist/extension/content.js'), "if (choice && action === 'clickPoint')", 'if (false)'],
    };
    assert.ok(mutation in markers, 'known react widget mutation');
    const [file, marker, replacement] = markers[mutation];
    const source = fs.readFileSync(file, 'utf8');
    assert.equal(source.split(marker).length, 2, `react widget mutation point ${mutation}`);
    fs.writeFileSync(file, source.replace(marker, replacement));
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(extension, 'manifest.json'), 'utf8')) as { key: string };
  const id = [...crypto.createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32)]
    .map(c => String.fromCharCode(97 + parseInt(c, 16))).join('');
  const nativeDir = path.join(profile, 'NativeMessagingHosts');
  fs.mkdirSync(nativeDir, { recursive: true });
  fs.writeFileSync(path.join(nativeDir, `${hostName}.json`), JSON.stringify({
    name: hostName, description: 'React widget test host', type: 'stdio', path: path.join(repo, 'bridge/host.sh'), allowed_origins: [`chrome-extension://${id}/`],
  }));
  await daemon.start();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const site = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const args = ['--headless=new', `--user-data-dir=${profile}`, `--load-extension=${extension}`, `--disable-extensions-except=${extension}`,
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--remote-debugging-port=0', 'about:blank'];
  requireHeadless(args);
  guard = watchHeadless(executablePath, [profile]);
  chromeProcess = spawn(executablePath, args, { env: { ...process.env, GADDI_SOCKET: socket, GADDI_BRIDGE_LOG: path.join(state, 'bridge.log') }, stdio: 'ignore' });
  let launchError: Error | undefined;
  chromeProcess.on('error', error => { launchError = error; });
  chromeExit = new Promise(resolve => chromeProcess!.once('close', resolve));
  await waitFor(() => { if (launchError) throw launchError; return daemon.attachments.length; }, 'react widgets native host', 20000);
  const port = await waitFor(() => {
    const file = path.join(profile, 'DevToolsActivePort');
    return fs.existsSync(file) && fs.readFileSync(file, 'utf8').split('\n')[0];
  }, 'react widgets Chrome port');
  assert.ok(port);
  // No second debugger client attaches to these tabs: one that turns on focus emulation (Playwright does)
  // would hide exactly the focus effects this test is about. The fixture reports its own state instead.
  const opened = await daemon.call('chrome.open', { url: `${site}/react.html` }) as { id: number };
  const tab = opened.id;
  await waitFor(() => reported.seq > 0 || daemon.call('chrome.wait', { tab, selector: '#status', timeout: 5000 }), 'react fixture loaded');
  // The agent's tab sits behind the tab the person is using.
  await daemon.call('chrome.open', { url: `${site}/front.html`, foreground: true });

  // The case portal's radio: its visible span is what an agent sees and clicks. The page answers late.
  const chosen = await click(tab, 'label[for="choice-yes"] .radio-btn');
  // Gaddi must not report "changed nothing" for a click the page is still answering (it misled an agent on 12 Nov).
  assert.equal(chosen.changed, true, `ASSERT_REACT_LATE_CHANGE_SEEN ${JSON.stringify(chosen)}`);
  await waitFor(async () => (await appState()).existing === 'yes', 'the app accepted the answer', 3000)
    .catch(() => assert.fail(`ASSERT_REACT_LABEL_RADIO ${appEvents()}`));
  // A radio with display:none inside its label, no for=.
  await click(tab, '#account label:nth-child(2)');
  assert.equal((await appState()).account, 'business', `ASSERT_REACT_HIDDEN_RADIO ${appEvents()}`);
  passed++; console.log('PASS react radios: label clicks change the app state (hidden and display:none inputs)');

  // rc-select: open, look as an agent does, then pick an option.
  await click(tab, '#contact');
  await daemon.call('chrome.read', { tab });
  await click(tab, '#contact-list [title="Email"]');
  assert.equal((await appState()).contact, 'Email', `ASSERT_REACT_SELECT_OPTION ${appEvents()}`);
  // The list closes when its input loses focus, as rc-select's does when the window loses focus between two agent
  // actions. The option the agent picked from its last look is then hidden: it is still chosen, through the page.
  await click(tab, '#contact');
  await daemon.call('chrome.eval', { tab, expression: 'document.activeElement.blur(), true' });
  await waitFor(async () => (await appState(), reported.events.filter(event => (event as { type: string }).type === 'close').length >= 2), 'list closed');
  let picked: { changed?: boolean; note?: string } | undefined;
  try { picked = await click(tab, '#contact-list [title="Phone"]'); } catch (error) { assert.fail(`ASSERT_REACT_HIDDEN_OPTION click refused: ${String(error)}`); }
  assert.equal((await appState()).contact, 'Phone', `ASSERT_REACT_HIDDEN_OPTION ${appEvents()} ${JSON.stringify(picked)}`);
  passed++; console.log('PASS react select: an option changes the app state, also when its list closed between actions');
  guard.verify();
  console.log(`== react widgets: ${passed} passed, 0 failed`);
} catch (error) {
  const log = path.join(state, 'bridge.log');
  if (fs.existsSync(log)) console.log(fs.readFileSync(log, 'utf8').split('\n').slice(-20).join('\n'));
  throw error;
} finally {
  guard?.stop();
  if (chromeProcess) {
    chromeProcess.kill('SIGTERM');
    const timer = setTimeout(() => chromeProcess!.kill('SIGKILL'), 5000);
    await chromeExit; clearTimeout(timer);
  }
  await daemon.stop();
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  fs.rmSync(state, { recursive: true, force: true }); // Only this disposable fixture/profile.
}
