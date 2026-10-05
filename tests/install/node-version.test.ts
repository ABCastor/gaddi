import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = process.cwd();
const stateRoot = path.join(repo, 'tests/.state');
fs.mkdirSync(stateRoot, { recursive: true });
const state = fs.mkdtempSync(path.join(stateRoot, 'node-version-'));
const fakeNode = path.join(state, 'node.cjs');
const fakeLaunchctl = path.join(state, 'launchctl.cjs');
const writeExecutable = (file: string, content: string) => fs.writeFileSync(file, `#!${process.execPath}\n${content}`, { mode: 0o700 });

// Execute the installer's actual -e guard with a simulated version, then use real
// Node for plist generation. No version predicate is duplicated in this fixture.
writeExecutable(fakeNode, `
const fs = require('node:fs');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TEST_NODE_CALLS, args[0] + '\\n');
if (args[0] === '-e') {
  vm.runInNewContext(args[1], { process: { versions: { node: process.env.TEST_NODE_VERSION }, exit: code => process.exit(code) } });
} else {
  const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}
`);
writeExecutable(fakeLaunchctl, `
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TEST_SERVICE_CALLS, JSON.stringify(args) + '\\n');
if (args[0] === 'print') process.exit(1);
if (args[0] !== 'bootstrap') process.exit(2);
`);

const rejected = ['21.9.0', '22.0.0', '22.17.9', '23.0.0', '23.5.9'];
const accepted = ['22.18.0', '22.19.0', '23.6.0', '23.7.0', '24.0.0', '25.0.0', '26.0.0'];
let count = 0;
for (const version of [...rejected, ...accepted]) {
  const caseRoot = path.join(state, version);
  fs.mkdirSync(caseRoot);
  const root = path.join(caseRoot, 'config root & quoted');
  const daemonState = path.join(caseRoot, 'daemon-state');
  const nodeCalls = path.join(caseRoot, 'node-calls');
  const serviceCalls = path.join(caseRoot, 'service-calls');
  const env = { ...process.env, GADDI_CONFIG_ROOT: root, GADDI_HOME: daemonState,
    GADDI_NODE: fakeNode, GADDI_LAUNCHCTL: fakeLaunchctl,
    TEST_NODE_VERSION: version, TEST_NODE_CALLS: nodeCalls, TEST_SERVICE_CALLS: serviceCalls };
  const result = spawnSync('/bin/bash', ['install/register/daemon.sh'], { env, encoding: 'utf8' });
  if (rejected.includes(version)) {
    assert.equal(result.status, 1, `${version}: ${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /Node 22\.18\+ on 22\.x or 23\.6\+ required/);
    assert.equal(result.stdout, '');
    assert.equal(fs.existsSync(root), false, 'unsupported Node must not create registration directories');
    assert.equal(fs.existsSync(daemonState), false, 'unsupported Node must not create daemon state');
    assert.equal(fs.existsSync(serviceCalls), false, 'unsupported Node must not call launchctl');
    assert.equal(fs.readFileSync(nodeCalls, 'utf8'), '-e\n', 'unsupported Node must stop before plist generation');
    console.log(`PASS Node ${version} rejected before writes or service calls`);
  } else {
    assert.equal(result.status, 0, `${version}: ${result.stdout}\n${result.stderr}`);
    const plist = path.join(root, 'Library/LaunchAgents/com.abcastor.gaddi.plist');
    const parsed = spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist], { encoding: 'utf8' });
    assert.equal(parsed.status, 0, parsed.stderr);
    const registration = JSON.parse(parsed.stdout);
    assert.deepEqual(registration.ProgramArguments, [fakeNode, path.join(repo, 'daemon/daemon.mjs')]);
    assert.equal(registration.EnvironmentVariables.GADDI_HOME, daemonState);
    assert.equal(fs.readlinkSync(path.join(root, '.local/bin/gaddi')), path.join(repo, 'cli/gaddi'));
    assert.equal(fs.statSync(daemonState).isDirectory(), true);
    assert.equal(fs.readFileSync(nodeCalls, 'utf8'), '-e\n--input-type=module\n');
    assert.deepEqual(fs.readFileSync(serviceCalls, 'utf8').trim().split('\n').map(line => JSON.parse(line)), [
      ['print', `gui/${process.getuid!()}/com.abcastor.gaddi`],
      ['bootstrap', `gui/${process.getuid!()}`, plist],
    ]);
    console.log(`PASS Node ${version} accepted with valid registration and mocked bootstrap`);
  }
  count++;
}
console.log(`== Node registration: ${count} passed, 0 failed`);
