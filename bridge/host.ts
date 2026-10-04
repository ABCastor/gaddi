#!/usr/bin/env node
// Native messaging (length-prefixed JSON) <-> the daemon's NDJSON connection.
import net from 'node:net';
import type { Socket } from 'node:net';
import { isRecord, parseJSON } from '../shared/protocol.ts';
import type { RequestId } from '../shared/protocol.ts';
// The native host relays parameters and results opaquely; endpoints validate their contents.
type RelayMessage = { id: RequestId; method?: string; params?: unknown; deadline?: number; result?: unknown; error?: { message: string; code?: string } };

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const support = path.join(os.homedir(), 'Library/Application Support/Gaddi');
const logPath = process.env.GADDI_BRIDGE_LOG || path.join(support, 'bridge.log');
const MAX_FROM_CHROME = 64 * 1024 * 1024;
const MAX_TO_CHROME = 1024 * 1024;
const MAX_LINE = MAX_FROM_CHROME + 1024;
const littleEndian = os.endianness() === 'LE';
const instance = randomUUID();
let serial = 0, stopping = false, delay = 250;
let socket: Socket | undefined, retry: NodeJS.Timeout | undefined, attachTimer: NodeJS.Timeout | undefined;
const pending = new Map<string, { id: string | number; peer: Socket; timer: NodeJS.Timeout }>();
let attachedSocket: Socket | undefined;
const healthPending = new Map<string, { id: string; timer: NodeJS.Timeout; params: unknown; peer?: Socket }>();

function log(event: string) {
  // Invariant: logs contain fixed lifecycle codes only, never URLs, page text,
  // selectors, typed values, daemon responses, or exception messages.
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
    if (fs.existsSync(logPath) && fs.statSync(logPath).size > 1024 * 1024) {
      fs.renameSync(logPath, `${logPath}.1`);
    }
    fs.appendFileSync(logPath, `${new Date().toISOString()} ${event}\n`, { mode: 0o600 });
  } catch { /* Logging failure must not corrupt native stdout. */ }
}

function socketPath() {
  return process.env.GADDI_SOCKET || path.join(support, 'gaddi.sock');
}

function sendDaemon(peer: Socket, message: RelayMessage) {
  if (peer !== socket || peer.destroyed) return;
  const line = JSON.stringify(message) + '\n';
  if (peer.writableLength + Buffer.byteLength(line) > MAX_LINE * 2) {
    log('daemon-backpressure');
    peer.destroy();
    return;
  }
  peer.write(line);
}

function sendChrome(message: RelayMessage) {
  const body = Buffer.from(JSON.stringify(message));
  if (body.length > MAX_TO_CHROME || process.stdout.writableLength > 2 * MAX_TO_CHROME) return false;
  const header = Buffer.alloc(4);
  if (littleEndian) header.writeUInt32LE(body.length);
  else header.writeUInt32BE(body.length);
  process.stdout.write(Buffer.concat([header, body]));
  return true;
}

function receiveChrome(message: unknown) {
  // Invariant: only a reply to an outstanding request on this daemon connection
  // can reach it. Old replies after reconnect cannot satisfy a new request.
  if (!isRecord(message)) return log('invalid-reply');
  if (message.method === 'bridge.health' && typeof message.id === 'string' && message.id.length <= 128) {
    if (healthPending.size >= 4) return;
    const id = message.id, wireId = `health:${instance}:${++serial}`;
    // Probe the broker itself, rather than treating a live host process as health.
    // Only fixed recovery metadata is accepted by the broker; page data is never logged.
    const timer = setTimeout(() => {
      healthPending.delete(wireId);
      sendChrome({ id, method: 'bridge.health', error: { message: 'Broker health check timed out' } });
    }, 8000);
    healthPending.set(wireId, { id, timer, params: isRecord(message.params) ? { lastSelfHeal: message.params.lastSelfHeal } : {} });
    if (attachedSocket && attachedSocket === socket && !attachedSocket.destroyed) sendHealth(wireId, attachedSocket);
    return;
  }
  const request = pending.get(typeof message.id === 'string' ? message.id : '');
  if (!request) return log('unsolicited-reply');
  const error = isRecord(message.error) ? message.error : undefined;
  if (!Object.hasOwn(message, 'result') && typeof error?.message !== 'string') return log('invalid-reply');
  pending.delete(typeof message.id === 'string' ? message.id : '');
  clearTimeout(request.timer);
  sendDaemon(request.peer, typeof error?.message === 'string'
    ? { id: request.id, error: { message: error.message, ...(error.code === 'stale' ? { code: 'stale' } : {}) } }
    : { id: request.id, result: message.result });
}

function sendHealth(id: string, peer: Socket) {
  const probe = healthPending.get(id);
  if (!probe || probe.peer) return;
  probe.peer = peer;
  sendDaemon(peer, { id, method: 'bridge.health', params: probe.params });
}

