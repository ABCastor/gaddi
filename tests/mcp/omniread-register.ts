import { isRecord, parseJSON } from '../../shared/protocol.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = process.cwd();
const stateRoot = path.join(repo, 'tests/.state-mcp');
fs.mkdirSync(stateRoot, { recursive: true });
const state = fs.mkdtempSync(path.join(stateRoot, 'omniread-register-'));
const minimalPath = '/usr/bin:/bin:/usr/sbin:/sbin';
const write = (file: string, value: string, mode = 0o600) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value, { mode });
};
const bin = path.join(state, 'fixture bin');
const discovered = path.join(bin, 'omniread');
const override = path.join(state, 'chosen "extractor"');
for (const file of [discovered, override]) write(file, '#!/bin/sh\nprintf fixture-omniread\n', 0o700);
const callsFile = path.join(state, 'agy-calls.jsonl');
const agy = path.join(state, 'agy.ts');
write(agy, `#!${process.execPath}\nimport fs from 'node:fs';\nfs.appendFileSync(process.env.TEST_AGY_CALLS, JSON.stringify(process.argv.slice(2)) + '\\n');\n`, 0o700);
const configs = [
  ['claude-code', '.claude.json', '{"mcpServers":{"other":{"command":"keep"}}}\n'],
  ['claude-desktop', 'Library/Application Support/Claude/claude_desktop_config.json', '{"mcpServers":{"other":{"command":"keep"}}}\n'],
  ['codex', '.codex/config.toml', 'model = "fixture"\n'],
  ['opencode', '.config/opencode/opencode.jsonc', '{\n  "mcp": {}\n}\n'],
];
let passed = 0;
try {
  for (const [name, input, searchPath, expected] of [
    ['PATH present', undefined, `${bin}:${minimalPath}`, discovered],
    ['explicit absolute overrides PATH', override, `${bin}:${minimalPath}`, override],
    ['explicit relative becomes absolute', path.relative(repo, override), minimalPath, override],
    ['relative PATH becomes absolute', undefined, `${path.relative(repo, bin)}:${minimalPath}`, discovered],
    ['absent on minimal PATH', undefined, minimalPath, undefined],
    ['explicit empty disables discovery', '', `${bin}:${minimalPath}`, undefined],
  ] as [string, string | undefined, string, string | undefined][]) {
    const root = path.join(state, name);
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: searchPath, GADDI_CONFIG_ROOT: root, GADDI_NODE: process.execPath,
      GADDI_LSAPPINFO: '/usr/bin/true', GADDI_AGY: agy, TEST_AGY_CALLS: callsFile };
    delete env.OMNIREAD_BIN;
    if (input !== undefined) env.OMNIREAD_BIN = input;
    const run = (harness: string, args: string[] = []) => {
      const result = spawnSync('/bin/bash', [path.join(repo, `install/register/${harness}.sh`), ...args], { env, cwd: repo, encoding: 'utf8' });
      assert.equal(result.status, 0, `${name}/${harness}: ${result.stdout}\n${result.stderr}`);
      return result.stdout;
    };
    write(path.join(root, '.claude/settings.json'), '{}\n');
    for (const [harness, rel, original] of configs) {
      const file = path.join(root, rel);
      write(file, original);
      const preview = run(harness, ['--dry-run']);
      assert.equal(preview.includes('OMNIREAD_BIN'), expected !== undefined, `${name}/${harness}: preview env`);
      assert.equal(fs.readFileSync(file, 'utf8'), original, 'dry-run preserves config');
      assert.equal(fs.readdirSync(path.dirname(file)).some(f => f.startsWith(path.basename(file) + '.bak-')), false);
      run(harness);
      const registered = fs.readFileSync(file, 'utf8');
      let entryEnv: Record<string, unknown>;
      if (harness === 'codex') {
        const table = registered.split('[mcp_servers.gaddi.env]\n')[1].split('\n\n')[0];
        entryEnv = Object.fromEntries(table.split('\n').map(line => {
          const [, key, value] = line.match(/^(\w+) = (.*)$/)!;
          return [key, parseJSON(value)];
        }));
      } else {
        const config = parseJSON(registered); assert.ok(isRecord(config));
        const servers = harness === 'opencode' ? config.mcp : config.mcpServers; assert.ok(isRecord(servers));
        const entry = servers.gaddi; assert.ok(isRecord(entry));
        const environment = harness === 'opencode' ? entry.environment : entry.env; assert.ok(isRecord(environment));
        entryEnv = environment;
      }
      assert.deepEqual(entryEnv, { GADDI_HARNESS: harness, ...(expected ? { OMNIREAD_BIN: expected } : {}) });
      if (expected) {
        assert.equal(typeof entryEnv.OMNIREAD_BIN, 'string');
        assert.ok(path.isAbsolute(entryEnv.OMNIREAD_BIN as string));
        const extracted = spawnSync(entryEnv.OMNIREAD_BIN as string, [], { env: { PATH: minimalPath }, encoding: 'utf8' });
        assert.equal(extracted.status, 0); assert.equal(extracted.stdout, 'fixture-omniread');
      }
      const before = fs.statSync(file).mtimeMs;
      assert.match(run(harness), /no change:/);
      assert.equal(fs.readFileSync(file, 'utf8'), registered);
      assert.equal(fs.statSync(file).mtimeMs, before, 'idempotent run does not rewrite');
      run(harness, ['--remove', '--dry-run']);
      assert.equal(fs.readFileSync(file, 'utf8'), registered, 'remove dry-run preserves config');
      run(harness, ['--remove']);
      assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /gaddi|OMNIREAD_BIN/);
      assert.match(run(harness, ['--remove']), /no change:/);
    }
    write(callsFile, '');
    const preview = run('agy', ['--dry-run']);
    assert.equal(preview.includes('OMNIREAD_BIN='), expected !== undefined);
    const removePreview = run('agy', ['--remove', '--dry-run']);
    assert.doesNotMatch(removePreview, /OMNIREAD_BIN/);
    assert.equal(fs.readFileSync(callsFile, 'utf8'), '', 'agy dry-run invokes nothing');
    run('agy'); run('agy'); run('agy', ['--remove']);
    const calls = fs.readFileSync(callsFile, 'utf8').trim().split('\n').map((line): string[] => { const value = parseJSON(line); assert.ok(Array.isArray(value) && value.every(item => typeof item === 'string')); return value; });
    const add = ['mcp', 'add', '--type', 'stdio', '--env', 'GADDI_HARNESS=agy',
      ...(expected ? ['--env', `OMNIREAD_BIN=${expected}`] : []), 'gaddi', process.execPath, path.join(repo, 'mcp/server.mjs')];
    assert.deepEqual(calls, [add, ['mcp', 'list'], add, ['mcp', 'list'], ['mcp', 'remove', 'gaddi'], ['mcp', 'list']]);
    // Execute only the printed mock commands to verify shell quoting in dry-run output.
    write(callsFile, '');
    const replay = spawnSync('/bin/bash', ['-c', preview + removePreview], { env, encoding: 'utf8' });
    assert.equal(replay.status, 0, replay.stderr);
    assert.deepEqual(fs.readFileSync(callsFile, 'utf8').trim().split('\n').map((line): string[] => { const value = parseJSON(line); assert.ok(Array.isArray(value) && value.every(item => typeof item === 'string')); return value; }),
      [add, ['mcp', 'list'], ['mcp', 'remove', 'gaddi'], ['mcp', 'list']]);
    console.log(`PASS OmniRead registration: ${name}, all five harnesses; dry-run, repeat and removal`);
    passed++;
  }
  console.log(`== OmniRead registration: ${passed} passed, 0 failed`);
} finally {
  fs.rmSync(state, { recursive: true, force: true }); // Disposable configs and executables only.
}
