// Mutations are confined to disposable mirrors; the real source is never edited.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const repo = path.resolve(import.meta.dirname, '../..');
const mutations = [
  { name: 'remember exception disabled', old: "return ALLOW('owner remembered this send kind on this site')", replacement: 'return check', assertion: 'ASSERT_SEND_RULE_APPLIED' },
  { name: 'daemon send wiring removed', file: 'daemon/daemon.ts', test: 'tests/signin/send-broker.ts', old: 'check = checkRememberedSend(policy, pageURL, method, check, submitName);', replacement: '', assertion: 'ASSERT_SEND_WIRE_REMEMBERABLE' },
  { name: 'protected-page exclusion removed', old: 'if (builtInPolicy.hold.url_patterns.some(pattern => rx(pattern)?.test(page.href))) return;', replacement: '', assertion: 'ASSERT_PROTECTED_PAGE_INELIGIBLE' },
];
for (const mutation of mutations) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gaddi-send-mutant-'));
  try {
    for (const dir of ['daemon', 'policy', 'shared']) fs.cpSync(path.join(repo, dir), path.join(root, dir), { recursive: true });
    const test = mutation.test ?? 'tests/signin/send-remember.test.ts'; fs.mkdirSync(path.join(root, 'tests/signin'), { recursive: true });
    fs.copyFileSync(path.join(repo, test), path.join(root, test));
    const policy = path.join(root, mutation.file ?? 'daemon/policy.ts'), source = fs.readFileSync(policy, 'utf8');
    assert.ok(source.includes(mutation.old), 'Mutation anchor missing');
    fs.writeFileSync(policy, source.replace(mutation.old, mutation.replacement));
    const result = spawnSync(process.execPath, [path.join(root, test)], { encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.ok(result.stderr.includes(mutation.assertion), result.stdout + result.stderr);
    console.log(`FALSIFIED send remember (${mutation.name}: ${mutation.assertion} failed)`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); } // Only the disposable mirror.
}
console.log('== send remember falsification: 3 passed, 0 failed');
