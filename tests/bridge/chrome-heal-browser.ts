import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { requireHeadless, watchHeadless } from './background.ts';

// Production broker + real extension/native host in a DISPOSABLE headless Chrome for Testing.
// The broker's probe and launcher are pointed at this test Chrome only (GADDI_CHROME_PROBE/LAUNCH);
// the test kills that Chrome by its own recorded PID and proves the broker brings it back.
// GADDI_HEAL_BREAK=call runs a broker copy without the recovery call, =sync one that wakes waiters inside
// bridge.attach (their first request then overtakes the attach reply): the same steps must fail.
const repo = path.resolve(import.meta.dirname, '../..');
fs.mkdirSync(path.join(repo, 'tests/.state'), { recursive: true });
const state = fs.mkdtempSync(path.join(repo, 'tests/.state/heal-'));
const home = path.join(state, 'home'), profile = path.join(state, 'profile'), extension = path.join(state, 'extension');
fs.mkdirSync(home);
const socket = path.join(os.tmpdir(), `gaddi-heal-${process.pid}.sock`);
const pidFile = path.join(state, 'chrome.pid'), launches = path.join(state, 'launches.log');
let passed = 0;
const pass = (label: string) => { passed++; console.log(`PASS ${label}`); };
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until<T>(fn: () => T | Promise<T>, what: string, ms = 30000): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value as NonNullable<T>;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await pause(100);
  }
}
function call(method: string, params: Record<string, unknown> = {}, ms = 90000): Promise<{ result?: Record<string, unknown>; error?: { message: string; code?: string } }> {
  return new Promise((resolve, reject) => {
    const client = net.connect(socket); let buffer = '';
    const timer = setTimeout(() => { client.destroy(); reject(new Error(`${method} timed out`)); }, ms);
    client.setEncoding('utf8');
    client.on('connect', () => client.write(JSON.stringify({ id: crypto.randomUUID(), method, params: { caller: 'heal-test', ...params } }) + '\n'));
    client.on('error', error => { clearTimeout(timer); reject(error); });
    client.on('data', chunk => {
      buffer += chunk; const end = buffer.indexOf('\n'); if (end < 0) return;
      clearTimeout(timer); client.destroy(); resolve(JSON.parse(buffer.slice(0, end)));
    });
  });
}
const chromePid = () => { try { return Number(fs.readFileSync(pidFile, 'utf8')); } catch { return 0; } };
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

