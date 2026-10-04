import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = path.resolve(import.meta.dirname, '../..');
const root = fs.mkdtempSync(path.join(repo, 'tests/.state/version-falsify-'));
// Each mutant gets a full copy of the relevant suites and production sources.
// No test is changed and no import points back to mutable production sources.
const content = 'extension/content.ts';
const mutations = [
  ['ASSERT_VERSION_ACCEPT', content, '&& params.version !== pageVersion()', '&& (params.version === pageVersion() || params.version !== pageVersion())'],
  ['ASSERT_VERSION_INSERT', content, "add(selectorFor(el)); add(el.tagName);", "if (!state.ids.has(el)) continue; add(selectorFor(el)); add(el.tagName);"],
  ['ASSERT_VERSION_REMOVE', content, "of document.querySelectorAll<PageElement>(controls + ', a[href], button')", "of ([...state.nodes.values()].filter(el => el.matches('a[href]')).length > document.querySelectorAll('a[href]').length ? state.nodes.values() : document.querySelectorAll<PageElement>(controls + ', a[href], button'))"],
  ['ASSERT_VERSION_TYPING', content, "add(el.getAttribute('type'));", "add(el.getAttribute('type')); add(el.value);"],
  ['ASSERT_VERSION_SCROLL', content, 'add(location.href); add(performance.timeOrigin);', 'add(location.href); add(performance.timeOrigin); add(scrollY);'],
  ['ASSERT_VERSION_FOCUS', content, 'add(location.href); add(performance.timeOrigin);', "add(location.href); add(performance.timeOrigin); add(activeElement() ? selectorFor(activeElement()!) : '');"],
  ['ASSERT_VERSION_TEXT', content, 'add(location.href); add(performance.timeOrigin);', 'add(location.href); add(performance.timeOrigin); add(document.body.textContent);'],
  ['ASSERT_VERSION_RELOAD', content, 'add(location.href); add(performance.timeOrigin);', 'add(location.href);'],
  ['ASSERT_VERSION_NAVIGATION', content, 'add(location.href); add(performance.timeOrigin);', 'add(performance.timeOrigin);'],
  ['ASSERT_VERSION_OPTIONAL', content, "if (params.version && ['describe'", "if (true && ['describe'"],
  ['ASSERT_VERSION_ORDER', content, "add(selectorFor(el)); add(el.tagName);", 'add(el.tagName);'],
  ['ASSERT_VERSION_ATTRIBUTES', content, "add(el.getAttribute('type'));", "add('');"],
  ['ASSERT_VERSION_DESCRIBE', content, "['describe', 'snapshot', 'pressCheck'", "['snapshot', 'pressCheck'"],
  ['ASSERT_VERSION_MCP', 'mcp/server.ts', "{ tab, version, key: S, approval }", "{ tab, key: S, approval }"],
  ['ASSERT_VERSION_DISPATCH', 'extension/bg.ts', 'args: [action, params]', "args: [action, action === 'hoverPoint' ? { ...params, version: undefined } : params]"],
  ['ASSERT_VERSION_CHANGED', 'extension/bg.ts', 'changed: before.signature !== after.signature', 'changed: false'],
  ['ASSERT_VERSION_AFTER', 'extension/bg.ts', '...(after.version ? { version: after.version } : {})', '...{}'],
  ['ASSERT_VERSION_RECHECK', 'extension/bg.ts', "'typeCheck', { ...target, version: params.version }", "'typeCheck', target"],
  ['ASSERT_VERSION_NATIVE', 'bridge/host.ts', "...(error.code === 'stale' ? { code: 'stale' } : {})", '...{}'],
  ['ASSERT_VERSION_BROKER_FORWARD', 'daemon/daemon.ts', 'args.version = versionParam(params.version);', 'args.version = versionParam(params.version) && undefined;'],
  ['ASSERT_VERSION_BROKER_STALE', 'daemon/bridge.ts', "msg.error.code === 'stale' ? { code: 'stale' }", "msg.error.code === 'stale' ? { code: 'lost' }"],
  ['ASSERT_VERSION_BROKER_SHAPE', 'shared/protocol.ts', '{1,128}', '{1,129}'],
] as const;
let failures = 0;
for (const [name, file, before, after] of mutations) {
  const copy = path.join(root, name); fs.mkdirSync(copy, { recursive: true });
  for (const dir of ['extension', 'shared', 'daemon', 'mcp', 'bridge', 'policy']) fs.cpSync(path.join(repo, dir), path.join(copy, dir), { recursive: true });
  for (const dir of ['bridge', 'fixtures', 'mcp']) fs.cpSync(path.join(repo, 'tests', dir), path.join(copy, 'tests', dir), { recursive: true });
  fs.mkdirSync(path.join(copy, 'tests/.state'), { recursive: true });
  fs.copyFileSync(path.join(repo, 'tsconfig.json'), path.join(copy, 'tsconfig.json'));
  fs.copyFileSync(path.join(repo, 'package.json'), path.join(copy, 'package.json'));
  fs.symlinkSync(path.join(repo, 'node_modules'), path.join(copy, 'node_modules'));
  const target = path.join(copy, file), source = fs.readFileSync(target, 'utf8');
  const sites = name === 'ASSERT_VERSION_RECHECK' ? 2 : 1;
  assert.equal(source.split(before).length - 1, sites, `mutation sites for ${name}`);
  fs.writeFileSync(target, source.replaceAll(before, after));
  if (file === 'extension/bg.ts') {
    const build = spawnSync(path.join(repo, 'node_modules/.bin/tsc'), ['-p', 'extension/tsconfig.json'], { cwd: copy, encoding: 'utf8' });
    assert.equal(build.status, 0, build.stdout + build.stderr);
  }
  const suite = file === 'bridge/host.ts' ? ['tests/bridge/framing.ts'] : file === 'mcp/server.ts' ? ['tests/mcp/metadata.test.ts'] : file === 'extension/bg.ts' ? ['tests/bridge/logic.ts'] : name.startsWith('ASSERT_VERSION_BROKER_') ? ['tests/fixtures/broker-checks.ts', 'page-version', 'gated'] : ['tests/bridge/version-logic.ts'];
  const result = spawnSync(process.execPath, suite, { cwd: copy, encoding: 'utf8' });
  const output = result.stdout + result.stderr;
  fs.writeFileSync(path.join(copy, 'result.log'), output);
  // A suite may prefix its own name ("FAIL bridge framing: AssertionError ..."), so the
  // assertion branch is not anchored to the start of the line.
  const failed = [...output.matchAll(/^FAIL (ASSERT_VERSION_\w+):|AssertionError[^\n]*?(ASSERT_VERSION_\w+)/gm)].map(match => match[1] || match[2]);
  if (result.status !== 1 || JSON.stringify(failed) !== JSON.stringify([name])) {
    console.error(`FAIL falsification ${name}: exit=${result.status} failed=${JSON.stringify(failed)} ${result.error || ''}\n${output}`); failures++;
  } else console.log(`FALSIFIED ${name}: ${before} => ${after}; only ${name} failed`);
}
console.log(`== version falsifications: ${mutations.length - failures}/${mutations.length} isolated mutants killed`);
process.exitCode = failures ? 1 : 0;
