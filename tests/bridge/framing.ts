import assert from 'node:assert/strict';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { checkedRequest, isRecord, parseJSON } from '../fixtures/wire.ts';
import type { ChromeRequest } from '../../shared/protocol.ts';
function resultRecord(value: unknown) { assert.ok(isRecord(value)); return value; }
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FakeDaemon, waitFor } from './fake-daemon.ts';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const state = fs.mkdtempSync(path.join(repo, 'tests/.state-bridge-framing-'));
const sock = path.join(os.tmpdir(), `gaddi-bridge-framing-${process.pid}.sock`);
const log = path.join(state, 'bridge.log');
const daemon = new FakeDaemon(sock);
let host: ChildProcessWithoutNullStreams;
let passed = 0, stderr = '';
const pass = (label: string) => { passed++; console.log(`PASS ${label}`); };
const frame = (value: unknown) => {
  const data = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
  const header = Buffer.alloc(4);
  if (os.endianness() === 'LE') header.writeUInt32LE(data.length); else header.writeUInt32BE(data.length);
  return Buffer.concat([header, data]);
};
try {
  await daemon.start();
  host = spawn(process.execPath, [path.join(repo, 'bridge/host.ts')], {
    env: { ...process.env, GADDI_SOCKET: sock, GADDI_BRIDGE_LOG: log }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  host.stderr.on('data', chunk => { stderr += chunk; });
  let output = Buffer.alloc(0);
  const requests: ChromeRequest[] = [];
  host.stdout.on('data', chunk => {
    output = Buffer.concat([output, chunk]);
    while (output.length >= 4) {
      const len = os.endianness() === 'LE' ? output.readUInt32LE() : output.readUInt32BE();
      if (output.length < len + 4) return;
      requests.push(checkedRequest(parseJSON(output.subarray(4, 4 + len).toString('utf8'))));
      output = output.subarray(4 + len);
    }
  });
  await waitFor(() => daemon.attachments.length === 1, 'first attach');
  assert.deepEqual(daemon.attachments[0].params, { kind: 'chrome' });
  pass('bridge.attach registers chrome on the request connection');

  const result = daemon.request('chrome.tabs', {});
  const req = await waitFor(() => requests.shift(), 'native request');
  assert.equal(req.method, 'chrome.tabs');
  const answer = frame({ id: req.id, result: { tabs: [{ id: 7, title: 'Procedi al pagamento • résumé' }] } });
  host.stdin.write(answer.subarray(0, 2));
  host.stdin.write(answer.subarray(2, 9));
  host.stdin.write(answer.subarray(9));
  assert.deepEqual(resultRecord((await result).result).tabs, [{ id: 7, title: 'Procedi al pagamento • résumé' }]);
  pass('fragmented native frames and UTF-8 chrome.tabs round-trip');

  host.stdin.write(Buffer.concat([frame('{bad json'), frame(Buffer.from([34, 255, 34])), frame('null'), frame(''), frame({ id: 'unsolicited', result: 'secret-marker' })]));
  daemon.peer!.write('{bad daemon json\n{"id":"bad-method","method":3}\n');
  const next = daemon.request('chrome.read', { tab: 7 });
  const nextReq = await waitFor(() => requests.shift(), 'request after malformed frame');
  host.stdin.write(frame({ id: nextReq.id, result: { text: 'private-page-marker', outline: '' } }));
  assert.equal(resultRecord((await next).result).text, 'private-page-marker');
  assert.equal(host.exitCode, null);
  pass('malformed and unsolicited frames dropped without crashing');

  const errorCall = daemon.request('chrome.type', { tab: 7, selector: '#password', text: 'private-type-marker' });
  const errorReq = await waitFor(() => requests.shift(), 'type request');
  host.stdin.write(frame({ id: errorReq.id, error: { message: 'Refusing to type into a password field' } }));
  assert.match((await errorCall).error!.message, /password/);
  pass('extension errors reach the daemon');

  const staleCall = daemon.request('chrome.click', { tab: 7, selector: '#target', version: 'v1-old' });
  const staleReq = await waitFor(() => requests.shift(), 'versioned click request');
  host.stdin.write(frame({ id: staleReq.id, error: { code: 'stale', message: 'the page changed since you looked' } }));
  assert.deepEqual((await staleCall).error, { code: 'stale', message: 'the page changed since you looked' }, 'ASSERT_VERSION_NATIVE');
  pass('ASSERT_VERSION_NATIVE');

  const rejected = await daemon.request('chrome.type', { text: 'x'.repeat(1024 * 1024) });
  assert.match(rejected.error!.message, /capacity/);
  pass('host-to-Chrome 1 MiB limit is enforced before writing');

  // Leave an action in flight, then reuse the daemon id on a new connection.
  const lost = daemon.request('chrome.click', { tab: 7, selector: '#pay' }, 1000, 'reused').catch(() => {});
  const oldReq = await waitFor(() => requests.shift(), 'old connection request');
  await daemon.stop();
  await lost;
  await daemon.start();
  await waitFor(() => daemon.attachments.length === 2, 'reconnect and reattach');
  const afterRestart = daemon.request('chrome.tabs', {}, 10000, 'reused');
  const current = await waitFor(() => requests.shift(), 'request after restart');
  assert.equal(current.method, 'chrome.tabs', 'an abandoned click must not be replayed');
  assert.notEqual(current.id, oldReq.id);
  host.stdin.write(frame({ id: oldReq.id, result: { stale: true } }));
  host.stdin.write(frame({ id: current.id, result: { tabs: [{ id: 8 }] } }));
  assert.deepEqual((await afterRestart).result, { tabs: [{ id: 8 }] });
  assert.equal(requests.length, 0, 'reconnect forwards only the explicitly requested tabs call');
  pass('daemon restart reconnects and stale replies cannot satisfy reused ids');

  // Screenshot / HTML replies travel Chrome -> host (the 64 MiB direction).
  const big = daemon.request('chrome.html', { tab: 8 });
  const bigReq = await waitFor(() => requests.shift(), 'large reply request');
  const html = 'é'.repeat(600000);
  host.stdin.write(frame({ id: bigReq.id, result: { html } }));
  assert.equal(resultRecord((await big).result).html, html);
  pass('extension replies larger than 1 MiB round-trip');

  // A stopped/paused worker cannot run a JS timer. The separate native process
  // must still answer before the broker's 30s cutoff and never resend the action.
  const timedAt = Date.now();
  const actionDeadline = timedAt + 24500; // 500ms of the original budget spent in transit.
  const unresponsive = daemon.request('chrome.click', { tab: 8, selector: '#pay' }, 29000, 'watchdog', actionDeadline);
  const withheld = await waitFor(() => requests.shift(), 'request to unresponsive worker');
  assert.equal(withheld.deadline, actionDeadline,
    'ASSERT_WIRE_DEADLINE: native delivery carries the original action expiry');
  const timedReply = await unresponsive;
  const elapsed = Date.now() - timedAt;
  assert.match(timedReply.error?.message || '', /Chrome action timed out/, 'ASSERT_HOST_DEADLINE');
  assert.ok(elapsed >= 26000 && elapsed < 29000, `ASSERT_HOST_DEADLINE: ${elapsed}ms`);
  host.stdin.write(frame({ id: withheld.id, result: { late: true } }));
  const recovery = daemon.request('chrome.tabs');
  const recoveryReq = await waitFor(() => requests.shift(), 'fresh request after deadline');
  assert.equal(recoveryReq.method, 'chrome.tabs', 'expired click is never replayed');
  host.stdin.write(frame({ id: recoveryReq.id, result: { tabs: [] } }));
  assert.deepEqual((await recovery).result, { tabs: [] });
  assert.equal(daemon.responses.filter(reply => reply.id === timedReply.id).length, 1);
  pass(`native watchdog replies in ${elapsed}ms with no worker response, ignores late result and never replays`);

  const beforeExpired = requests.length;
  const expired = await daemon.request('chrome.close', { tabs: [8] }, 1000, 'expired-delivery', Date.now() - 1);
  assert.match(expired.error?.message || '', /deadline expired before delivery/);
  assert.equal(requests.length, beforeExpired, 'host must not deliver a command already expired in transit');
  pass('host rejects an already-expired broker request without forwarding to Chrome');

  host.stdin.end();
  await waitFor(() => host.exitCode !== null, 'exit on native EOF');
  assert.equal(host.exitCode, 0);
  assert.equal(stderr, '');
  const logs = fs.readFileSync(log, 'utf8');
  assert.match(logs, /invalid-frame-json/);
  assert.doesNotMatch(logs, /private-|secret-marker|Procedi|password|résumé/);
  pass('EOF exits cleanly and logs contain lifecycle codes only');

  // Test disconnect rejection independently of native-host delivery latency.
  const beforeAttach = daemon.attachments.length;
  const peer = net.createConnection(sock);
  peer.on('error', () => {});
  peer.write(JSON.stringify({ id: 'fixture-attach', method: 'bridge.attach', params: { kind: 'chrome' } }) + '\n');
  await waitFor(() => daemon.attachments.length > beforeAttach, 'fixture peer attaches');
  const disconnected = assert.rejects(daemon.request('chrome.click', { tab: 7 }, 1000),
    /Bridge disconnected: chrome.click/, 'ASSERT_DISCONNECT_REJECTS_PENDING');
  peer.destroy();
  await disconnected;
  pass('disconnected fake bridge rejects pending work instead of timing out');
  console.log(`== bridge framing: ${passed} passed`);
} catch (error) {
  console.error(`FAIL bridge framing: ${error instanceof Error ? error.stack : String(error)}`);
  process.exitCode = 1;
} finally {
  if (host! && host.exitCode === null) {
    host.kill('SIGTERM');
    await waitFor(() => host.exitCode !== null || host.signalCode !== null, 'host cleanup');
  }
  await daemon.stop();
  fs.rmSync(state, { recursive: true, force: true }); // Disposable test state only.
}