const server = http.createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Heal fixture</title><main>restore me</main>'); });
let broker: ReturnType<typeof spawn> | undefined, events: net.Socket | undefined;
let guard: ReturnType<typeof watchHeadless> | undefined;
try {
  const bin = path.join(os.homedir(), 'Library/Application Support/Gaddi/bin');
  const candidates = fs.readdirSync(bin, { recursive: true, encoding: 'utf8' })
    .filter(name => name.endsWith('Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')).sort();
  const executablePath = process.env.GADDI_CHROME || path.join(bin, candidates.at(-1)!);
  assert.ok(fs.realpathSync(executablePath).startsWith(fs.realpathSync(bin) + path.sep), 'only the test Chrome for Testing');

  fs.cpSync(path.join(repo, 'extension'), extension, { recursive: true });
  const hostName = 'com.abcastor.gaddi.bridge.test';
  const bg = path.join(extension, 'dist/extension/bg.js');
  fs.writeFileSync(bg, fs.readFileSync(bg, 'utf8').replace("const NATIVE_HOST = 'com.abcastor.gaddi.bridge';", `const NATIVE_HOST = '${hostName}';`));
  const manifest = JSON.parse(fs.readFileSync(path.join(extension, 'manifest.json'), 'utf8')) as { key: string };
  const id = [...crypto.createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32)]
    .map(c => String.fromCharCode(97 + parseInt(c, 16))).join('');
  fs.mkdirSync(path.join(profile, 'NativeMessagingHosts'), { recursive: true });
  fs.writeFileSync(path.join(profile, 'NativeMessagingHosts', `${hostName}.json`), JSON.stringify({
    name: hostName, description: 'Chrome heal test host', type: 'stdio', path: path.join(repo, 'bridge/host.sh'), allowed_origins: [`chrome-extension://${id}/`],
  }));
  const args = ['--headless=new', `--user-data-dir=${profile}`, `--load-extension=${extension}`, `--disable-extensions-except=${extension}`,
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--restore-last-session'];
  requireHeadless(args);
  // The broker's stand-in for `open -a`: start the disposable Chrome detached, record its PID, return.
  const launcher = path.join(state, 'launch.mjs'), probe = path.join(state, 'probe.mjs');
  fs.writeFileSync(launcher, `import { spawn } from 'node:child_process'; import fs from 'node:fs';
fs.appendFileSync(${JSON.stringify(launches)}, 'launch\\n');
const child = spawn(${JSON.stringify(executablePath)}, ${JSON.stringify(args)}, { detached: true, stdio: 'ignore',
  env: { ...process.env, GADDI_SOCKET: ${JSON.stringify(socket)}, GADDI_BRIDGE_LOG: ${JSON.stringify(path.join(state, 'bridge.log'))} } });
fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid)); child.unref();
`);
  fs.writeFileSync(probe, `import fs from 'node:fs'; let pid = 0; try { pid = Number(fs.readFileSync(${JSON.stringify(pidFile)}, 'utf8')); } catch {}
try { if (pid > 0) { process.kill(pid, 0); process.exit(0); } } catch {} process.exit(1);
`);
  let entry = path.join(repo, 'daemon/daemon.mjs');
  const broken = process.env.GADDI_HEAL_BREAK;
  if (broken) {
    const mutant = path.join(state, 'mutant');
    for (const dir of ['daemon', 'shared', 'policy']) fs.cpSync(path.join(repo, dir), path.join(mutant, dir), { recursive: true });
    fs.writeFileSync(path.join(mutant, 'package.json'), JSON.stringify({ type: 'module' }));
    const [name, marker, replacement] = broken === 'call'
      ? ['daemon/daemon.ts', 'const recovery = await chromeHeal.ensure();', 'const recovery = undefined as string | undefined;']
      : broken === 'sync' ? ['daemon/chrome-heal.ts', 'setImmediate(() => { for (const wake of woken) wake(); });', 'for (const wake of woken) wake();']
      : assert.fail(`unknown GADDI_HEAL_BREAK ${broken}`);
    const file = path.join(mutant, name), source = fs.readFileSync(file, 'utf8');
    assert.equal(source.split(marker).length, 2, `${broken} mutation point`);
    fs.writeFileSync(file, source.replace(marker, replacement));
    entry = path.join(mutant, 'daemon/daemon.mjs');
  }
  broker = spawn(process.execPath, [entry], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, GADDI_HOME: home, GADDI_SOCKET: socket,
    GADDI_AUDIT: path.join(home, 'audit.jsonl'), GADDI_STATE: path.join(home, 'state.json'), GADDI_APPROVER_PUB: path.join(home, 'approver.pub'),
    GADDI_APP_LAUNCHER: '/usr/bin/true', GADDI_CHROME_LAUNCH: JSON.stringify([process.execPath, launcher]),
    GADDI_CHROME_PROBE: JSON.stringify([process.execPath, probe]) } });
  let diagnostics = ''; broker.stderr!.on('data', chunk => { diagnostics += chunk; });
  await until(() => fs.existsSync(socket) || broker!.exitCode !== null, 'broker socket', 10000);
  assert.ok(fs.existsSync(socket), `broker started: ${diagnostics}`);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const fixture = `http://127.0.0.1:${(server.address() as AddressInfo).port}/heal.html`;

  const notices: string[] = [];
  events = net.connect(socket); events.setEncoding('utf8'); let pending = '';
  events.on('connect', () => events!.write(JSON.stringify({ id: 'events', method: 'events.subscribe', params: { caller: 'heal-test' } }) + '\n'));
  events.on('data', chunk => {
    pending += chunk; let end;
    while ((end = pending.indexOf('\n')) >= 0) {
      const line = JSON.parse(pending.slice(0, end)); pending = pending.slice(end + 1);
      if (line.event === 'browser.notice') notices.push(String(line.data?.text));
    }
  });
  guard = watchHeadless(executablePath, [profile]);

  // 1. Owner's Chrome stand-in is running with the extension attached and a page open.
  spawn(process.execPath, [launcher], { stdio: 'ignore' });
  await until(async () => (await call('bridge.status')).result?.connected === true, 'first bridge attach', 30000);
  const opened = await call('open', { url: fixture });
  assert.equal(opened.error, undefined, `open fixture: ${opened.error?.message}`);
  await until(async () => ((await call('tabs')).result?.tabs as { url?: string }[] | undefined)?.some(tab => tab.url === fixture), 'fixture tab');
  await pause(4000); // Let Chrome write its session so a restart has something to restore.
  pass('disposable Chrome attached with a fixture tab');

  // 2. Kill exactly that Chrome. The bridge drops; nothing relaunches until an agent asks.
  const first = chromePid();
  assert.ok(first > 0 && alive(first));
  process.kill(first, 'SIGKILL');
  await until(() => !alive(first), 'test Chrome exit');
  await until(async () => (await call('bridge.status')).result?.connected === false, 'bridge detach');
  const idle = (await call('bridge.status')).result?.recovery as { state?: string } | undefined;
  assert.equal(idle?.state, 'disconnected');
  assert.equal(fs.readFileSync(launches, 'utf8').trim().split('\n').length, 1, 'no relaunch without a browser call');
  pass('kill: bridge reports disconnected, nothing relaunched on its own');

  // 3. The next agent call reopens Chrome, waits for the extension, and says what happened.
  const started = Date.now();
  const healed = await call('tabs');
  assert.equal(healed.error, undefined, `ASSERT_HEAL_BROWSER agent call after a Chrome crash must recover, got: ${healed.error?.message}`);
  assert.match(String(healed.result?.recovery), /Chrome had stopped \(crash or quit\); Gaddi reopened it with your profile and last session; \d+ tabs? open again/,
    `ASSERT_HEAL_BROWSER recovery note; broker said: ${diagnostics}`);
  const second = chromePid();
  assert.ok(second > 0 && second !== first && alive(second), 'a new test Chrome is running');
  assert.equal(fs.readFileSync(launches, 'utf8').trim().split('\n').length, 2, 'exactly one relaunch');
  const tabs = healed.result?.tabs as { url?: string }[];
  const restored = tabs.some(tab => tab.url === fixture);
  console.log(`INFO recovered in ${Date.now() - started} ms; ${tabs.length} tabs`);
  assert.ok(restored, 'ASSERT_HEAL_RESTORE the killed session tab is open again');
  await until(() => notices.length >= 1, 'owner notice', 5000);
  assert.equal(notices.length, 1, 'one owner notice');
  assert.match(notices[0], /Gaddi reopened it/);
  const status = (await call('bridge.status')).result?.recovery as { state?: string; lastRecovery?: { action?: string } };
  assert.equal(status.state, 'connected'); assert.equal(status.lastRecovery?.action, 'relaunch');
  pass('agent call after the kill: Chrome reopened, last session restored, clear note, one owner notice');

  // 4. A second crash inside the cooldown is not relaunched: the agent gets the reason, no loop.
  process.kill(second, 'SIGKILL');
  await until(() => !alive(second), 'second test Chrome exit');
  await until(async () => (await call('bridge.status')).result?.connected === false, 'second bridge detach');
  const refused = await call('tabs');
  assert.match(String(refused.error?.message), /chrome bridge not connected: Chrome is not running\. Gaddi already reopened it at .* Open Google Chrome yourself\./);
  assert.equal(fs.readFileSync(launches, 'utf8').trim().split('\n').length, 2, 'no relaunch inside the cooldown');
  await until(() => notices.length >= 2, 'second incident notice', 5000);
  assert.equal(notices.length, 2, 'one notice for the second incident');
  pass('second kill inside the cooldown: no relaunch, exact instruction, one notice');
  guard.verify();
  console.log(`== chrome heal browser: ${passed} passed, 0 failed`);
} finally {
  guard?.stop();
  events?.destroy();
  server.close();
  // Only the disposable test Chrome this run recorded, by PID.
  const pid = chromePid(); if (pid > 0 && alive(pid)) { process.kill(pid, 'SIGKILL'); await until(() => !alive(pid), 'test Chrome cleanup', 10000).catch(() => {}); }
  if (broker && broker.exitCode === null) { broker.kill('SIGTERM'); await until(() => broker!.exitCode !== null, 'broker exit', 5000).catch(() => broker!.kill('SIGKILL')); }
  fs.rmSync(socket, { force: true });
}