// Accumulate only the declared frame. Oversized frames are drained without
// allocating their length; a malformed JSON payload does not poison the next frame.
let header = Buffer.alloc(4), headerBytes = 0, bodyBytes = 0, dropping = false;
let bodyParts: Buffer[] = [], remaining: number | null = null;
process.stdin.on('data', (chunk: Buffer) => {
  let offset = 0;
  while (offset < chunk.length) {
    if (remaining === null) {
      const n = Math.min(4 - headerBytes, chunk.length - offset);
      chunk.copy(header, headerBytes, offset, offset + n);
      headerBytes += n; offset += n;
      if (headerBytes < 4) continue;
      remaining = littleEndian ? header.readUInt32LE() : header.readUInt32BE();
      headerBytes = 0;
      dropping = remaining > MAX_FROM_CHROME;
      if (dropping || remaining === 0) log('invalid-frame-length');
    }
    const n = Math.min(remaining, chunk.length - offset);
    if (!dropping && n) { bodyParts.push(chunk.subarray(offset, offset + n)); bodyBytes += n; }
    offset += n; remaining -= n;
    if (remaining === 0) {
      if (!dropping && bodyBytes) {
        try { receiveChrome(parseJSON(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(bodyParts, bodyBytes)))); }
        catch { log('invalid-frame-json'); }
      }
      bodyParts = []; bodyBytes = 0; remaining = null;
    }
  }
});

function connect() {
  if (stopping) return;
  const peer = net.createConnection(socketPath());
  socket = peer;
  const attachId = `attach:${instance}:${++serial}`;
  let attached = false, bytes = 0;
  let parts: Buffer[] = [];
  peer.on('connect', () => {
    log('daemon-connected');
    sendDaemon(peer, { id: attachId, method: 'bridge.attach', params: { kind: 'chrome' } });
    attachTimer = setTimeout(() => peer.destroy(), 10000);
  });
  function receiveLine(line: string) {
    let message: unknown;
    try { message = parseJSON(line); } catch { return log('invalid-daemon-json'); }
    if (!isRecord(message)) return log('invalid-daemon-message');
    if (message.id === attachId) {
      clearTimeout(attachTimer);
      if (message.error || !Object.hasOwn(message, 'result')) return peer.destroy();
      attached = true; delay = 250;
      attachedSocket = peer;
      for (const id of healthPending.keys()) sendHealth(id, peer);
      return log('bridge-attached');
    }
    const probe = typeof message.id === 'string' ? healthPending.get(message.id) : undefined;
    if (probe?.peer === peer) {
      clearTimeout(probe.timer); healthPending.delete(String(message.id));
      const healthy = isRecord(message.result) && message.result.connected === true && message.error === undefined;
      sendChrome({ id: probe.id, method: 'bridge.health', ...(healthy ? { result: { connected: true } }
        : { error: { message: 'Broker health check failed' } }) });
      return;
    }
    if (!attached || (typeof message.id !== 'string' && typeof message.id !== 'number')
        || typeof message.method !== 'string' || !message.method.startsWith('chrome.')) return log('invalid-daemon-request');
    if (pending.size >= 256) {
      sendDaemon(peer, { id: message.id, error: { message: 'Chrome bridge is busy' } });
      return;
    }
    const id = message.id;
    const wireId = `chrome:${instance}:${++serial}`;
    // Invariant: transport/startup wait spends the same 25-second action budget.
    // The host remains able to reply if Chrome suspends the worker and its timers;
    // allow two seconds to deliver its deadline error, still below the broker's 30s.
    const deadline = Math.min(typeof message.deadline === 'number' && Number.isFinite(message.deadline)
      ? message.deadline : Infinity, Date.now() + 25000);
    if (deadline <= Date.now()) {
      sendDaemon(peer, { id, error: { message: 'Chrome action deadline expired before delivery; inspect the tab before retrying' } });
      return;
    }
    const timer = setTimeout(() => {
      pending.delete(wireId);
      sendDaemon(peer, { id, error: { message: 'Chrome action timed out; inspect the page before retrying' } });
      log('request-expired');
    }, Math.max(0, deadline + 2000 - Date.now()));
    pending.set(wireId, { id, peer, timer });
    if (!sendChrome({ id: wireId, method: message.method, params: message.params || {}, deadline })) {
      pending.delete(wireId);
      clearTimeout(timer);
      sendDaemon(peer, { id, error: { message: 'Request exceeds native messaging capacity' } });
    }
  }
  peer.on('data', (chunk: Buffer) => {
    let offset = 0;
    while (offset < chunk.length && !peer.destroyed) {
      const end = chunk.indexOf(10, offset);
      const piece = chunk.subarray(offset, end < 0 ? chunk.length : end);
      bytes += piece.length;
      if (bytes > MAX_LINE) { log('daemon-line-too-large'); peer.destroy(); return; }
      parts.push(piece);
      if (end < 0) break;
      receiveLine(Buffer.concat(parts, bytes).toString('utf8'));
      parts = []; bytes = 0; offset = end + 1;
    }
  });
  peer.on('error', () => log('daemon-unavailable'));
  peer.on('close', () => {
    clearTimeout(attachTimer);
    if (attachedSocket === peer) attachedSocket = undefined;
    for (const [id, probe] of healthPending) if (probe.peer === peer) {
      clearTimeout(probe.timer); healthPending.delete(id);
      sendChrome({ id: probe.id, method: 'bridge.health', error: { message: 'Broker disconnected' } });
    }
    for (const request of pending.values()) clearTimeout(request.timer);
    pending.clear();
    log('daemon-disconnected');
    if (!stopping) {
      retry = setTimeout(connect, delay);
      delay = Math.min(delay * 2, 10000);
    }
  });
}

function stop() {
  if (stopping) return;
  stopping = true;
  clearTimeout(retry); clearTimeout(attachTimer);
  for (const probe of healthPending.values()) clearTimeout(probe.timer);
  healthPending.clear();
  socket?.destroy();
  process.stdin.pause();
  log('host-stopped');
  process.stdout.end(() => process.exit(0));
}
process.stdin.on('end', stop);
process.stdin.on('error', stop);
process.stdout.on('error', () => process.exit(0));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
log('host-started');
connect();
