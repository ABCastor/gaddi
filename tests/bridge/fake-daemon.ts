import net from 'node:net';
import type { Socket, Server } from 'node:net';
import { checkedReply, isRecord, parseJSON } from '../fixtures/wire.ts';
import type { Reply, RequestId } from '../../shared/protocol.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';

export const waitFor = async <T>(predicate: () => T | Promise<T>, label: string, timeout = 15000): Promise<Exclude<T, false | null | undefined>> => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value as Exclude<T, false | null | undefined>;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error(`Timed out: ${label}`);
};

export class FakeDaemon extends EventEmitter {
  socket: string;
  clients: Set<Socket>;
  pending: Map<RequestId, { peer: Socket; resolve: (reply: Reply) => void; reject: (reason: string) => void }>;
  attachments: { id: RequestId; method: string; params: unknown }[];
  responses: Reply[];
  sequence: number;
  server: Server | undefined;
  peer: Socket | undefined;
  private started = performance.now();
  private peers = new Map<Socket, number>();
  trace(event: string, peer = this.peer, detail = '') {
    console.log(`TRACE bridge +${Math.round(performance.now() - this.started)}ms ${event} peer=${peer ? this.peers.get(peer) : 'none'} pending=${[...this.pending.keys()]} ${detail}`);
  }
  private detach(peer: Socket, reason: string) {
    if (this.peer === peer) this.peer = undefined;
    // Match the broker: work belongs to its original connection and is never replayed.
    for (const request of this.pending.values()) if (request.peer === peer) request.reject(reason);
  }
  constructor(socket: string) {
    super();
    this.socket = socket; this.clients = new Set(); this.pending = new Map();
    this.attachments = []; this.responses = []; this.sequence = 0;
  }
  async start() {
    this.server = net.createServer(peer => {
      this.peers.set(peer, this.peers.size + 1);
      this.trace('connect', peer);
      this.clients.add(peer);
      let buffer = '';
      const decoder = new StringDecoder('utf8');
      peer.on('data', chunk => {
        buffer += decoder.write(chunk);
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
          const message = parseJSON(line);
          assert.ok(isRecord(message));
          assert.ok(message.id === null || typeof message.id === 'string' || typeof message.id === 'number');
          if (message.method === 'bridge.attach') {
            this.trace('attach', peer, `previous=${this.peer ? this.peers.get(this.peer) : 'none'}`);
            if (this.peer && this.peer !== peer) {
              const previous = this.peer;
              this.detach(previous, 'replaced');
              previous.destroy();
            }
            this.attachments.push({ id: message.id, method: message.method, params: message.params }); this.peer = peer;
            peer.write(JSON.stringify({ id: message.id, result: { attached: true, kind: 'chrome' } }) + '\n');
          } else if (message.method === 'bridge.health') {
            peer.write(JSON.stringify({ id: message.id, result: { connected: peer === this.peer && !peer.destroyed } }) + '\n');
          } else {
            const reply = checkedReply(message);
            this.trace('reply', peer, `id=${message.id}`);
            this.responses.push(reply);
            const request = this.pending.get(message.id);
            if (request?.peer === peer) request.resolve(reply);
          }
        }
      });
      peer.on('close', () => { this.trace('close', peer); this.clients.delete(peer); this.detach(peer, 'disconnected'); });
      peer.on('error', () => {});
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.socket, resolve);
    });
    return this;
  }
  request(method: string, params: object = {}, timeout = 15000, id: RequestId = ++this.sequence, deadline = Date.now() + 25000): Promise<Reply> {
    return new Promise<Reply>((resolve, reject) => {
      const peer = this.peer;
      if (!peer || peer.destroyed) { reject(new Error('Bridge not attached')); return; }
      const timer = setTimeout(() => { this.trace('timeout', this.peer, `id=${id} method=${method}`); this.pending.delete(id); reject(new Error(`Timed out: ${method}`)); }, timeout);
      const clear = () => { clearTimeout(timer); this.pending.delete(id); };
      this.pending.set(id, { peer,
        resolve: message => { clear(); resolve(message); },
        reject: reason => { clear(); reject(new Error(`Bridge ${reason}: ${method}`)); },
      });
      this.trace('request', peer, `id=${id} method=${method}`);
      peer.write(JSON.stringify({ id, method, params, deadline }) + '\n', error => {
        if (error) this.detach(peer, 'write failed');
      });
    });
  }
  async call(method: string, params: object = {}): Promise<unknown> {
    const response = await this.request(method, params);
    if (response.error) throw new Error(response.error.message);
    return response.result;
  }
  async stop() {
    for (const peer of this.clients) peer.destroy();
    if (this.server) await new Promise<void>(resolve => this.server!.close(() => resolve()));
    this.server = undefined;
    if (fs.existsSync(this.socket)) fs.unlinkSync(this.socket);
  }
}
