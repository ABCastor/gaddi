import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';

const repo = path.resolve(import.meta.dirname, '../..');
fs.mkdirSync(path.join(repo, 'tests/.state'), { recursive: true });
const root = fs.mkdtempSync(path.join(repo, 'tests/.state/autonomy-falsify-'));
function copySources(name: string) {
  const copy = path.join(root, name); fs.mkdirSync(copy);
  for (const dir of ['extension', 'shared', 'cli', 'tests/bridge', 'tests/fixtures']) fs.cpSync(path.join(repo, dir), path.join(copy, dir), {
    recursive: true, filter: source => path.basename(source) !== 'dist',
  });
  fs.copyFileSync(path.join(repo, 'package.json'), path.join(copy, 'package.json'));
  return copy;
}
function run(copy: string, file: string, test?: string) {
  const result = spawnSync(process.execPath, [file, ...(test ? [test] : [])], { cwd: copy, encoding: 'utf8', timeout: 60000 });
  const output = result.stdout + result.stderr; fs.writeFileSync(path.join(copy, 'result.log'), output);
  return { result, output };
}
const control = run(copySources('control'), 'tests/bridge/autonomy.ts');
assert.equal(control.result.status, 0, `ASSERT_AUTONOMY_CONTROL\n${control.output}`);
let falsified = 0;
// The one-time fail-before proof is explicit. Normal suites use source mutants
// below and therefore work in shallow clones and archives without old history.
for (const test of process.argv.includes('--baseline') ? ['ASSERT_SHADOW_ISOLATION', 'ASSERT_APPEND_PRESERVES_CHIP', 'ASSERT_FLOATING_MENU_REFS', 'ASSERT_APP_REDIRECT', 'ASSERT_APPEND_CLI'] : []) {
  const copy = copySources('baseline-' + test);
  const file = test === 'ASSERT_APP_REDIRECT' ? 'extension/bg.ts' : test === 'ASSERT_APPEND_CLI' ? 'cli/gaddi.ts' : 'extension/content.ts';
  fs.writeFileSync(path.join(copy, file), execFileSync('git', ['show', `0b8ba36:${file}`], { cwd: repo }));
  const check = test === 'ASSERT_APP_REDIRECT' ? 'tests/bridge/logic.ts' : test === 'ASSERT_APPEND_CLI' ? 'tests/bridge/autonomy-cli.ts' : 'tests/bridge/autonomy.ts';
  const { result, output } = run(copy, check, test === 'ASSERT_APP_REDIRECT' ? '--nav-only' : test === 'ASSERT_APPEND_CLI' ? undefined : test);
  assert.equal(result.status, 1, `ASSERT_AUTONOMY_FALSIFICATION: ${test} ${result.error || ''}\n${output}`);
  assert.ok(!result.error && output.includes(`AssertionError`) && output.includes(test), `ASSERT_AUTONOMY_FALSIFICATION: wrong failure for ${test}\n${output}`);
  console.log(`FALSIFIED ${test}: current test fails against pre-fix 0b8ba36 source`);
  falsified++;
}
// Independently remove each shadow safeguard. Type-filtering alone must not
// hide the exception-isolation case, and catch alone must not call chrome.dom
// with SVG/MathML nodes.
for (const [test, before, after] of [
  ['HTMLElement-filter', 'if (!shadow && el instanceof HTMLElement) {', 'if (!shadow) {'],
  ['per-node-isolation', '} catch { /* One malformed node or unavailable shadow root must not poison the tab. */ }', '} catch (error) { throw error; }'],
] as const) {
  const copy = copySources(test), file = path.join(copy, 'extension/content.ts'), source = fs.readFileSync(file, 'utf8');
  assert.equal(source.split(before).length, 2, 'ASSERT_AUTONOMY_MUTATION_SITE'); // The sweep has two isolation layers (per node and per shadow-root call); removing one alone is masked by the other.
  const mutated = source.replace(before, after);
  fs.writeFileSync(file, test === 'per-node-isolation' ? mutated.replace('catch { shadow = null; }', 'catch (error) { throw error; }') : mutated);
  const { result, output } = run(copy, 'tests/bridge/autonomy.ts', 'ASSERT_SHADOW_ISOLATION');
  assert.equal(result.status, 1, `ASSERT_AUTONOMY_FALSIFICATION: ${test}\n${output}`);
  assert.ok(output.includes('AssertionError') && output.includes('ASSERT_SHADOW_ISOLATION'), `ASSERT_AUTONOMY_FALSIFICATION: ${test}\n${output}`);
  console.log(`FALSIFIED ${test}: shadow isolation assertion fails`);
  falsified++;
}
// Review-discovered boundary cases must fail if their individual fixes go away.
for (const [test, file, before, after, check, testCase] of [
  ['ASSERT_APPEND_PRESERVES_CHIP', 'extension/content.ts', "if (params.mode === 'append') range.collapse(false);", '', 'tests/bridge/autonomy.ts', 'ASSERT_APPEND_PRESERVES_CHIP'],
  ['ASSERT_FLOATING_MENU_REFS', 'extension/content.ts', 'floatingRole(el) ||', "'' ||", 'tests/bridge/autonomy.ts', 'ASSERT_FLOATING_MENU_REFS'],
  ['ASSERT_APP_REDIRECT', 'extension/bg.ts', "const appRoute = event.navigationType === 'historyApi' || appRedirect === destination;", 'const appRoute = false;', 'tests/bridge/logic.ts', '--nav-only'],
  ['ASSERT_APPEND_CLI', 'cli/gaddi.ts', 'if (mode) params.mode = mode;', '', 'tests/bridge/autonomy-cli.ts', undefined],
  ['ASSERT_MENU_NESTED_WRAPPER', 'extension/content.ts', 'if (group(el)) return \x27\x27;', 'if (false) return \x27\x27;', 'tests/bridge/autonomy.ts', 'ASSERT_FLOATING_MENU_REFS'],
  ['ASSERT_APPEND_NATIVE_KEYS', 'extension/bg.ts', 'if (target.appendNeedsEnd)', 'if (false)', 'tests/bridge/logic.ts', undefined],
  ['ASSERT_USER_SCRIPT_TAKEOVER', 'extension/bg.ts', "if (event.reason !== 'scriptInitiated') userNavigation = true;", "userNavigation = event.reason !== 'scriptInitiated';", 'tests/bridge/logic.ts', undefined],
  ['ASSERT_MENU_DEEP_WRAPPER', 'extension/content.ts', 'const grouped = children.some(group) ||', 'const grouped =', 'tests/bridge/autonomy.ts', 'ASSERT_FLOATING_MENU_REFS'],
  ['ASSERT_MENU_COMPOSITE_ITEM', 'extension/content.ts', "(handlesClick(node)\n        ? children.filter(handlesClick).length > 1 : children.length > 1)", '(children.length > 1)', 'tests/bridge/autonomy.ts', 'ASSERT_FLOATING_MENU_REFS'],
  ['ASSERT_MENU_LINEAR_WORK', 'extension/content.ts', "if (action === 'read') floatingGroups.set(node, grouped);", '', 'tests/bridge/autonomy.ts', 'ASSERT_FLOATING_MENU_REFS'],
] as const) {
  const copy = copySources(test), target = path.join(copy, file), source = fs.readFileSync(target, 'utf8');
  assert.equal(source.split(before).length, 2, 'ASSERT_AUTONOMY_MUTATION_SITE'); fs.writeFileSync(target, source.replace(before, after));
  const { result, output } = run(copy, check, testCase);
  assert.equal(result.status, 1, `ASSERT_AUTONOMY_FALSIFICATION: ${test}\n${output}`);
  assert.ok(output.includes('AssertionError') && output.includes(test), `ASSERT_AUTONOMY_FALSIFICATION: ${test}\n${output}`);
  console.log(`FALSIFIED ${test}: review regression fails with its guard removed`);
  falsified++;
}
console.log(`== autonomy falsifications: ${falsified} passed, 0 failed`);
