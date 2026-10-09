// Isolated fixture server. It neither imports daemon code nor touches browser/keychain state.
import net from 'node:net';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const socketPath = process.env.GADDI_SOCKET;
// Either home is disposable; the point is that the live broker's socket can never be named.
if (!socketPath || !(socketPath.includes('/tests/.state/') || /^\/tmp\/gaddi-test-[^/]+$/.test(socketPath)))
  throw new Error('GADDI_SOCKET must be under tests/.state/ or /tmp/gaddi-test-*');
const mode = process.env.GADDI_FAKE_MODE || 'normal';
const record = process.env.GADDI_FAKE_RECORD;
let subscriptions = 0;
const connections = new Set<net.Socket>();
const approval = (id: string, caller = 'Café task', remote = false) => ({ id, kind: 'click', tab: 42, caller,
  url: 'https://example.test/cart', detail: 'click Pay café', reason: 'checkout action',
  status: 'pending', expiresAt: new Date(Date.now() + 600_000).toISOString(), ...(remote ? { remote: true } : {}) });
// The first waiting request is one the owner's other device may also answer, as the real broker flags it.
const pending = [approval('existing', 'Already pending', true)];
// Phone approval: off, with a key waiting; and one request it answered earlier.
const fingerprint = 'abcdef0123456789'.repeat(4);
const answered = { id: 'answered1', kind: 'click', tab: 42, caller: 'Marcus task', url: 'https://example.test/shop', detail: 'Post',
  reason: 'verb:post', status: 'used', by: 'remote', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600_000).toISOString(),
  decidedAt: new Date().toISOString(), resolvedAt: new Date().toISOString(), usedAt: new Date().toISOString() };
// One active session grant rides along with every approvals snapshot, as the real broker sends it.
const grants = [{ id: 'g1', caller: 'Café task', label: 'Update the profile', rules: ['upload https://example.test/profile'],
  createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(), mine: false }];
let malformedSent = false;
const started = Date.now();
function log(value: unknown) { if (record) fs.appendFileSync(record, JSON.stringify(value) + '\n'); }
function reply(socket: net.Socket, id: unknown, result: unknown) { socket.write(JSON.stringify({ id, result }) + '\n'); }
function event(socket: net.Socket, name: string, data: Record<string, unknown>, flat = false) {
  const line = JSON.stringify(flat ? { event: name, ...data } : { event: name, data }) + '\n';
  // Split in the middle of UTF-8 and across NDJSON boundaries, just as a real socket may.
  const bytes = Buffer.from(line);
  const split = Math.max(1, bytes.indexOf(Buffer.from('é')) + 1);
  socket.write(bytes.subarray(0, split));
  setTimeout(() => { if (!socket.destroyed) socket.write(bytes.subarray(split)); }, 5);
}
const server = net.createServer(socket => {
  connections.add(socket);
  socket.on('close', () => connections.delete(socket));
  socket.on('error', () => {});
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', data => {
    buffer += data;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const request: unknown = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      assert(request !== null && typeof request === 'object' && 'method' in request && 'id' in request && 'params' in request);
      log({ method: request.method, params: request.params });
      const { id, method } = request;
      if (method === 'events.subscribe') {
        subscriptions++;
        log({ subscriptions });
        if (mode === 'refuse') { socket.end(JSON.stringify({ id, error: { message: 'No subscription' } }) + '\n'); continue; }
        reply(socket, id, { subscribed: true });
        if (mode === 'quiet-snapshot') {
          if (subscriptions === 1) setTimeout(() => pending.push(approval('lost-event', 'Quiet task')), 250);
          continue; // Both notification delivery and approval.pending events are absent.
        }
        if (mode === 'malformed' && !malformedSent) {
          malformedSent = true;
          setTimeout(() => socket.write('{not json}\n'), 30);
          continue;
        }
        if (mode === 'snapshot-error') {
          pending.push(approval('a1', 'Recovered task'));
          setTimeout(() => event(socket, 'approval.pending', { approval: pending.at(-1), tab: 42 }), 100);
          continue; // No later events: recovery must come from the app's own retry.
        }
        if (subscriptions === 1 || mode === 'malformed') {
          setTimeout(() => {
            pending.push(approval('a1')); event(socket, 'approval.pending', { approval: pending.at(-1), tab: 42 }, true);
          }, 250);
          setTimeout(() => {
            // The broker retains granted records until the agent consumes them.
            pending.find(a => a.id === 'a1')!.status = 'granted';
            event(socket, 'approval.resolved', { approval: { id: 'a1', status: 'granted' }, tab: 42 });
          }, 550);
          setTimeout(() => {
            // A lost resolution event must be recovered from the snapshot after reconnect.
            const existing = pending.findIndex(a => a.id === 'existing');
            if (existing >= 0) pending.splice(existing, 1);
            socket.destroy();
          }, 850);
        }
      } else if (method === 'approvals.list') {
        if (mode === 'snapshot-error' && Date.now() - started < 2000) {
          socket.end(JSON.stringify({ id, error: { message: 'transient snapshot failure' } }) + '\n');
        } else { reply(socket, id, { pending, recent: [answered], grants }); }
      } else if (method === 'remote.status') {
        reply(socket, id, { enabled: false, candidate: { fingerprint } });
      } else if (method === 'sends.remembered') {
        reply(socket, id, { rules: [] });
      } else if (method === 'signin.remembered') {
        reply(socket, id, { sites: ['https://remembered.example.test:8443'] });
      } else if (method === 'test.error') {
        socket.end(JSON.stringify({ id, error: { message: 'synthetic refusal' } }) + '\n');
      } else if (method === 'test.wrong-id') {
        reply(socket, 'wrong-id', {});
      } else if (method === 'test.oversized') {
        socket.write('x'.repeat(1_048_577));
      } else if (method === 'test.eof') {
        socket.end('{"id":');
      } else if (method === 'test.echo') {
        reply(socket, id, request.params);
      } else {
        socket.end(JSON.stringify({ id, error: { message: `Unexpected method: ${method}` } }) + '\n');
      }
    }
  });
});
fs.mkdirSync(path.dirname(socketPath), { recursive: true });
server.listen(socketPath, () => { console.log('READY'); });
function stop() { for (const socket of connections) socket.destroy(); server.close(() => process.exit(0)); }
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
