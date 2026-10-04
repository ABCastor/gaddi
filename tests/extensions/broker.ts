import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { approvalMessage } from '../../daemon/proof.ts';
import { isRecord } from '../../shared/protocol.ts';
import type { BrokerParams, ExtensionInfo, Reply } from '../../shared/protocol.ts';
import type { StoredApproval } from '../../daemon/approvals.ts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const execute = promisify(execFile);
const root = path.resolve('tests/.state/extensions'); fs.mkdirSync(root, { recursive: true });
const home = fs.mkdtempSync(path.join(root, 'broker-'));
const socket = `/tmp/gaddi-extensions-${process.pid}.sock`;
const keys = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
fs.writeFileSync(path.join(home, 'approver.pub'), keys.publicKey.export({ type: 'spki', format: 'pem' }));
const env = { ...process.env, GADDI_HOME: home, GADDI_SOCKET: socket, GADDI_POLICY_OFF: '0',
  GADDI_APP_LAUNCHER: '/usr/bin/true', GADDI_APPROVER_PUB: path.join(home, 'approver.pub'), GADDI_EXTENSION_INSTALL: '0',
  GADDI_STATE: path.join(home, 'state.json'), GADDI_AUDIT: path.join(home, 'audit.jsonl') };
const log = fs.openSync(path.join(home, 'daemon.log'), 'w');
const daemon = spawn(process.execPath, ['daemon/daemon.ts'], { env, stdio: ['ignore', log, log] }); fs.closeSync(log);
let bridge: net.Socket | undefined, mcp: Client | undefined, passed = 0;
const selfId = 'a'.repeat(32), otherId = 'b'.repeat(32);
const info = (id: string): ExtensionInfo => ({ id, name: id === selfId ? 'Gaddi' : 'Fixture', version: '1', enabled: true,
  installType: 'development', mayDisable: true, type: 'extension', self: id === selfId });
