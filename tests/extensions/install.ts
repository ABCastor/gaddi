import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import type { Duplex } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { GateError } from '../../daemon/approvals.ts';
import { validateUnpackedExtension, needsUnpackedInstall, installUnpackedExtension } from '../../daemon/extensions-install.ts';

// Disposable owner-home fixtures, never the real Chrome profile or extension.
const fixtures = fs.mkdtempSync(path.resolve('tests/.state-install-'));
const home = path.join(fixtures, 'owner');
fs.mkdirSync(home, { mode: 0o700 });
const options = { home, trustedRoot: path.join(home, 'Developer'), quarantine: async (_file: string) => false };
let passed = 0, skipped = 0;
class Unavailable extends Error {}
function folder(relative: string, manifest: unknown = { name: 'Fixture Extension', version: '1.2', manifest_version: 3 }) {
  const target = path.join(home, relative);
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(target, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 });
  fs.writeFileSync(path.join(target, 'worker.js'), 'console.log("fixture");\n', { mode: 0o600 });
  return target;
}
async function test(name: string, run: () => unknown | Promise<unknown>) {
  try { await run(); passed++; console.log(`PASS ${name}`); }
  catch (error) { if (!(error instanceof Unavailable)) throw error; skipped++; console.log(`SKIP ${name}: ${error.message}`); }
}
async function denied(target: unknown, extra = {}) {
  await assert.rejects(validateUnpackedExtension(target, { ...options, ...extra }), (error: unknown) => error instanceof GateError && error.code === 'denied');
}

