import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import type { Browser } from 'playwright-core';
import { chromium } from 'playwright-core';
import { runSignin } from '../../daemon/signin.ts';
import { FakeDaemon, waitFor } from '../bridge/fake-daemon.ts';
import { requireHeadless, watchHeadless } from '../bridge/background.ts';
import { writeForeignExtension } from '../bridge/foreign-frame.ts';

// Real extension/native host and disposable Chrome; credentials come only from a fake op.
const repo = path.resolve(import.meta.dirname, '../..');
const state = fs.mkdtempSync(path.join(repo, 'tests/.state-signin-'));
const profile = path.join(state, 'profile'), extension = path.join(state, 'extension');
const socket = path.join(os.tmpdir(), `gaddi-signin-browser-${process.pid}.sock`);
const daemon = new FakeDaemon(socket);
const originalEnv = { ...process.env };
const username = `${crypto.randomUUID()}@example.test`, password = crypto.randomUUID();
const secrets = [username, password];
const noSecrets = (value: unknown) => assert.ok(secrets.every(secret => !JSON.stringify(value).includes(secret)), 'credential leaked in result');
let browser: Browser | undefined, passed = 0, submissions = 0, credentialsAccepted = false;
let signedIn = false;
const server = http.createServer((req, res) => {
  if (req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      submissions++;
      const fields = new URLSearchParams(body);
      credentialsAccepted = fields.get('username') === username && fields.get('password') === password;
      body = '';
      signedIn = credentialsAccepted;
      // Same URL, new document: covers sites that reload on successful submission.
      res.writeHead(303, { Location: req.url! }); res.end();
    });
    return;
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (signedIn) { res.end('<!doctype html><title>Account</title><main>Signed in</main>'); return; }
  if (req.url?.includes('aura')) { res.end(fs.readFileSync(path.join(repo, 'tests/signin/fixtures/aura-login.html'))); return; }
  res.end(`<!doctype html><title>Login</title><form method="post">
    <label>Email <input name="username" type="email" autocomplete="username" ${req.url?.includes('sticky') ? '' : 'data-menu'}></label>
    <label>Password <input name="password" type="password" autocomplete="current-password" data-menu></label>
    <button type="submit">Sign in</button></form>`);
});
let chromeProcess: ReturnType<typeof spawn> | undefined;
let chromeExit: Promise<unknown> | undefined;
let guard: ReturnType<typeof watchHeadless> | undefined;
try {
  const bin = path.join(os.homedir(), 'Library/Application Support/Gaddi/bin');
  const candidates = fs.readdirSync(bin, { recursive: true, encoding: 'utf8' })
    .filter(name => name.endsWith('Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')).sort();
  const executablePath = process.env.GADDI_CHROME || path.join(bin, candidates.at(-1)!);
  assert.ok(fs.realpathSync(executablePath).startsWith(fs.realpathSync(bin) + path.sep));
  assert.match(executablePath, /Google Chrome for Testing\.app\/Contents\/MacOS\/Google Chrome for Testing$/);
  fs.cpSync(path.join(repo, 'extension'), extension, { recursive: true });
  const hostName = 'com.abcastor.gaddi.bridge.test';
  const bg = path.join(extension, 'dist/extension/bg.js');
  let source = fs.readFileSync(bg, 'utf8').replace("const NATIVE_HOST = 'com.abcastor.gaddi.bridge';", `const NATIVE_HOST = '${hostName}';`);
  if (process.env.GADDI_SIGNIN_BREAK_LANDED === '1') {
    const marker = "action !== 'signinType' || !isForeignFrameError(error)";
    assert.ok(source.includes(marker), 'sign-in recovery mutation point');
    source = source.replace(marker, 'true');
  }
  fs.writeFileSync(bg, source);
  const auraMutation = process.env.GADDI_SIGNIN_BREAK_AURA;
  if (auraMutation) {
    const content = path.join(extension, 'dist/extension/content.js');
    const markers: Record<string, [string, string]> = {
      NAME: ['/* SIGNIN_ACCESSIBLE_NAME_TEST_POINT */', 'return;'],
      FORM: ['/* SIGNIN_NO_FORM_TEST_POINT */', "throw new Error('Sign-in refused');"],
    };
    assert.ok(auraMutation in markers, 'known component sign-in mutation');
    const [marker, replacement] = markers[auraMutation];
    const original = fs.readFileSync(content, 'utf8');
    assert.equal(original.split(marker).length, 2, 'component sign-in mutation point');
    fs.writeFileSync(content, original.replace(marker, replacement));
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(extension, 'manifest.json'), 'utf8')) as { key: string };
  const id = [...crypto.createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32)]
    .map(c => String.fromCharCode(97 + parseInt(c, 16))).join('');
  const nativeDir = path.join(profile, 'NativeMessagingHosts');
  fs.mkdirSync(nativeDir, { recursive: true });
  fs.writeFileSync(path.join(nativeDir, `${hostName}.json`), JSON.stringify({
    name: hostName, description: 'Sign-in test host', type: 'stdio', path: path.join(repo, 'bridge/host.sh'), allowed_origins: [`chrome-extension://${id}/`],
  }));
  fs.writeFileSync(path.join(state, 'op'), `#!${process.execPath}\nconsole.log(${JSON.stringify(JSON.stringify([{ label: 'username', value: username }, { label: 'password', value: password }]))});\n`, { mode: 0o700 });
  await daemon.start();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const site = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const foreign = writeForeignExtension(state);
  const args = ['--headless=new', `--user-data-dir=${profile}`, `--load-extension=${extension},${foreign}`,
    `--disable-extensions-except=${extension},${foreign}`, '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update', '--remote-debugging-port=0', 'about:blank'];
  requireHeadless(args);
  guard = watchHeadless(executablePath, [profile]);
  chromeProcess = spawn(executablePath, args, {
    env: { ...process.env, GADDI_SOCKET: socket, GADDI_BRIDGE_LOG: path.join(state, 'bridge.log') }, stdio: 'ignore',
  });
  let launchError: Error | undefined;
  chromeProcess.on('error', error => { launchError = error; });
  chromeExit = new Promise(resolve => chromeProcess!.once('close', resolve));
  await waitFor(() => { if (launchError) throw launchError; return daemon.attachments.length; }, 'sign-in native host', 20000);
  const devtoolsPort = await waitFor(() => {
    const file = path.join(profile, 'DevToolsActivePort');
    return fs.existsSync(file) && fs.readFileSync(file, 'utf8').split('\n')[0];
  }, 'sign-in test Chrome port');
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${devtoolsPort}`, { noDefaults: true });
  const context = browser.contexts()[0];
  process.env.PATH = `${state}:${process.env.PATH}`;
  const cases = process.env.GADDI_SIGNIN_CASE ? [process.env.GADDI_SIGNIN_CASE]
    : process.env.GADDI_SIGNIN_BREAK_LANDED === '1' ? ['?sticky']
    : auraMutation ? ['?aura'] : ['?plain', '?persistent', '?focus', '?sticky', '?aura', '?aura-sticky'];
  for (const suffix of cases) {
    submissions = 0; credentialsAccepted = false; signedIn = false;
    const url = `${site}/${suffix === '?plain' ? 'login' : 'foreign'}.html${suffix}`;
    const opened = await daemon.call('chrome.open', { url }) as { id: number };
    const tab = opened.id;
    const page = await waitFor(() => context.pages().find(page => page.url() === url), 'sign-in fixture');
    if (suffix === '?persistent') await waitFor(() => page.frames().some(frame => frame.url().startsWith('chrome-extension://')), 'inline frame');
    const methods: string[] = [];
    const result = await runSignin({ site, item: { id: 'test-login', title: 'Test login', urls: [site] }, tab,
      remember(value) { assert.ok(secrets.includes(value)); },
      async request(name, params, deadline) {
        methods.push(name);
        const response = await daemon.request(`chrome.${name}`, params, 15000, undefined, deadline);
        noSecrets(response);
        if (response.error) throw new Error('Sign-in fixture action failed');
        return response.result;
      },
    });
    noSecrets(result); noSecrets(daemon.responses);
    console.log(`TRACE signin ${suffix}: ${JSON.stringify(result)} methods=${methods.join(',')} submissions=${submissions} accepted=${credentialsAccepted}`);
    if (result.outcome !== 'signed_in') console.log(`TRACE signin fields: ${JSON.stringify(await page.evaluate(({ username, password }) => ({
      usernameAccepted: document.querySelector<HTMLInputElement>('input:not([type="password"])')?.value === username,
      usernameEmpty: document.querySelector<HTMLInputElement>('input:not([type="password"])')?.value === '',
      passwordAccepted: document.querySelector<HTMLInputElement>('input[type="password"]')?.value === password,
    }), { username, password }))}`);
    if (suffix.includes('aura') && result.outcome !== 'signed_in') console.log(`TRACE signin component events: ${JSON.stringify(await page.evaluate(() => (window as Window & { signinEvents?: unknown[] }).signinEvents))}`);
    assert.equal(result.outcome, 'signed_in', `ASSERT_SIGNIN_RELOAD ${suffix}`);
    assert.equal(submissions, 1, 'submit must not be replayed');
    assert.ok(credentialsAccepted, 'submitted credentials must match without exposing values');
    assert.equal(await page.locator('main').innerText(), 'Signed in');
    if (suffix.includes('aura')) {
      const events = await page.evaluate(() => JSON.parse(sessionStorage.getItem('signinEvents')!) as { type: string; field: string; trusted: boolean }[]);
      for (const field of ['username', 'password']) {
        assert.equal(events.filter(event => event.field === field && event.type === 'input').length, 1, 'credential insert must not be replayed');
        assert.equal(events.filter(event => event.field === field && event.type === 'change' && event.trusted).length, 1, 'native change must commit component state');
      }
      assert.ok(events.every(event => event.trusted), 'component events use native browser input');
      assert.equal(events.filter(event => event.type === 'keyup').length, 1, 'Enter must not be replayed');
    }
    await daemon.call('chrome.close', { tabs: [tab] });
    passed++; console.log(`PASS real sign-in reload ${suffix}, one submit, no secrets`);
  }
  guard.verify();
  console.log(`== signin browser: ${passed} passed, 0 failed`);
} finally {
  process.env = originalEnv;
  guard?.stop();
  await browser?.close();
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