const items = new Map([[selfId, info(selfId)], [otherId, info(otherId)]]);
const mutations: BrokerParams[] = [];
const pass = (label: string) => { passed++; console.log(`PASS ${label}`); };
async function rpc(method: string, params: BrokerParams = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const conn = net.connect(socket); let buffer = '';
    const timeout = setTimeout(() => { conn.destroy(); reject(new Error('fixture RPC timeout')); }, 10000);
    conn.setEncoding('utf8'); conn.on('error', reject);
    conn.on('connect', () => conn.write(JSON.stringify({ id: 1, method, params: { caller: 'extension-test', ...params } }) + '\n'));
    conn.on('data', chunk => {
      buffer += chunk; if (!buffer.includes('\n')) return;
      clearTimeout(timeout); conn.destroy(); resolve(JSON.parse(buffer.slice(0, buffer.indexOf('\n'))) as Reply);
    });
  });
}
async function grant(id: string) {
  const listed = await rpc('approvals.list'); assert.ok(isRecord(listed.result));
  assert.ok(Array.isArray(listed.result.pending));
  const approval = listed.result.pending.find((row: unknown) => isRecord(row) && row.id === id) as StoredApproval;
  assert.ok(approval);
  const ts = Date.now(), message = approvalMessage('grant', approval, ts);
  const sig = crypto.sign('sha256', Buffer.from(message), keys.privateKey).toString('base64');
  const reply = await rpc('approval.grant', { id, proof: { ts, sig } }); assert.equal(reply.error, undefined);
}
try {
  for (let n = 0; !fs.existsSync(socket) && n < 100; n++) {
    if (daemon.exitCode !== null) throw new Error(fs.readFileSync(path.join(home, 'daemon.log'), 'utf8'));
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(fs.existsSync(socket));
  bridge = net.connect(socket); bridge.setEncoding('utf8');
  const ready = new Promise<void>((resolve, reject) => {
    let buffer = ''; bridge!.on('error', reject);
    bridge!.on('connect', () => bridge!.write(JSON.stringify({ id: 'attach', method: 'bridge.attach', params: { kind: 'chrome' } }) + '\n'));
    bridge!.on('data', chunk => {
      buffer += chunk;
      while (buffer.includes('\n')) {
        const index = buffer.indexOf('\n'), message = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
        if (message.id === 'attach') { assert.equal(message.error, undefined); resolve(); continue; }
        assert.equal(message.method, 'chrome.extensions');
        const params = message.params as BrokerParams;
        const id = params.extensionId === 'self' ? selfId : params.extensionId!;
        let result: unknown;
        if (params.operation === 'list') result = { extensions: [...items.values()] };
        else if (params.operation === 'get') result = items.get(id);
        else {
          mutations.push(params);
          if (params.operation === 'disable') items.get(id)!.enabled = false;
          if (params.operation === 'enable') items.get(id)!.enabled = true;
          if (params.operation === 'uninstall') items.delete(id);
          result = { ok: true };
        }
        bridge!.write(JSON.stringify({ id: message.id, result }) + '\n');
      }
    });
  }); await ready;
  const list = await rpc('extensions'); assert.equal(list.error, undefined); assert.ok(isRecord(list.result));
  assert.equal((list.result.extensions as unknown[]).length, 2); pass('broker lists metadata through dedicated management route');
  const reload = await rpc('extensions', { operation: 'reload', extensionId: 'self' }); assert.equal(reload.error, undefined);
  assert.equal(mutations.pop()!.extensionId, selfId); pass('broker requests bounded self reload without approval');
  const held = await rpc('extensions', { operation: 'disable', extensionId: otherId });
  assert.equal(held.error?.code, 'held'); assert.ok(held.error?.approval); assert.equal(mutations.length, 0);
  await grant(held.error.approval.id);
  const disabled = await rpc('extensions', { operation: 'disable', extensionId: otherId, approval: held.error.approval.id });
  assert.equal(disabled.error, undefined); assert.equal(mutations.pop()!.operation, 'disable');
  const replay = await rpc('extensions', { operation: 'disable', extensionId: otherId, approval: held.error.approval.id });
  assert.ok(replay.error); assert.equal(mutations.length, 0); pass('disable waits for signed single-use approval');
  const locked = await rpc('extensions', { operation: 'uninstall', extensionId: 'self' }); assert.equal(locked.error?.code, 'denied');
  pass('broker blocks removing Gaddi even through raw RPC');
  const removal = await rpc('extensions', { operation: 'uninstall', extensionId: otherId }); assert.equal(removal.error?.code, 'held');
  assert.ok(removal.error?.approval); await grant(removal.error.approval.id);
  items.get(otherId)!.version = '2';
  const changed = await rpc('extensions', { operation: 'uninstall', extensionId: otherId, approval: removal.error.approval.id });
  assert.ok(changed.error); assert.equal(mutations.length, 0); pass('changed extension cannot inherit prior uninstall approval');
  const folder = path.join(home, 'local-extension'); fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Local fixture', version: '1' }));
  const install = await rpc('extensions', { operation: 'install', path: folder }); assert.equal(install.error?.code, 'held');
  assert.ok(install.error?.approval); await grant(install.error.approval.id);
  const prepared = await rpc('extensions', { operation: 'install', path: folder, approval: install.error.approval.id });
  assert.equal(prepared.error, undefined); assert.ok(isRecord(prepared.result));
  assert.equal(prepared.result.installed, false); assert.equal(prepared.result.status, 'needs_you');
  pass('outside-repo install is held and never fakes installed without owner setup');
  const install2 = await rpc('extensions', { operation: 'install', path: folder }); assert.ok(install2.error?.approval);
  await grant(install2.error.approval.id); fs.writeFileSync(path.join(folder, 'new-code.js'), 'const changed = true;');
  const codeChanged = await rpc('extensions', { operation: 'install', path: folder, approval: install2.error.approval.id });
  assert.ok(codeChanged.error); assert.equal(mutations.length, 0); pass('whole-code fingerprint invalidates install approval after source edits');
  const cli = await execute(process.execPath, ['cli/gaddi.ts', '--json', 'extensions', 'list'], { env });
  assert.ok(JSON.parse(cli.stdout).result.extensions); pass('CLI extensions command maps to broker');
  mcp = new Client({ name: 'extension-test', version: '0' });
  await mcp.connect(new StdioClientTransport({ command: process.execPath, args: ['mcp/server.ts'], env: { ...env, GADDI_HARNESS: 'extension-test' } }));
  const mcpList = await mcp.callTool({ name: 'browser_extensions', arguments: { operation: 'list' } });
  assert.equal(mcpList.isError, undefined); assert.match(JSON.stringify(mcpList.content), /untrusted page content/);
  const invalid = await mcp.callTool({ name: 'browser_extensions', arguments: { operation: 'disable', extensionId: 'invalid' } });
  assert.equal(invalid.isError, true); assert.equal(mutations.length, 0); pass('MCP wraps extension names as untrusted and raw IDs stay validated');
} finally {
  if (mcp) await mcp.close(); bridge?.destroy();
  if (daemon.exitCode === null && daemon.signalCode === null) {
    const stopped = new Promise(resolve => daemon.once('exit', resolve)); daemon.kill('SIGTERM'); await stopped;
  }
}
console.log(`== extension broker: ${passed} passed, 0 failed`);
