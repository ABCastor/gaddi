import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = path.resolve(import.meta.dirname, '../..');
fs.mkdirSync(path.join(repo, 'tests/.state'), { recursive: true });
const root = fs.mkdtempSync(path.join(repo, 'tests/.state/debugger-falsify-'));
const cleanup = `          if (attached.get(tab) === session && session.owner === owner) {
            const hadMotion = emulations.get(tab)?.animationSpeed !== undefined;
            emulations.delete(tab);
            await chrome.debugger.detach(target).catch(() => {});
            if (attached.get(tab) === session) attached.delete(tab);
            if (hadMotion) forTab<PageResult | false>(tab, cleanupCheck => !emulations.has(tab)
              && onPage(tab, 'animationSpeed', { reset: true }, cleanupCheck)).catch(() => {});
          }
`;
// Predictions: removing cleanup leaks both maps and page motion; removing the
// inherited-focus condition lets the successor evaluate before disabling focus.
// Keep the catch/rethrow so the first mutation changes cleanup, not error reporting.
const mutations = [
  ['ASSERT_DEBUGGER_FAILED_DISABLE_CLEANUP', cleanup, ''],
  ['ASSERT_DEBUGGER_INHERITED_FOCUS', 'if (input || session.inputFocus)', 'if (input)'],
  // Another extension's frame: each guard of its removal and retry, broken alone.
  ['ASSERT_FOREIGN_NO_REPLAY', 'throw foreignFrameError(delivered);', 'throw foreignFrameError(false);'],
  ['ASSERT_FOREIGN_RETRY_UNSENT', 'return withDebugger(tab, fn, scope.check, retryInput, route); });', 'throw error; });'],
  ['ASSERT_FOREIGN_TYPE_LANDED', "{ selector: target.selector, text: target.expectedText ?? params.text }, check)).landed) throw error;", "{ selector: target.selector, text: target.expectedText ?? params.text }, check)).landed || true) throw error;"],
  ['ASSERT_FOREIGN_CLICK_HANDED', 'if (!handed || !isForeignFrameError(error)) throw error;', 'throw error;'],
  ['ASSERT_FOREIGN_TYPE_RETRY_NO_FOCUS', '}, true, false).catch(async error => {\n        // A menu that opens on the typed text', '}, true, true).catch(async error => {\n        // A menu that opens on the typed text'],
  ['ASSERT_FOREIGN_MOVE_RETRY', "&& !(method === 'Input.dispatchMouseEvent' && (params as { type?: string } | undefined)?.type === 'mouseMoved')", ''],
  ['ASSERT_FOREIGN_CANCEL', "return detachReasons.get(tab) === 'target_closed';", 'return true;'],
  ['ASSERT_FOREIGN_REMOVE', "if ((await onPage(tab, 'closeForeignFrames', {}, check)).closed)", "if ((await onPage(tab, 'snapshot', {}, check)).closed)"],
  ['ASSERT_FOREIGN_BACKGROUND_CLOSE', 'if (route.foreign) await queued(', 'if (false) await queued('],
  ['ASSERT_FOREIGN_FROZEN_REPORTED', '.catch(error => { throw isForeignFrameError(error) ? new Error(FROZEN_FOREIGN_HELP) : error; });', ';'],
  ['ASSERT_FOREIGN_ADOPT', "if (lingering.has(tab) && actionErrorMessage(error).startsWith('Another debugger is already attached'))",
    "if (false && actionErrorMessage(error).startsWith('Another debugger is already attached'))"],
] as const;

function copySources(name: string) {
  const copy = path.join(root, name);
  fs.mkdirSync(copy);
  for (const dir of ['extension', 'shared', 'tests/bridge', 'tests/fixtures']) {
    fs.cpSync(path.join(repo, dir), path.join(copy, dir), {
      recursive: true, filter: source => path.basename(source) !== 'dist',
    });
  }
  fs.copyFileSync(path.join(repo, 'package.json'), path.join(copy, 'package.json'));
  return copy;
}

function run(copy: string) {
  const result = spawnSync(process.execPath, ['tests/bridge/logic.ts'], {
    cwd: copy, encoding: 'utf8', timeout: 60000,
  });
  const output = result.stdout + result.stderr;
  fs.writeFileSync(path.join(copy, 'result.log'), output);
  return { result, output };
}

// A control proves the same copied harness runs with the original sources.
const control = run(copySources('control'));
assert.equal(control.result.status, 0, `ASSERT_DEBUGGER_FALSIFICATION_CONTROL: ${control.result.error || ''}\n${control.output}`);
for (const [name] of mutations) assert.ok(control.output.includes(`PASS ${name}\n`), 'ASSERT_DEBUGGER_FALSIFICATION_CONTROL');
console.log('PASS ASSERT_DEBUGGER_FALSIFICATION_CONTROL');

let failures = 0;
for (const [name, before, after] of mutations) {
  const copy = copySources(name);
  const target = path.join(copy, 'extension/bg.ts');
  const source = fs.readFileSync(target, 'utf8');
  assert.equal(source.split(before).length, 2, `ASSERT_DEBUGGER_MUTATION_SITE: ${name}`);
  fs.writeFileSync(target, source.replace(before, after));
  const { result, output } = run(copy);
  // Count every assertion failure, including unrelated ones. A crash, timeout,
  // import error, or different failed assertion is not a successful falsification.
  const failed = output.match(/^AssertionError[^\n]*|^FAIL [^\n]*/gm) || [];
  if (result.status !== 1 || result.error || failed.length !== 1
    || !failed[0].endsWith(`: ${name}`)) {
    console.error(`FAIL ASSERT_DEBUGGER_FALSIFICATION: ${name} exit=${result.status} failures=${JSON.stringify(failed)} ${result.error || ''}\n${output}`);
    failures++;
  } else console.log(`FALSIFIED ${name}: exit=1; only ${name} failed`);
}
console.log(`== debugger falsifications: ${mutations.length - failures}/${mutations.length} isolated mutants killed`);
console.log(`Evidence: ${path.relative(repo, root)}`);
process.exitCode = failures ? 1 : 0;
