import { isRecord, parseJSON } from '../../shared/protocol.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = process.cwd();
const state = fs.mkdtempSync(path.join(repo, 'tests/.state/install-'));
const root = path.join(state, 'config root & quoted');
const calls = path.join(state, 'calls.jsonl');
const live = path.join(state, 'registered');
let count = 0;
const check = (name: string, fn: () => void) => { fn(); count++; console.log(`PASS ${name}`); };
const write = (file: string, value: string, mode = 0o600) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value, { mode }); };
const mock = path.join(state, 'mock-service');
write(mock, `#!${process.execPath}\n` + `
import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TEST_CALLS, JSON.stringify(args) + '\\n');
if (args[0] === 'print') process.exit(fs.existsSync(process.env.TEST_LIVE) ? 0 : 1);
if (args[0] === 'bootstrap') fs.writeFileSync(process.env.TEST_LIVE, 'yes');
if (args[0] === 'bootout') fs.unlinkSync(process.env.TEST_LIVE);
if (args[0] === 'mcp' && args[1] === 'list') console.log('gaddi');
if (args[0] === 'find' && process.env.TEST_DESKTOP_RUNNING === 'error') process.exit(2);
if (args[0] === 'find' && process.env.TEST_DESKTOP_RUNNING === '1') console.log('ASN:0x0-0x123:');
`, 0o700);
const env: NodeJS.ProcessEnv = { ...process.env, OMNIREAD_BIN: '', GADDI_CONFIG_ROOT: root, GADDI_NODE: process.execPath, GADDI_LAUNCHCTL: mock, GADDI_AGY: mock, GADDI_LSAPPINFO: mock, TEST_CALLS: calls, TEST_LIVE: live };
delete env.GADDI_HOME; delete env.GADDI_APPROVER_PUB;
const run = (script: string, args: string[] = [], wanted = 0, extraEnv: NodeJS.ProcessEnv = {}) => {
  const r = spawnSync('bash', [`install/register/${script}.sh`, ...args], { env: { ...env, ...extraEnv }, encoding: 'utf8' });
  assert.equal(r.status, wanted, `${script}: ${r.stdout}\n${r.stderr}`);
  return r.stdout;
};
const recorded = () => fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map((line): string[] => { const value = parseJSON(line); assert.ok(Array.isArray(value) && value.every(item => typeof item === 'string')); return value; }) : [];
const plist = path.join(root, 'Library/LaunchAgents/com.abcastor.gaddi.plist');
const link = path.join(root, '.local/bin/gaddi');
try {
  check('installer contains only user registration files', () => {
    assert.deepEqual(fs.readdirSync(path.join(repo, 'install')).sort(), ['README.md', 'com.abcastor.gaddi.plist', 'register']);
    assert.equal(fs.existsSync(path.join(repo, 'spike')), false);
  });
  check('daemon dry-run prints user LaunchAgent and CLI without effects', () => {
    const out = run('daemon', ['--dry-run']);
    assert.match(out, /KeepAlive/); assert.match(out, /daemon\/daemon\.mjs/); assert.match(out, /GADDI_APPROVER_PUB/);
    assert.match(out, /config root &amp; quoted/); assert.doesNotMatch(out, /LaunchDaemons|sudo|UserName|playwright/);
    assert.equal(fs.existsSync(root), false); assert.deepEqual(recorded(), []);
    run('daemon', ['--remove', '--dry-run']); assert.equal(fs.existsSync(root), false); assert.deepEqual(recorded(), []);
  });
  check('daemon installs valid plist, user key path and exact CLI symlink with mocked service', () => {
    run('daemon');
    assert.equal(fs.readlinkSync(link), path.join(repo, 'cli/gaddi'));
    const parsed = spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist], { encoding: 'utf8' });
    assert.equal(parsed.status, 0, parsed.stderr);
    const p = parseJSON(parsed.stdout);
    assert.ok(isRecord(p)); assert.ok(isRecord(p.EnvironmentVariables));
    assert.deepEqual(p.ProgramArguments, [process.execPath, path.join(repo, 'daemon/daemon.mjs')]);
    assert.equal(p.EnvironmentVariables.GADDI_APPROVER_PUB, path.join(root, 'Library/Application Support/Gaddi/approver.pub'));
    assert.equal(p.EnvironmentVariables.GADDI_EXTENSION_INSTALL, '0');
    assert.equal(p.KeepAlive, true); assert.equal(Object.hasOwn(p, 'UserName'), false);
    assert.equal(recorded().filter(c => c[0] === 'bootstrap').length, 1);
  });
  check('repeat daemon registration leaves plist unchanged and does not restart', () => {
    const before = fs.statSync(plist).mtimeMs;
    assert.match(run('daemon'), /already registered/);
    assert.equal(fs.statSync(plist).mtimeMs, before);
    assert.equal(recorded().filter(c => c[0] === 'bootstrap').length, 1);
  });
  check('extension installation requires explicit owner opt-in at registration', () => {
    const preview = run('daemon', ['--dry-run', '--allow-extension-install']);
    assert.match(preview, /GADDI_EXTENSION_INSTALL<\/key><string>1<\/string>/);
    run('daemon', ['--allow-extension-install']);
    const read = () => JSON.parse(spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist], { encoding: 'utf8' }).stdout);
    assert.equal(read().EnvironmentVariables.GADDI_EXTENSION_INSTALL, '1');
    run('daemon');
    assert.equal(read().EnvironmentVariables.GADDI_EXTENSION_INSTALL, '0');
  });
  check('daemon refuses to overwrite unrelated CLI command', () => {
    fs.unlinkSync(link); write(link, 'other tool');
    const out = spawnSync('bash', ['install/register/daemon.sh', '--dry-run'], { env, encoding: 'utf8' });
    assert.equal(out.status, 1); assert.match(out.stderr, /refusing unrelated path/);
    assert.equal(fs.readFileSync(link, 'utf8'), 'other tool');
    fs.unlinkSync(link); fs.symlinkSync(path.join(repo, 'cli/gaddi'), link);
  });
  check('agy dry-run prints add/remove and list without invoking CLI', () => {
    const before = recorded().length;
    assert.match(run('agy', ['--dry-run']), /mcp add --type stdio --env GADDI_HARNESS=agy gaddi/);
    assert.match(run('agy', ['--remove', '--dry-run']), /mcp remove gaddi/);
    assert.equal(recorded().length, before);
  });
  check('agy passes separate argv, harness identity, and verifies through list', () => {
    run('agy'); run('agy'); run('agy', ['--remove']);
    const agy = recorded().filter(c => c[0] === 'mcp');
    assert.deepEqual(agy[0], ['mcp', 'add', '--type', 'stdio', '--env', 'GADDI_HARNESS=agy', 'gaddi', process.execPath, path.join(repo, 'mcp/server.mjs')]);
    assert.deepEqual(agy[1], ['mcp', 'list']); assert.deepEqual(agy[4], ['mcp', 'remove', 'gaddi']);
  });
  check('app dry-run replaces in place without a startup registration or command effects', () => {
    const before = recorded().length;
    const out = run('app', ['--dry-run']);
    assert.match(out, /replace in place \(rsync -a --delete\)/);
    assert.match(out, /launches on demand/);
    assert.doesNotMatch(out, /LaunchAgents|bootstrap|KeepAlive|Would write/);
    run('app', ['--remove', '--dry-run']);
    assert.equal(recorded().length, before);
  });
  check('app updates keep one bundle in place and preserve service registrations', () => {
    const bundle = path.join(root, 'Applications/Gaddi.app');
    const source = path.join(state, 'built.app');
    const appLive = path.join(state, 'app-registered');
    const bin = path.join(state, 'bin');
    const build = path.join(state, 'mock-build.sh');
    const trash = path.join(state, 'mock-trash');
    write(build, `printf '%s\\n' "$TEST_APP_SOURCE"\n`);
    write(trash, `#!${process.execPath}\n` + `
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TEST_CALLS, JSON.stringify(['trash', ...args]) + '\\n');
fs.mkdirSync(process.env.TEST_BIN, { recursive: true });
for (const file of args) fs.renameSync(file, path.join(process.env.TEST_BIN, path.basename(file)));
`, 0o700);
    const extra = { GADDI_APP_BUILD: build, GADDI_CODESIGN: mock, GADDI_TRASH: trash, TEST_APP_SOURCE: source, TEST_LIVE: appLive, TEST_BIN: bin };
    write(path.join(source, 'Contents/MacOS/fixture'), 'new binary', 0o700);
    write(path.join(bundle, 'Contents/stale'), 'old');
    const servicePlist = fs.readFileSync(plist, 'utf8');
    write(appLive, 'yes');
    const inode = fs.statSync(bundle).ino;
    const before = recorded().length;
    run('app', [], 0, extra);
    assert.equal(fs.statSync(bundle).ino, inode);
    assert.equal(fs.readFileSync(path.join(bundle, 'Contents/MacOS/fixture'), 'utf8'), 'new binary');
    assert.equal(fs.existsSync(path.join(bundle, 'Contents/stale')), false);
    assert.equal(fs.readFileSync(plist, 'utf8'), servicePlist); assert.equal(fs.readFileSync(appLive, 'utf8'), 'yes');
    assert.equal(fs.existsSync(path.join(bin, 'Gaddi.app')), false);
    const first = recorded().slice(before);
    assert.equal(first.filter(c => ['print', 'bootout', 'bootstrap'].includes(c[0])).length, 0);
    assert.equal(first.filter(c => c[0] === 'bootstrap').length, 0);
    assert.deepEqual(first.filter(c => c[0] === 'trash'), []);
    run('app', [], 0, extra);
    assert.equal(fs.statSync(bundle).ino, inode);
    assert.equal(fs.readFileSync(appLive, 'utf8'), 'yes');
    assert.equal(recorded().slice(before).filter(c => ['print', 'bootout', 'bootstrap'].includes(c[0])).length, 0);
    run('app', ['--remove'], 0, extra);
    assert.equal(fs.existsSync(bundle), false); assert.equal(fs.readFileSync(plist, 'utf8'), servicePlist);
    assert.equal(fs.readFileSync(appLive, 'utf8'), 'yes');
    assert.ok(fs.existsSync(path.join(bin, 'Gaddi.app')));
    assert.equal(recorded().slice(before).filter(c => ['print', 'bootout', 'bootstrap'].includes(c[0])).length, 0);
    assert.equal(recorded().slice(before).filter(c => c[0] === 'bootstrap').length, 0);
  });
  check('Desktop running detection blocks install and remove without writing; dry-run skips detection', () => {
    const config = path.join(root, 'Library/Application Support/Claude/claude_desktop_config.json');
    write(config, '{}\n');
    const before = recorded().length;
    for (const args of [[], ['--remove']]) {
      const r = spawnSync('bash', ['install/register/claude-desktop.sh', ...args], {
        env: { ...env, TEST_DESKTOP_RUNNING: '1' }, encoding: 'utf8',
      });
      assert.equal(r.status, 1); assert.equal(r.stdout, '');
      assert.match(r.stderr, /quit Claude Desktop first; it rewrites this config file from memory/);
      assert.equal(r.stderr.trim().split('\n').length, 1);
      assert.equal(fs.readFileSync(config, 'utf8'), '{}\n');
    }
    assert.deepEqual(recorded().slice(before), Array(2).fill(['find', 'bundleID=com.anthropic.claudefordesktop']));
    const detected = recorded().length;
    run('claude-desktop', ['--dry-run'], 0, { TEST_DESKTOP_RUNNING: '1' });
    assert.equal(recorded().length, detected);
    run('claude-desktop', [], 2, { TEST_DESKTOP_RUNNING: 'error' });
    assert.equal(fs.readFileSync(config, 'utf8'), '{}\n');
    run('claude-desktop');
    const registered = parseJSON(fs.readFileSync(config, 'utf8'));
    assert.ok(isRecord(registered) && isRecord(registered.mcpServers));
    const entry = registered.mcpServers.gaddi; assert.ok(isRecord(entry) && isRecord(entry.env));
    assert.equal(entry.env.GADDI_HARNESS, 'claude-desktop');
  });
  check('all eight registrations dry-run and removal dry-run leave configs untouched', () => {
    const fixtures = {
      '.claude.json': '{}\n', '.claude/settings.json': '{}\n',
      'Library/Application Support/Claude/claude_desktop_config.json': '{}\n',
      '.codex/config.toml': 'model = "fixture"\n', '.config/opencode/opencode.jsonc': '{\n  "mcp": {}\n}\n',
    };
    for (const [file, value] of Object.entries(fixtures)) write(path.join(root, file), value);
    const before = recorded().length;
    for (const args of [['--dry-run'], ['--remove', '--dry-run']]) {
      const out = run('all', args);
      for (const unit of ['daemon', 'claude-code', 'claude-desktop', 'codex', 'opencode', 'agy', 'app', 'chrome-bridge']) assert.ok(out.includes(`== register/${unit}.sh`), unit);
    }
    assert.equal(recorded().length, before);
    for (const [file, value] of Object.entries(fixtures)) assert.equal(fs.readFileSync(path.join(root, file), 'utf8'), value);
  });
  console.log(`== install: ${count} passed, 0 failed`);
} finally {
  fs.rmSync(state, { recursive: true, force: true }); // Only this suite's scratch files.
}
