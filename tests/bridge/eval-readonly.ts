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

// EVAL-READONLY against a real page: every known way a script could act (click, submit, dispatched events, navigation,
// requests, storage, timers, promise callbacks, getters, eval, another frame) is refused before it happens, and reads
// still work. Real extension and native host, disposable headless Chrome. The oracle is the fixture's own server: a
// page that acted calls home (a beacon, a form post, a navigation), and nothing but the two fixture pages may arrive.
const repo = path.resolve(import.meta.dirname, '../..');
fs.mkdirSync(path.join(repo, 'tests/.state-bridge'), { recursive: true });
const state = fs.mkdtempSync(path.join(repo, 'tests/.state-bridge/eval-'));
const profile = path.join(state, 'profile'), extension = path.join(state, 'extension');
const socket = path.join(os.tmpdir(), `gaddi-eval-${process.pid}.sock`);
const daemon = new FakeDaemon(socket);
let chromeProcess: ReturnType<typeof spawn> | undefined, chromeExit: Promise<unknown> | undefined;
let guard: ReturnType<typeof watchHeadless> | undefined, passed = 0;
const PAGE = `<!doctype html><title>Eval fixture</title>
<form id="f" action="/submitted" method="post"><input id="q" name="q" value="v">
<label><input type="radio" name="plan" id="plan" value="monthly"> Pay Monthly Mobile</label>
<button id="pay" type="submit">Pay now</button></form>
<a id="link" href="/navigated">Go</a>
<iframe id="fr" src="/inner.html"></iframe>
<div id="d" style="width:10px">hello <span>world</span></div>
<script>
const hit = what => navigator.sendBeacon('/hit?' + what);
document.getElementById('pay').addEventListener('click', () => hit('click'));
document.getElementById('f').addEventListener('submit', () => hit('submit'));
document.getElementById('plan').addEventListener('change', () => hit('change'));
document.addEventListener('keydown', () => hit('key'));
window.app = { state: { n: 1 }, get armed() { hit('getter'); return true; } };
window.later = new Promise(resolve => setTimeout(resolve, 50));
</script>`;
const INNER = `<!doctype html><title>Inner</title><button id="ib" onclick="navigator.sendBeacon('/hit?inner')">Send</button>`;
// Everything the browser asked the fixture for, after the pages themselves.
const arrived: string[] = [];
const server = http.createServer((req, res) => {
  const url = req.url ?? '';
  if (url === '/page.html') { res.setHeader('Content-Type', 'text/html'); res.end(PAGE); return; }
  if (url === '/inner.html') { res.setHeader('Content-Type', 'text/html'); res.end(INNER); return; }
  if (url !== '/favicon.ico') arrived.push(`${req.method} ${url}`);
  res.writeHead(204); res.end();
});
try {
  const bin = path.join(os.homedir(), 'Library/Application Support/Gaddi/bin');
  const candidates = fs.existsSync(bin) ? fs.readdirSync(bin, { recursive: true, encoding: 'utf8' })
    .filter(name => name.endsWith('Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')).sort() : [];
  const executablePath = process.env.GADDI_CHROME || (candidates.length ? path.join(bin, candidates.at(-1)!) : '');
  if (!executablePath) { console.log('SKIP eval read-only: Chrome for Testing is not installed under Gaddi/bin'); process.exit(77); }
  assert.ok(fs.realpathSync(executablePath).startsWith(fs.realpathSync(bin) + path.sep));
  assert.match(executablePath, /Google Chrome for Testing\.app\/Contents\/MacOS\/Google Chrome for Testing$/);
  fs.cpSync(path.join(repo, 'extension'), extension, { recursive: true });
  const hostName = 'com.abcastor.gaddi.bridge.test';
  const bg = path.join(extension, 'dist/extension/bg.js');
  let source = fs.readFileSync(bg, 'utf8').replace("const NATIVE_HOST = 'com.abcastor.gaddi.bridge';", `const NATIVE_HOST = '${hostName}';`);
  if (process.env.GADDI_EVAL_BREAK === 'READONLY') {
    // Disposable copy only: the engine's side-effect check is switched off, so scripts act again.
    const marker = 'throwOnSideEffect: true /* EVAL_READONLY_TEST_POINT */';
    assert.equal(source.split(marker).length, 2, 'eval read-only mutation point');
    source = source.replace(marker, 'throwOnSideEffect: false');
  }
  fs.writeFileSync(bg, source);
  const manifest = JSON.parse(fs.readFileSync(path.join(extension, 'manifest.json'), 'utf8')) as { key: string };
  const id = [...crypto.createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32)]
    .map(c => String.fromCharCode(97 + parseInt(c, 16))).join('');
  const nativeDir = path.join(profile, 'NativeMessagingHosts');
  fs.mkdirSync(nativeDir, { recursive: true });
  fs.writeFileSync(path.join(nativeDir, `${hostName}.json`), JSON.stringify({
    name: hostName, description: 'Eval read-only test host', type: 'stdio', path: path.join(repo, 'bridge/host.sh'), allowed_origins: [`chrome-extension://${id}/`],
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
  await waitFor(() => { if (launchError) throw launchError; return daemon.attachments.length; }, 'eval read-only native host', 20000);
  const tab = (await daemon.call('chrome.open', { url: `${site}/page.html` }) as { id: number }).id;
  await daemon.call('chrome.wait', { tab, selector: '#fr', timeout: 5000 });
  const evaluate = async (expression: string, write = false) =>
    (await daemon.call('chrome.eval', { tab, expression, ...(write ? { write: true } : {}) }) as { value: unknown }).value;
  const settle = () => new Promise(resolve => setTimeout(resolve, 300));

  // Reads keep working, including the forms agents write: top-level const, frames, geometry, page state.
  const reads: [string, unknown][] = [
    ['document.title', 'Eval fixture'],
    ["document.querySelector('#d').textContent", 'hello world'],
    ["[...document.querySelectorAll('input')].map(el => el.name).join('|')", 'q|plan'],
    ["const fields = [...document.querySelectorAll('input')];\nfields.length", 2],
    ["let names = []; for (const el of document.forms[0].elements) names.push(el.id); names", ['q', 'plan', 'pay']],
    ["document.querySelector('#d').getBoundingClientRect().width", 10],
    ["document.querySelector('#fr').contentDocument.querySelector('#ib').textContent", 'Send'],
    ['window.app.state', { n: 1 }],
    ["document.querySelector('#plan').checked", false],
    ['(async () => 5)()', 5],
    ["document.querySelector('#link').href", `${site}/navigated`],
  ];
  for (const [expression, expected] of reads) {
    let value: unknown;
    try { value = await evaluate(expression); } catch (error) { assert.fail(`ASSERT_EVAL_READS: ${expression} was refused: ${String(error)}`); }
    assert.deepEqual(value, expected, `ASSERT_EVAL_READS: ${expression}`);
  }
  passed++; console.log(`PASS eval reads: ${reads.length} page reads return their values`);

  // Each way a script could act. Every one must be refused as read-only, and nothing may reach the server.
  const vectors = [
    "document.querySelector('#pay').click()",
    "document.querySelector('#plan').click()",
    "document.querySelector('label').click()",
    "document.querySelector('#f').submit()",
    "document.querySelector('#f').requestSubmit()",
    "HTMLFormElement.prototype.submit.call(document.forms[0])",
    "document.querySelector('#pay').dispatchEvent(new MouseEvent('click', { bubbles: true }))",
    "document.querySelector('#f').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))",
    "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))",
    "document.querySelector('#link').click()",
    "location.href = '/navigated'",
    "location.assign('/navigated')",
    "location.replace('/navigated')",
    "window.open('/navigated')",
    "history.pushState({}, '', '/pushed')",
    "fetch('/pay', { method: 'POST', body: 'x' })",
    "navigator.sendBeacon('/hit?beacon')",
    "const xhr = new XMLHttpRequest(); xhr.open('POST', '/pay'); xhr.send('x')",
    "(new Image()).src = '/hit?image'",
    "document.querySelector('#q').value = 'changed'",
    "document.querySelector('#plan').checked = true",
    "document.querySelector('#q').focus()",
    "document.title = 'changed'",
    "document.cookie = 'gaddi=1'",
    "localStorage.setItem('gaddi', '1')",
    "window.app.state.n = 2",
    "document.querySelector('#d').innerHTML = '<b>x</b>'",
    "document.body.appendChild(document.createElement('iframe'))",
    "document.execCommand('insertText', false, 'x')",
    "(async () => { await 0; document.querySelector('#pay').click() })()",
    "(async () => { await window.later; document.querySelector('#pay').click() })()",
    "Promise.resolve().then(() => document.querySelector('#pay').click())",
    "window.later.then(() => document.querySelector('#pay').click())",
    "queueMicrotask(() => document.querySelector('#pay').click())",
    "setTimeout(() => document.querySelector('#pay').click(), 0)",
    "requestAnimationFrame(() => document.querySelector('#pay').click())",
    "({ get x() { document.querySelector('#pay').click(); return 1 } })",
    "new Proxy({}, { ownKeys() { document.querySelector('#pay').click(); return [] } })",
    'window.app.armed',
    "eval(\"document.querySelector('#pay').click()\")",
    "new Function(\"document.querySelector('#pay').click()\")()",
    "try { document.querySelector('#pay').click() } catch (e) { 'swallowed' }",
    "document.querySelector('#fr').contentDocument.querySelector('#ib').click()",
    "frames[0].eval(\"document.querySelector('#ib').click()\")",
    "document.querySelector('#fr').contentWindow.location.href = '/navigated'",
    "Object.defineProperty(window, 'injected', { value: 1 })",
    "document.querySelector('#pay').onclick = () => 1",
    "1 } document.querySelector('#pay').click(); {",
  ];
  const acted: string[] = [];
  for (const expression of vectors) {
    try { await evaluate(expression); acted.push(`ran: ${expression}`); }
    catch (error) { if (!/^EVAL_READ_ONLY:/.test(String((error as Error).message))) acted.push(`${expression} -> ${String(error)}`); }
  }
  await settle();
  const after = await evaluate("({ url: location.href, title: document.title, q: document.querySelector('#q').value,"
    + " plan: document.querySelector('#plan').checked, n: window.app.state.n, stored: localStorage.length, cookie: document.cookie,"
    + " frames: frames.length, html: document.querySelector('#d').innerHTML })").catch(error => `unreadable: ${String(error)}`);
  assert.deepEqual({ acted, arrived, after }, { acted: [], arrived: [], after: { url: `${site}/page.html`, title: 'Eval fixture', q: 'v',
    plan: false, n: 1, stored: 0, cookie: '', frames: 1, html: 'hello <span>world</span>' } }, 'ASSERT_EVAL_BYPASS_REFUSED');
  passed++; console.log(`PASS eval bypass: ${vectors.length} ways to act are refused as read-only and nothing reached the page or the server`);

  // Control: the oracle sees a script that acts. With write (only the broker sets it, after the user approved this
  // exact script) the same click does reach the page, its handler calls home and the form posts.
  await evaluate("document.querySelector('#pay').click()", true);
  await waitFor(() => arrived.includes('POST /hit?click') && arrived.includes('POST /submitted'), 'the approved script acted', 5000)
    .catch(() => assert.fail(`ASSERT_EVAL_WRITE_ACTS ${JSON.stringify(arrived)}`));
  passed++; console.log('PASS eval write: an approved script acts, and the oracle sees it');
  guard.verify();
  console.log(`== eval read-only: ${passed} passed, 0 failed`);
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
