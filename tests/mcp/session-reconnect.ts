// The adapter's lifetime socket tells the broker "this chat is alive", and a session grant lives and dies
// with it. So after the broker drops it (a restart) the adapter must open it again, with the same chat
// identity, waiting 1 s and then doubling. A fake broker drops each lifetime socket twice.
import assert from 'node:assert/strict';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { isRecord, parseJSON } from '../../shared/protocol.ts';

const socket = `/tmp/gaddi-reconnect-${process.pid}.sock`;
const begins: { at: number; session: unknown; caller: unknown }[] = [];
const connections = new Set<net.Socket>();
const server = net.createServer(connection => {
  connections.add(connection); connection.once('close', () => connections.delete(connection));
  connection.on('error', () => {});
  connection.setEncoding('utf8');
  let buffer = '';
  connection.on('data', data => {
    buffer += data;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const request = parseJSON(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      if (!isRecord(request) || request.method !== 'session.begin' || !isRecord(request.params)) continue;
      begins.push({ at: Date.now(), session: request.params.session, caller: request.params.caller });
      connection.write(JSON.stringify({ id: request.id, result: {} }) + '\n');
      // The broker restarts: the first two lifetime sockets are dropped, the third is kept.
      if (begins.length < 3) setTimeout(() => connection.destroy(), 20);
    }
  });
});

let passed = 0;
await new Promise<void>(resolve => server.listen(socket, resolve));
const client = new Client({ name: 'reconnect-test', version: '1' });
try {
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../../mcp/server.ts', import.meta.url))],
    env: { ...process.env, GADDI_SOCKET: socket, GADDI_HARNESS: 'reconnect-fixture' } }));
  const deadline = Date.now() + 9000;
  while (begins.length < 3 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(begins.length, 3, 'ASSERT_GRANT_RECONNECT: the adapter opens its lifetime socket again each time the broker drops it');
  passed++; console.log('PASS ASSERT_GRANT_RECONNECT: the lifetime socket comes back after being dropped');
  const first = begins[0];
  assert.match(String(first.session), /^[0-9a-f-]{36}$/, 'ASSERT_GRANT_RECONNECT: the chat identity is a random UUID');
  assert.ok(begins.every(begin => begin.session === first.session && begin.caller === 'reconnect-fixture'),
    'ASSERT_GRANT_RECONNECT: every registration carries the same chat identity');
  passed++; console.log('PASS ASSERT_GRANT_RECONNECT: always the same chat identity and caller');
  const gaps = [begins[1].at - begins[0].at, begins[2].at - begins[1].at];
  assert.ok(gaps[0] >= 900 && gaps[0] < 3500, `ASSERT_GRANT_BACKOFF: the first retry waits about a second (${gaps[0]} ms)`);
  assert.ok(gaps[1] >= 1900 && gaps[1] < 6000, `ASSERT_GRANT_BACKOFF: the second retry waits about twice as long (${gaps[1]} ms)`);
  passed++; console.log(`PASS ASSERT_GRANT_BACKOFF: retries after ${gaps[0]} ms and ${gaps[1]} ms`);
  console.log(`== session reconnect: ${passed} passed, 0 failed`);
} finally {
  await client.close();
  for (const connection of connections) connection.destroy();
  await new Promise<void>(resolve => server.close(() => resolve()));
}
