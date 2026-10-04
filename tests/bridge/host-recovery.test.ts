import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isRecord, parseJSON } from '../../shared/protocol.ts';
import { waitFor } from './fake-daemon.ts';

const repo = fileURLToPath(new URL('../..', import.meta.url));
fs.mkdirSync(path.join(repo, 'tests/.state'), { recursive: true });
const state = fs.mkdtempSync(path.join(repo, 'tests/.state/host-recovery-'));
const preload = path.join(state, 'enospc.mjs');
const observed = path.join(state, 'broker.json');
// A native child runs the production host. Only the socket endpoint and disk-full
// logger are doubled, so this does not need a live broker or socket permission.
fs.writeFileSync(preload, `
import fs from 'node:fs';
import net from 'node:net';
import { EventEmitter } from 'node:events';
fs.appendFileSync = () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); };
let connections = 0, healthCount = 0;
const responses = [];
function record() { fs.writeFileSync(process.env.GADDI_TEST_OBSERVED, JSON.stringify({connections,healthCount,responses})); }
class Peer extends EventEmitter {
  destroyed = false; writableLength = 0;
  constructor() { super(); this.instance = ++connections; record(); setTimeout(() => this.emit('connect'), 0); }
  write(line) {
    const message = JSON.parse(line);
    if (message.method === 'bridge.attach') {
      queueMicrotask(() => this.emit('data', Buffer.from(JSON.stringify({id:message.id,result:{connected:true}})+'\\n')));
      if (this.instance === 1) setTimeout(() => this.emit('data', Buffer.from(JSON.stringify({id:'abandoned',method:'chrome.click',params:{tab:7,selector:'#pay'}})+'\\n')), 30);
    } else if (message.method === 'bridge.health') {
      healthCount++; record();
      if (healthCount === 2) { this.destroy(); return true; }
      if (healthCount !== 4) queueMicrotask(() => this.emit('data', Buffer.from(JSON.stringify({id:message.id,result:{connected:true}})+'\\n')));
    } else { responses.push(message); record(); }
    return true;
  }
  destroy() { if (this.destroyed) return; this.destroyed = true; queueMicrotask(() => this.emit('close')); }
}
net.createConnection = () => new Peer();
`);
let stderr = '', passed = 0;
const pass = (label: string) => { passed++; console.log(`PASS ${label}`); };
const host = spawn(process.execPath, ['--import', preload, path.join(repo, 'bridge/host.ts')], {
  env: { ...process.env, GADDI_SOCKET: path.join(state, 'unused.sock'), GADDI_BRIDGE_LOG: path.join(state, 'bridge.log'), GADDI_TEST_OBSERVED: observed }, stdio: ['pipe', 'pipe', 'pipe'],
});
host.stderr.on('data', chunk => { stderr += chunk; });
let buffer = Buffer.alloc(0);
const messages: Record<string, unknown>[] = [];
host.stdout.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 4) {
    const n = os.endianness() === 'LE' ? buffer.readUInt32LE() : buffer.readUInt32BE();
    if (buffer.length < n + 4) return;
    const message = parseJSON(buffer.subarray(4, n + 4).toString()); assert.ok(isRecord(message));
    messages.push(message); buffer = buffer.subarray(n + 4);
  }
});
const send = (message: unknown) => {
  const body = Buffer.from(JSON.stringify(message)), head = Buffer.alloc(4);
  if (os.endianness() === 'LE') head.writeUInt32LE(body.length); else head.writeUInt32BE(body.length);
  host.stdin.write(Buffer.concat([head, body]));
};
const observation = () => { const value = parseJSON(fs.readFileSync(observed, 'utf8')); assert.ok(isRecord(value)); return value; };
try {
  await waitFor(() => fs.existsSync(observed), 'native host starts with ENOSPC');
  send({ id: 'health:1', method: 'bridge.health', params: {} });
  const health = await waitFor(() => messages.find(message => message.id === 'health:1'), 'roundtrip health');
  assert.deepEqual(health, { id: 'health:1', method: 'bridge.health', result: { connected: true } });
  assert.equal(host.exitCode, null); assert.equal(stderr, '');
  pass('ENOSPC in lifecycle logging cannot kill host or corrupt native frames');

  const request = await waitFor(() => messages.find(message => message.method === 'chrome.click'), 'in-flight page action');
  send({ id: 'health:2', method: 'bridge.health', params: {} });
  const disconnected = await waitFor(() => messages.find(message => message.id === 'health:2'), 'broker disconnect health error');
  assert.ok(isRecord(disconnected.error)); assert.match(String(disconnected.error.message), /disconnected/);
  await waitFor(() => observation().connections === 2, 'automatic host broker reattach');
  send({ id: request.id, result: { oldPage: 'private-page-marker' } });
  send({ id: 'health:3', method: 'bridge.health', params: {} });
  assert.deepEqual(await waitFor(() => messages.find(message => message.id === 'health:3'), 'reconnected broker health'),
    { id: 'health:3', method: 'bridge.health', result: { connected: true } });
  assert.equal(messages.filter(message => message.method === 'chrome.click').length, 1, 'abandoned action was never replayed');
  assert.deepEqual(observation().responses, [], 'late abandoned page result cannot reach a replacement broker');
  pass('native host broker disconnect reattaches and abandons page actions without replay or leaked late results');

  send({ id: 'health:4', method: 'bridge.health', params: {} });
  const timeout = await waitFor(() => messages.find(message => message.id === 'health:4'), 'stalled broker health timeout', 10000);
  assert.ok(isRecord(timeout.error)); assert.match(String(timeout.error.message), /health check timed out/);
  assert.equal(host.exitCode, null, 'watchdog detects a stalled broker behind a live native host');
  send({ id: 'health:5', method: 'bridge.health', params: {} });
  assert.ok(isRecord((await waitFor(() => messages.find(message => message.id === 'health:5'), 'broker recovers after stall')).result));
  assert.equal(stderr, '');
  pass('broker roundtrip watchdog reports a stall independently of native-host liveness and later health succeeds');
  host.stdin.end(); await waitFor(() => host.exitCode !== null, 'host exits on EOF');
  assert.equal(host.exitCode, 0); assert.equal(stderr, '');
  console.log(`== host recovery: ${passed} passed`);
} finally {
  if (host.exitCode === null && host.signalCode === null) {
    host.kill('SIGTERM'); await waitFor(() => host.exitCode !== null || host.signalCode !== null, 'host cleanup');
  }
  // Disposable test files only.
  fs.rmSync(state, { recursive: true, force: true });
}
