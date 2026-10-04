import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { socketRequest } from '../../shared/socket.ts';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';

type Scenario = 'fragmented' | 'wrong-id' | 'missing-result' | 'malformed' | 'oversized' | 'eof' | 'held' | 'denied';
let passed = 0, failed = 0, sequence = 0;
for (const adapter of ['cli', 'reader', 'mcp']) {
  for (const scenario of ['fragmented', 'wrong-id', 'missing-result', 'malformed', 'oversized', 'eof', 'held', 'denied'] as Scenario[]) {
    const socket = `/tmp/gaddi-transport-${process.pid}-${sequence++}`;
    const connections = new Set<net.Socket>();
    const server = net.createServer(connection => {
      connections.add(connection); connection.once('close', () => connections.delete(connection));
      connection.on('error', () => {});
      connection.once('data', bytes => {
        const request = JSON.parse(bytes.toString());
        if (request.method === 'session.begin') { connection.end(JSON.stringify({ id: request.id, result: {} }) + '\n'); return; }
        const result = request.method === 'output.redact' ? request.params.text
          : ['html', 'look'].includes(request.method) ? { tab: 7, url: 'https://fixture.example/', html: 'Café fixture', text: 'Café fixture' }
          : { tabs: [{ id: 7, url: 'https://fixture.example/', title: 'Café fixture' }] };
        if (scenario === 'eof') { connection.end(); return; }
        if (scenario === 'malformed') { connection.end('{bad json}\n'); return; }
        const response = JSON.stringify({ id: scenario === 'wrong-id' ? 'unrelated' : request.id,
          ...(scenario === 'missing-result' ? {} : ['held', 'denied'].includes(scenario)
            ? { error: { code: scenario, message: scenario } } : { result }) }) + '\n';
        if (scenario === 'oversized') { connection.end(' '.repeat(32 * 1024 * 1024 + 1) + response); return; }
        if (scenario === 'fragmented') {
          const bytes = Buffer.from(response), split = bytes.indexOf(Buffer.from('é')) + 1;
          connection.write(bytes.subarray(0, split)); setTimeout(() => connection.end(bytes.subarray(split)), 5);
        } else connection.end(response);
      });
    });
    await new Promise<void>(resolve => server.listen(socket, resolve));
    try {
      let ok: boolean, code: number | null = null, output = '';
      if (adapter === 'mcp') {
        const client = new Client({ name: 'transport-fixture', version: '1' });
        const transport = new StdioClientTransport({ command: process.execPath,
          args: [fileURLToPath(new URL('../../mcp/server.ts', import.meta.url))],
          env: { ...process.env, GADDI_SOCKET: socket, GADDI_RPC_TIMEOUT_MS: '1000' } });
        try {
          await client.connect(transport);
          const reply = await client.request({ method: 'tools/call', params: { name: 'browser_tabs', arguments: {} } }, CallToolResultSchema);
          output = reply.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
          ok = reply.isError !== true && !output.startsWith('HELD') && !output.startsWith('DENIED');
        } finally { await client.close(); }
      } else {
        const child = spawn(process.execPath, [fileURLToPath(new URL('../../cli/gaddi.ts', import.meta.url)), '--json',
          ...(adapter === 'reader' ? ['read', '7'] : ['tabs'])],
          { env: { ...process.env, GADDI_SOCKET: socket, OMNIREAD_BIN: '/nonexistent-extractor' } });
        child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { output += chunk; }); child.stderr.resume();
        code = await new Promise<number | null>(resolve => child.once('close', resolve)); ok = code === 0;
      }
      assert.equal(ok, scenario === 'fragmented', `ASSERT_TRANSPORT_${adapter}_${scenario}`);
      if (scenario === 'fragmented') {
        assert.ok(output.includes('Café fixture'), `ASSERT_TRANSPORT_${adapter}_UNICODE`);
        assert.ok(!output.includes('\uFFFD'), `ASSERT_TRANSPORT_${adapter}_UNICODE`);
      }
      if (adapter !== 'mcp' && ['held', 'denied'].includes(scenario)) assert.equal(code, scenario === 'held' ? 4 : 5);
      passed++; console.log(`PASS transport ${adapter} ${scenario}`);
    } catch (error) { failed++; console.log(`FAIL ${String(error)}`); }
    finally { for (const c of connections) c.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); }
  }
}
// Falsy results are valid replies; an unresponsive peer must be closed without replay.
for (const result of [null, false, 0, 'silent']) {
  const socket = `/tmp/gaddi-transport-${process.pid}-${sequence++}`;
  let requests = 0;
  let closed!: () => void;
  const disconnected = new Promise<void>(resolve => { closed = resolve; });
  const server = net.createServer(connection => {
    connection.once('close', closed);
    connection.once('data', bytes => {
      requests++;
      const request = JSON.parse(bytes.toString());
      assert.deepEqual(request.params, { caller: 'fixture', session: 'transport' });
      if (result !== 'silent') connection.end(JSON.stringify({ id: request.id, result }) + '\n');
    });
  });
  await new Promise<void>(resolve => server.listen(socket, resolve));
  try {
    const reply = socketRequest(socket, { id: 'fixture', method: 'tabs', params: { caller: 'fixture', session: 'transport' } }, 100);
    if (result === 'silent') await assert.rejects(reply, /daemon timed out on tabs/);
    else assert.equal(await reply, result);
    await Promise.race([disconnected, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('socket left open')), 1000).unref())]);
    assert.equal(requests, 1, 'request never replayed');
    passed++; console.log(`PASS transport ${JSON.stringify(result)} reply and cleanup`);
  } catch (error) { failed++; console.log(`FAIL ${String(error)}`); }
  finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}
console.log(`== transport: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
