import crypto from 'node:crypto';
import type { Socket } from 'node:net';
import { isRecord } from '../shared/protocol.ts';
import type { ChromeParams, ChromeRequest } from '../shared/protocol.ts';
import type { Emit } from './approvals.ts';
import type { SelfHeal } from '../shared/protocol.ts';

// One live bridge owns each forwarded request. Replacement/disconnect rejects its outstanding
// work, and replies from any other socket (including a replaced bridge) cannot settle it.
export function createBridge({ emit = () => {} }: { emit?: Emit } = {}) {
  let current: Socket | null = null;
  let lastSelfHeal: SelfHeal | undefined;
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  function detach(conn: Socket, reason = 'disconnected') {
    if (current !== conn) return;
    current = null;
    for (const [id, p] of pending) {
      clearTimeout(p.timer); pending.delete(id); p.reject(new Error(`chrome bridge ${reason}`));
    }
    emit('bridge.detach', { kind: 'chrome', reason });
  }
  function attach(conn: Socket, kind: unknown) {
    if (kind !== 'chrome') throw new Error('bridge kind must be chrome');
    if (current && current !== conn) {
      const old = current;
      detach(old, 'replaced'); old.destroy();
    }
    if (current !== conn) {
      current = conn;
      conn.once('close', () => detach(conn));
      emit('bridge.attach', { kind: 'chrome' });
    }
    return status();
  }
  function status() { return { kind: 'chrome', connected: !!current && !current.destroyed, ...(lastSelfHeal ? { lastSelfHeal } : {}) }; }
  function health(conn: Socket, params: { lastSelfHeal?: unknown }) {
    if (conn !== current || conn.destroyed) throw new Error('chrome bridge replaced or disconnected');
    const value = params.lastSelfHeal;
    if (isRecord(value) && typeof value.at === 'number' && Number.isFinite(value.at) && value.at > 0
      && value.at <= Date.now() + 60000 && ['native-disconnect', 'broker-unresponsive', 'broker-requested'].includes(String(value.reason))
      && ['reconnect', 'reload'].includes(String(value.action))) {
      // Retain a strict metadata projection, never an arbitrary host payload.
      lastSelfHeal = { at: value.at, reason: value.reason as SelfHeal['reason'], action: value.action as SelfHeal['action'] };
    }
    return status();
  }
  function connection() {
    if (!current || current.destroyed) throw new Error('chrome bridge not connected');
    return current;
  }
  function request(method: string, params: ChromeParams, conn = connection(), deadline = Date.now() + 25000): Promise<unknown> {
    if (conn !== current || conn.destroyed) return Promise.reject(new Error('chrome bridge replaced or disconnected'));
    const id = `bridge-${crypto.randomUUID()}`;
    return new Promise<unknown>((resolve, reject) => {
      const wait = Math.min(30000, Math.max(0, deadline - Date.now()) + (method === 'chrome.approvalCapture' ? 0 : 5000));
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(method === 'chrome.approvalCapture' ? 'approval capture deadline exceeded' : `${method}: bridge timeout after 30 seconds`)); }, wait);
      pending.set(id, { resolve, reject, timer });
      // Invariant: time spent reaching/restarting Chrome consumes the action budget.
      try {
        conn.write(JSON.stringify({ id, method, params, deadline } satisfies ChromeRequest) + '\n', error => {
          if (error) { detach(conn, 'write failed'); conn.destroy(); }
        });
      } catch { detach(conn, 'write failed'); conn.destroy(); }
    });
  }
  function receive(conn: Socket, msg: unknown) {
    if (!isRecord(msg) || msg.method !== undefined || msg.id === undefined) return false;
    if (conn !== current) return true;
    const p = pending.get(typeof msg.id === 'string' ? msg.id : '');
    if (!p) return true;
    pending.delete(typeof msg.id === 'string' ? msg.id : ''); clearTimeout(p.timer);
    if (msg.error !== undefined) {
      const message = typeof msg.error === 'string' ? msg.error : isRecord(msg.error) ? msg.error.message || 'chrome bridge error' : 'chrome bridge error';
      p.reject(Object.assign(new Error(String(message)),
        isRecord(msg.error) && msg.error.code === 'stale' ? { code: 'stale' } : {}));
    }
    else if (Object.hasOwn(msg, 'result')) p.resolve(msg.result);
    else p.reject(new Error('malformed bridge response'));
    return true;
  }
  return { attach, status, health, connection, request, receive };
}