class FakeSocket extends EventTarget {
  readyState: 0 | 1 | 2 | 3 = 0;
  messages: Record<string, unknown>[] = [];
  closed = false;
  response: unknown = { id: 1, result: { id: 'a'.repeat(32) } };
  send(data: string) {
    this.messages.push(JSON.parse(data));
    if (this.response !== undefined) queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(this.response) })));
  }
  close() { this.closed = true; this.readyState = 3; }
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
}
const profile = path.join(home, 'Library/Application Support/Google/Chrome');
fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
const activePort = path.join(profile, 'DevToolsActivePort');
function endpoint(text = '9222\n/devtools/browser\n') { fs.writeFileSync(activePort, text, { mode: 0o600 }); fs.chmodSync(activePort, 0o600); }
let source: Awaited<ReturnType<typeof validateUnpackedExtension>>;
const owned = folder('Developer/fixture/extension');
try {
  await test('owner repo subtree is unheld, full content has SHA256 fingerprint', async () => {
    source = await validateUnpackedExtension(owned, options);
    assert.equal(source.path, fs.realpathSync(owned)); assert.equal(source.trusted, true); assert.equal(source.requiresApproval, false);
    assert.match(source.fingerprint, /^[a-f0-9]{64}$/);
  });
  await test('no configured root grants no unattended trust', async () => {
    const result = await validateUnpackedExtension(owned, { ...options, trustedRoot: '' });
    assert.equal(result.trusted, false); assert.equal(result.requiresApproval, true);
  });
  await test('omitted and invalid configured roots grant no unattended trust', async () => {
    const previous = process.env.GADDI_EXTENSION_TRUST_ROOT;
    const { trustedRoot: _root, ...withoutRoot } = options;
    try {
      delete process.env.GADDI_EXTENSION_TRUST_ROOT;
      const unset = await validateUnpackedExtension(owned, withoutRoot);
      assert.equal(unset.requiresApproval, true);
      const link = path.join(home, 'linked-root'); fs.symlinkSync(options.trustedRoot, link);
      for (const trustedRoot of ['Developer', path.join(home, 'missing-root'), fixtures, link]) {
        const result = await validateUnpackedExtension(owned, { ...options, trustedRoot });
        assert.equal(result.trusted, false); assert.equal(result.requiresApproval, true);
      }
    } finally {
      if (previous === undefined) delete process.env.GADDI_EXTENSION_TRUST_ROOT;
      else process.env.GADDI_EXTENSION_TRUST_ROOT = previous;
    }
  });
  await test('other owner-local source needs approval', async () => {
    const external = await validateUnpackedExtension(folder('Documents/local-extension'), options);
    assert.equal(external.trusted, false); assert.equal(external.requiresApproval, true);
  });
  await test('trust root itself is not trusted', async () => {
    const result = await validateUnpackedExtension(folder('Developer'), options);
    assert.equal(result.trusted, false);
  });
  await test('sibling prefix cannot inherit repository trust', async () => {
    const result = await validateUnpackedExtension(folder('Developer-other/fixture'), options);
    assert.equal(result.trusted, false);
  });
  await test('full tree fingerprint changes on script, addition, and empty folder changes', async () => {
    const target = folder('Documents/fingerprint');
    const a = await validateUnpackedExtension(target, options);
    fs.writeFileSync(path.join(target, 'worker.js'), 'console.log("changed");\n');
    const b = await validateUnpackedExtension(target, options); assert.notEqual(a.fingerprint, b.fingerprint);
    fs.writeFileSync(path.join(target, 'unused.txt'), 'also-bound');
    const c = await validateUnpackedExtension(target, options); assert.notEqual(b.fingerprint, c.fingerprint);
    fs.mkdirSync(path.join(target, 'empty'));
    const d = await validateUnpackedExtension(target, options); assert.notEqual(c.fingerprint, d.fingerprint);
    assert.equal(d.fingerprint, (await validateUnpackedExtension(target, options)).fingerprint);
  });
  await test('URLs, relative paths, empty paths, files, missing folder denied', async () => {
    for (const target of ['https://example.test/addon.zip', 'file:///local', './extension', '', null, path.join(owned, 'manifest.json'), path.join(home, 'missing')]) await denied(target);
  });
  await test('Downloads and protected secret folders/files denied', async () => {
    for (const location of ['Downloads/addon', '.ssh/addon', 'Library/Application Support/Google/Chrome/addon']) await denied(folder(location));
    const target = folder('Documents/contains-secret'); fs.writeFileSync(path.join(target, '.env'), 'FIXTURE_ONLY=value'); await denied(target);
  });
  await test('outside owner home denied', async () => {
    fs.writeFileSync(path.join(fixtures, 'manifest.json'), '{}'); await denied(fixtures);
  });
  await test('root and nested symlink escapes denied', async () => {
    const downloaded = folder('Downloads/linked');
    const link = path.join(home, 'Developer/link'); fs.symlinkSync(downloaded, link); await denied(link);
    const target = folder('Documents/nested-link'); fs.symlinkSync(path.join(owned, 'worker.js'), path.join(target, 'linked.js')); await denied(target);
    const rootAlias = path.join(home, 'repo-alias'); fs.symlinkSync(owned, rootAlias); await denied(rootAlias);
  });
  await test('other-user writable files and parents denied', async () => {
    const target = folder('Documents/writable'); fs.chmodSync(path.join(target, 'worker.js'), 0o666); await denied(target);
    const parent = path.join(home, 'shared'); fs.mkdirSync(parent); const child = folder('shared/extension'); fs.chmodSync(parent, 0o777); await denied(child);
  });
  await test('quarantine on content and enclosing source denied', async () => {
    await denied(owned, { quarantine: async (file: string) => file.endsWith('worker.js') });
    await denied(owned, { quarantine: async (file: string) => file === path.dirname(owned) });
  });
  await test('production xattr checker rejects actual macOS quarantine', async () => {
    const target = folder('Documents/quarantined'); execFileSync('/usr/bin/xattr', ['-w', 'com.apple.quarantine', '0081;fixture', target]);
    await assert.rejects(validateUnpackedExtension(target, { home }), (error: unknown) => error instanceof GateError && error.code === 'denied');
  });
  await test('production xattr checker rejects download-origin metadata without quarantine', async () => {
    const target = folder('Documents/download-origin'); execFileSync('/usr/bin/xattr', ['-w', 'com.apple.metadata:kMDItemWhereFroms', 'fixture-origin', target]);
    await assert.rejects(validateUnpackedExtension(target, { home }), (error: unknown) => error instanceof GateError && error.code === 'denied');
  });
  await test('malformed or unsupported manifest denied', async () => {
    for (const [i, manifest] of [[], null, { name: 'Fixture', version: '1', manifest_version: 2 }, { name: '', version: '1', manifest_version: 3 }, { name: 'Fixture', version: '65536.1', manifest_version: 3 }, { name: 'Fixture', version: '0.0', manifest_version: 3 }, { name: 'Fixture', version: '1', manifest_version: 3, key: 'pinned-identity' }].entries())
      await denied(folder(`Documents/bad-manifest-${i}`, manifest));
  });
  await test('whole-tree change during async check denied', async () => {
    const target = folder('Documents/racing'); let changed = false;
    await denied(target, { quarantine: async (file: string) => {
      if (file.endsWith('worker.js') && !changed) { fs.writeFileSync(path.join(target, 'manifest.json'), '{"name":"replacement"}'); changed = true; }
      return false;
    } });
  });
  await test('bounded tree refuses huge files', async () => {
    const target = folder('Documents/large'); fs.writeFileSync(path.join(target, 'large.dat'), ''); fs.truncateSync(path.join(target, 'large.dat'), 64 * 1024 * 1024 + 1); await denied(target);
  });
  await test('manual/default-off returns canonical instructions and never opens socket', async () => {
    const instructions = needsUnpackedInstall(source); assert.equal(instructions.installed, false); assert.equal(instructions.status, 'needs_you');
    assert.ok(instructions.steps.some(step => step.includes(source.path)));
    const result = await installUnpackedExtension(source, { ...options, enabled: false, connect() { throw new Error('must not connect'); } });
    assert.equal(result.installed, false);
  });
  await test('HELD static-rules source falls back before connection or snapshot writes', async () => {
    const target = folder('Documents/static-rules', { name: 'Rules fixture', version: '1', manifest_version: 3,
      declarative_net_request: { rule_resources: [{ id: 'fixture', enabled: true, path: 'rules.json' }] } });
    fs.writeFileSync(path.join(target, 'rules.json'), '[]');
    const expected = await validateUnpackedExtension(target, options); assert.equal(expected.hasStaticRules, true);
    const stateRoot = path.join(home, '.gaddi-static-rules-tests');
    const result = await installUnpackedExtension(expected, { ...options, stateRoot, enabled: true, connect() { throw new Error('must not connect'); } });
    assert.equal(result.installed, false); assert.match(result.reason, /static network rules/); assert.equal(fs.existsSync(stateRoot), false);
  });
  await test('trusted owner static-rules source uses its writable live tree', async () => {
    endpoint();
    const target = folder('Developer/static-rules/extension', { name: 'Owner rules fixture', version: '1', manifest_version: 3,
      declarative_net_request: { rule_resources: [{ id: 'fixture', enabled: true, path: 'rules.json' }] } });
    fs.writeFileSync(path.join(target, 'rules.json'), '[]');
    const expected = await validateUnpackedExtension(target, options); const socket = new FakeSocket();
    assert.equal(expected.hasStaticRules, true); assert.equal(expected.requiresApproval, false);
    const result = await installUnpackedExtension(expected, { ...options, enabled: true, connect() { queueMicrotask(() => socket.open()); return socket; } });
    assert.equal(result.installed, true); assert.equal(result.snapshot, false); assert.equal(result.path, target);
    assert.deepEqual(socket.messages, [{ id: 1, method: 'Extensions.loadUnpacked', params: { path: target } }]);
  });
  await test('missing/untrusted endpoint falls back without socket', async () => {
    for (const text of ['9222\nws://evil.test/devtools/browser\n', '65536\n/devtools/browser\n', '9222\n/devtools/page/target\n', '9222\n/devtools/browser?method=evil\n']) {
      endpoint(text); const result = await installUnpackedExtension(source, { ...options, enabled: true, connect() { throw new Error('must not connect'); } }); assert.equal(result.installed, false);
    }
    endpoint(); fs.chmodSync(activePort, 0o666);
    const result = await installUnpackedExtension(source, { ...options, enabled: true, connect() { throw new Error('must not connect'); } }); assert.equal(result.installed, false);
  });
  await test('consent connection uses fixed loopback browser target and only loadUnpacked', async () => {
    endpoint('9222\n/devtools/browser/12345678-1234-1234-1234-123456789abc\n');
    const socket = new FakeSocket(); let url = '';
    const promise = installUnpackedExtension(source, { ...options, enabled: true, connect(value) { url = value; queueMicrotask(() => socket.open()); return socket; } });
    const result = await promise; assert.equal(url, 'ws://127.0.0.1:9222/devtools/browser');
    assert.deepEqual(socket.messages, [{ id: 1, method: 'Extensions.loadUnpacked', params: { path: source.path } }]);
    assert.equal(result.installed, true); assert.equal(result.status, 'installed'); assert.equal(socket.closed, true);
  });
  await test('content replaced while Chrome approval waits sends nothing', async () => {
    endpoint(); const target = folder('Documents/chrome-approval-race'); const expected = await validateUnpackedExtension(target, options);
    const socket = new FakeSocket();
    const promise = installUnpackedExtension(expected, { ...options, enabled: true, connect() {
      queueMicrotask(() => { fs.writeFileSync(path.join(target, 'worker.js'), 'replacement'); socket.open(); }); return socket;
    } });
    await assert.rejects(promise, (error: unknown) => error instanceof GateError && error.code === 'approval-invalid'); assert.equal(socket.messages.length, 0); assert.equal(socket.closed, true);
  });
  await test('content changed before connection cannot reuse a validated action', async () => {
    endpoint(); const target = folder('Documents/before-connect-race'); const expected = await validateUnpackedExtension(target, options);
    fs.writeFileSync(path.join(target, 'worker.js'), 'replacement');
    await assert.rejects(installUnpackedExtension(expected, { ...options, enabled: true, connect() { throw new Error('must not connect'); } }),
      (error: unknown) => error instanceof GateError && error.code === 'approval-invalid');
  });
  await test('HELD source mutation at send cannot change approved Chrome snapshot', async () => {
    endpoint(); const target = folder('Documents/held-snapshot'); const expected = await validateUnpackedExtension(target, options);
    const original = fs.readFileSync(path.join(target, 'worker.js'), 'utf8');
    const stateRoot = path.join(home, '.gaddi-snapshot-tests'); const socket = new FakeSocket(); const send = socket.send.bind(socket);
    let loadedPath = '';
    socket.send = data => {
      const request = JSON.parse(data); loadedPath = request.params.path;
      fs.writeFileSync(path.join(target, 'worker.js'), 'replacement-after-final-validation');
      assert.equal(fs.readFileSync(path.join(loadedPath, 'worker.js'), 'utf8'), original);
      send(data);
    };
    const result = await installUnpackedExtension(expected, { ...options, stateRoot, enabled: true, connect() { queueMicrotask(() => socket.open()); return socket; } });
    assert.equal(result.installed, true); assert.equal(result.sourcePath, target); assert.equal(result.path, loadedPath);
    assert.ok('loadedPath' in result); assert.equal(result.loadedPath, loadedPath); assert.equal(result.snapshot, true);
    assert.ok('contentFingerprint' in result); assert.equal(result.contentFingerprint, expected.fingerprint);
    assert.equal(fs.statSync(loadedPath).mode & 0o777, 0o500); assert.equal(fs.statSync(path.join(loadedPath, 'worker.js')).mode & 0o777, 0o400);
    assert.ok(fs.existsSync(loadedPath), 'Chrome-loaded snapshot is retained after request ends');
  });
  await test('existing approved snapshot is reused, corrupted cache fails closed', async () => {
    endpoint(); const target = folder('Documents/snapshot-reuse'); const expected = await validateUnpackedExtension(target, options);
    const stateRoot = path.join(home, '.gaddi-reuse-tests');
    const install = () => { const socket = new FakeSocket(); return installUnpackedExtension(expected, { ...options, stateRoot, enabled: true, connect() { queueMicrotask(() => socket.open()); return socket; } }); };
    const first = await install(); assert.equal(first.installed, true);
    const second = await install(); assert.equal(second.installed, true); assert.equal(second.path, first.path);
    fs.chmodSync(path.join(first.path, 'worker.js'), 0o600); fs.writeFileSync(path.join(first.path, 'worker.js'), 'tampered cache'); fs.chmodSync(path.join(first.path, 'worker.js'), 0o400);
    await assert.rejects(install(), (error: unknown) => error instanceof GateError && error.code === 'denied');
  });
  await test('standard 0755 app-state root supports private 0700 snapshot cache', async () => {
    endpoint(); const target = folder('Documents/standard-state-root'); const expected = await validateUnpackedExtension(target, options);
    const stateRoot = path.join(home, '.gaddi-standard-state-tests'); fs.mkdirSync(stateRoot); fs.chmodSync(stateRoot, 0o755);
    const socket = new FakeSocket();
    const result = await installUnpackedExtension(expected, { ...options, stateRoot, enabled: true, connect() { queueMicrotask(() => socket.open()); return socket; } });
    assert.equal(result.installed, true); assert.equal(result.snapshot, true);
    assert.equal(fs.statSync(stateRoot).mode & 0o777, 0o755, 'existing app-state permissions are preserved');
    assert.equal(fs.statSync(path.join(stateRoot, 'extension-installs')).mode & 0o777, 0o700);
  });
  await test('other-writable 0775 app-state root cannot host approved snapshots', async () => {
    endpoint(); const target = folder('Documents/writable-state-root'); const expected = await validateUnpackedExtension(target, options);
    const stateRoot = path.join(home, '.gaddi-writable-state-tests'); fs.mkdirSync(stateRoot); fs.chmodSync(stateRoot, 0o775);
    const socket = new FakeSocket();
    await assert.rejects(installUnpackedExtension(expected, { ...options, stateRoot, enabled: true, connect() { queueMicrotask(() => socket.open()); return socket; } }),
      (error: unknown) => error instanceof GateError && error.code === 'denied');
    assert.equal(socket.messages.length, 0); assert.equal(fs.existsSync(path.join(stateRoot, 'extension-installs')), false);
  });
  await test('Chrome refusal cannot claim installed', async () => {
    endpoint(); const socket = new FakeSocket(); socket.response = { id: 1, error: { code: -32000, message: 'fixture refusal' } };
    const result = await installUnpackedExtension(source, { ...options, enabled: true, connect() { queueMicrotask(() => socket.open()); return socket; } });
    assert.equal(result.status, 'needs_you'); assert.equal(result.installed, false);
  });
  await test('invalid Chrome confirmation reports unknown instead of fake success', async () => {
    endpoint(); const socket = new FakeSocket(); socket.response = { id: 1, result: { id: 'not-an-extension-id' } };
    const result = await installUnpackedExtension(source, { ...options, enabled: true, connect() { queueMicrotask(() => socket.open()); return socket; } });
    assert.equal(result.installed, null); assert.ok(result.steps.some(step => /before retrying/.test(step)));
  });
  await test('unanswered Chrome dialog times out without a load', async () => {
    endpoint(); const socket = new FakeSocket();
    const result = await installUnpackedExtension(source, { ...options, enabled: true, timeoutMs: 10, connect() { return socket; } });
    assert.equal(result.installed, false); assert.equal(socket.messages.length, 0); assert.equal(socket.closed, true);
  });
  await test('timeout after request reports unknown and does not resend', async () => {
    endpoint(); const socket = new FakeSocket(); socket.response = undefined;
    const result = await installUnpackedExtension(source, { ...options, enabled: true, timeoutMs: 30, connect() { queueMicrotask(() => socket.open()); return socket; } });
    assert.equal(result.installed, null); assert.equal(socket.messages.length, 1); assert.equal(socket.closed, true);
  });
  await test('native Node WebSocket loads exactly once over disposable loopback server', async () => {
    const messages: Record<string, unknown>[] = [];
    const sockets = new Set<Duplex>();
    const server = http.createServer();
    server.on('upgrade', (request, socket) => {
      assert.equal(request.url, '/devtools/browser'); assert.equal(request.headers.origin, undefined);
      sockets.add(socket); socket.on('close', () => sockets.delete(socket));
      const accept = crypto.createHash('sha1').update(String(request.headers['sec-websocket-key']) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      let buffered = Buffer.alloc(0);
      socket.on('data', chunk => {
        buffered = Buffer.concat([buffered, chunk]);
        if (buffered.length < 2) return;
        if ((buffered[0]! & 0x0f) === 8) { socket.end(Buffer.from([0x88, 0])); return; }
        let length = buffered[1]! & 0x7f, offset = 2;
        if (length === 126) { if (buffered.length < 4) return; length = buffered.readUInt16BE(2); offset = 4; }
        assert.notEqual(length, 127); assert.equal(buffered[1]! & 0x80, 0x80);
        if (buffered.length < offset + 4 + length) return;
        const mask = buffered.subarray(offset, offset + 4); const data = buffered.subarray(offset + 4, offset + 4 + length);
        const decoded = Buffer.from(data); for (let i = 0; i < decoded.length; i++) decoded[i] = decoded[i]! ^ mask[i % 4]!;
        messages.push(JSON.parse(decoded.toString('utf8'))); buffered = buffered.subarray(offset + 4 + length);
        const reply = Buffer.from(JSON.stringify({ id: 1, result: { id: 'b'.repeat(32) } }));
        socket.write(Buffer.concat([Buffer.from([0x81, reply.length]), reply]));
      });
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', (error: NodeJS.ErrnoException) => reject(['EPERM', 'EACCES'].includes(error.code ?? '')
          ? new Unavailable('sandbox prohibits loopback server listen; run this wire check outside the sandbox') : error));
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address(); assert.ok(address && typeof address !== 'string');
      endpoint(`${address.port}\n/devtools/browser\n`);
      const result = await installUnpackedExtension(source, { ...options, enabled: true, timeoutMs: 2000 });
      assert.equal(result.installed, true);
      assert.deepEqual(messages, [{ id: 1, method: 'Extensions.loadUnpacked', params: { path: source.path } }]);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
  console.log(`== extension install: ${passed} passed, 0 failed, ${skipped} skipped`);
} finally {
  // Only disposable generated test state is removed, never owner folders.
  function writable(folder: string) {
    fs.chmodSync(folder, 0o700);
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) if (entry.isDirectory()) writable(path.join(folder, entry.name));
  }
  writable(fixtures);
  fs.rmSync(fixtures, { recursive: true, force: true });
}
