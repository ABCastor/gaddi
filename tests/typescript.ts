import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const repo = path.resolve(import.meta.dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'gaddi-extension-types-'));
function files(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory()
      ? files(path.join(directory, entry.name)).map(file => path.join(entry.name, file))
      : [entry.name]).sort();
}
const entryFiles = new Set(['daemon/daemon.mjs', 'mcp/server.mjs']);
for (const file of [...entryFiles, 'bridge/host.sh', 'cli/gaddi']) {
  fs.accessSync(path.join(repo, file), fs.constants.X_OK);
  assert.match(fs.readFileSync(path.join(repo, file), 'utf8'), /^#!/, `${file} must remain directly executable`);
}
console.log('PASS compatibility entries: executable modes and shebangs retained');
function checkSources(directory: string): void {
  for (const entry of fs.readdirSync(path.join(repo, directory), { withFileTypes: true })) {
    if (entry.name.startsWith('.state') || (directory === 'extension' && entry.name === 'dist')) continue;
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) checkSources(relative);
    else if (/\.(?:m?js)$/.test(entry.name)) assert(entryFiles.has(relative), `${relative} must be TypeScript`);
  }
}
for (const directory of ['bridge', 'cli', 'daemon', 'extension', 'install', 'mcp', 'shared', 'tests']) checkSources(directory);
try {
  execFileSync(path.join(repo, 'node_modules/.bin/tsc'), [
    '-p', path.join(repo, 'extension/tsconfig.json'), '--outDir', temporary,
  ], { cwd: repo, stdio: 'inherit' });
  const emitted = path.join(repo, 'extension/dist');
  assert.deepEqual(files(emitted), files(temporary), 'Extension output files are stale; run npm run build:extension');
  for (const file of files(temporary)) {
    assert.deepEqual(fs.readFileSync(path.join(emitted, file)), fs.readFileSync(path.join(temporary, file)),
      `${file} is stale; run npm run build:extension`);
  }
  const manifest: unknown = JSON.parse(fs.readFileSync(path.join(repo, 'extension/manifest.json'), 'utf8'));
  assert(manifest !== null && typeof manifest === 'object' && 'background' in manifest);
  const background = manifest.background;
  assert(background !== null && typeof background === 'object' && 'service_worker' in background);
  assert(typeof background.service_worker === 'string');
  assert.equal(background.service_worker, 'dist/extension/bg.js');
  assert(fs.existsSync(path.join(repo, 'extension', background.service_worker)));
  console.log('PASS extension output: fresh clone entry exists and emitted JavaScript matches TypeScript');
} finally {
  fs.rmSync(temporary, { recursive: true, force: true }); // Only this test's temporary compiler output.
}
