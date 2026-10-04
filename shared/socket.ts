import net from 'node:net';
import type { BrokerRequest, BrokerResult } from './protocol.ts';
import { isRecord, parseJSON } from './protocol.ts';

export class SocketError extends Error {
  raw: unknown;
  constructor(raw: unknown) { super(isRecord(raw) && typeof raw.message === 'string' ? raw.message : undefined); this.raw = raw; }
}

export function socketRequest<M extends string>(socket: string, request: BrokerRequest & { method: M }, timeoutMs: number): Promise<BrokerResult<M>> {
  return new Promise((resolve, reject) => {
    const connection = net.connect(socket), chunks: string[] = [];
    let bytes = 0, settled = false;
    const finish = (complete: () => void) => { if (settled) return; settled = true; clearTimeout(timer); connection.destroy(); complete(); };
    const fail = (message: string) => finish(() => reject(new SocketError({ code: 'error', message })));
    const timer = setTimeout(() => fail(`daemon timed out on ${request.method}`), timeoutMs);
    connection.setEncoding('utf8');
    connection.on('connect', () => connection.write(JSON.stringify(request) + '\n'));
    connection.on('error', error => fail(`daemon connection failed: ${error.message}`));
    connection.on('end', () => fail('daemon closed the connection without a response'));
    connection.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 32 * 1024 * 1024) return fail('daemon response exceeds 32 MiB');
      const end = chunk.indexOf('\n');
      chunks.push(end < 0 ? chunk : chunk.slice(0, end));
      if (end < 0) return;
      let message: unknown;
      try { message = parseJSON(chunks.join('')); } catch { return fail('malformed response from daemon'); }
      if (!isRecord(message) || message.id !== request.id) return fail('daemon response ID mismatch');
      if (message.error) return finish(() => reject(new SocketError(message.error)));
      if (!Object.hasOwn(message, 'result')) return fail('daemon response has no result');
      finish(() => resolve(message.result as BrokerResult<M>));
    });
  });
}
