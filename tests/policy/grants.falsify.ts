// Mutations are confined to a disposable mirror; the real source is never edited. Each one breaks ONE
// rule in daemon/grants.ts and the named check in tests/policy/grants.ts must turn red.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const repo = path.resolve(import.meta.dirname, '../..');
interface Mutation { name: string; old: string; replacement: string; assertion: string }
const mutations: Mutation[] = [
  { name: 'TABLE', assertion: 'ASSERT_GRANT_TABLE',
    old: "return POST_VERBS.includes(folded) ? 'post' : DELETE_VERBS.includes(folded) ? 'delete' : undefined;",
    replacement: "return POST_VERBS.includes(folded) ? 'post' : 'delete';" },
  { name: 'SCOPE', assertion: 'ASSERT_GRANT_SCOPE',
    old: "return { outcome: 'allow', reason: 'session grant', grant: grant.id };", replacement: 'return check;' },
  { name: 'BOUNDARY', assertion: 'ASSERT_GRANT_BOUNDARY',
    old: "url.pathname.startsWith(rule.path + '/')", replacement: 'url.pathname.startsWith(rule.path)' },
  { name: 'ORIGIN', assertion: 'ASSERT_GRANT_ORIGIN', old: 'return url.origin === rule.origin && (', replacement: 'return (' },
  { name: 'PERMISSION', assertion: 'ASSERT_GRANT_PERMISSION',
    old: 'grant.rules.some(rule => rule.permission === needed && covers(rule, target))', replacement: 'grant.rules.some(rule => covers(rule, target))' },
  { name: 'MIXED', assertion: 'ASSERT_GRANT_MIXED',
    old: 'for (const verb of protections(policy).verbs) {', replacement: 'for (const verb of [] as string[]) {' },
  { name: 'DESTINATION', assertion: 'ASSERT_GRANT_DESTINATION', old: 'if (scope.destination) {', replacement: 'if (scope.destination && false) {' },
  { name: 'PROTECTED', assertion: 'ASSERT_GRANT_PROTECTED',
    old: 'if (!permission || !page || protectedAddress(policy, page)) return check;', replacement: 'if (!permission || !page) return check;' },
  { name: 'FINAL', assertion: 'ASSERT_GRANT_FINAL',
    old: "if (check.outcome !== 'hold' || grants.length === 0) return check;", replacement: "if (check.outcome === 'allow' || grants.length === 0) return check;" },
  { name: 'EXPIRY', assertion: 'ASSERT_GRANT_EXPIRY',
    old: "if (entry.grant.expiresAt <= now()) end(id, 'expired');", replacement: "if (false) end(id, 'expired');" },
  { name: 'BINDING', assertion: 'ASSERT_GRANT_BINDING', old: '.filter(grant => grant.session === session);', replacement: '.filter(() => true);' },
  { name: 'CLI', assertion: 'ASSERT_GRANT_BINDING',
    old: 'return session === undefined ? [] : [...entries.values()].map(entry => entry.grant).filter(grant => grant.session === session);',
    replacement: 'return [...entries.values()].map(entry => entry.grant).filter(grant => session === undefined || grant.session === session);' },
  { name: 'LEAK', assertion: 'ASSERT_GRANT_NO_SESSION_LEAK',
    old: 'mine: mine !== undefined && grant.session === mine });', replacement: 'mine: mine !== undefined && grant.session === mine, session: grant.session });' },
  { name: 'REVOKE', assertion: 'ASSERT_GRANT_REVOKE',
    old: "function revoke(id: string) { return end(id, 'revoked'); }", replacement: 'function revoke(id: string) { void id; return false; }' },
  { name: 'SESSION_END', assertion: 'ASSERT_GRANT_SESSION_END',
    old: "if (entry.grant.session === session && end(id, 'session-ended')) ended++;", replacement: 'void id;' },
  { name: 'AUDIT_START', assertion: 'ASSERT_GRANT_AUDIT_START',
    old: "method: 'grant.start',", replacement: "method: 'grant.begin'," },
  { name: 'AUDIT_END_FAILS', assertion: 'ASSERT_GRANT_AUDIT_FAILURE',
    old: "catch { log('session grant end could not be audited'); }", replacement: 'finally { void 0; }' },
  { name: 'AUDIT_START_SKIPPED', assertion: 'ASSERT_GRANT_AUDIT_FAILURE',
    old: "audit({ ts: iso(created), caller: grant.caller, method: 'grant.start', tab: null, url: '', grant: grant.id,",
    replacement: "void ({ ts: iso(created), caller: grant.caller, method: 'grant.start', tab: null, url: '', grant: grant.id," },
  { name: 'NEVER', assertion: 'ASSERT_GRANT_NEVER', old: 'if (!isPermission(permission)) throw new Error(', replacement: 'if (false) throw new Error(' },
  { name: 'SCHEME', assertion: 'ASSERT_GRANT_ADDRESS',
    old: "if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) bad(", replacement: 'if (false) bad(' },
  { name: 'USERINFO', assertion: 'ASSERT_GRANT_ADDRESS', old: 'if (url.username || url.password) bad(', replacement: 'if (false) bad(' },
  { name: 'DOTS', assertion: 'ASSERT_GRANT_ADDRESS', old: "if (segment === '.' || segment === '..') bad(", replacement: 'if (false) bad(' },
  { name: 'EMPTY_SEGMENT', assertion: 'ASSERT_GRANT_ADDRESS', old: "if (segment === '' && index < segments.length - 1) bad(", replacement: 'if (false) bad(' },
  { name: 'ENCODED', assertion: 'ASSERT_GRANT_ADDRESS',
    old: String.raw`if (/[\\?#]|%(?:2e|2f|5c)/i.test(text) ||`, replacement: 'if (false ||' },
  { name: 'PROTECTED_RULE', assertion: 'ASSERT_GRANT_PROTECTED_RULE',
    old: 'if (patterns.some(pattern => rx(pattern)?.test(canonical))) bad(', replacement: 'if (false) bad(' },
  { name: 'GMAIL_RULE', assertion: 'ASSERT_GRANT_GMAIL_RULE',
    old: 'if (hosts.some(host => rx(host)?.test(hostOf(canonical)))) bad(', replacement: 'if (false) bad(' },
  { name: 'COUNT', assertion: 'ASSERT_GRANT_COUNT',
    old: 'if (!Array.isArray(input) || input.length < 1 || input.length > GRANT_RULES_MAX) throw new Error(', replacement: 'if (!Array.isArray(input)) throw new Error(' },
  { name: 'MINUTES', assertion: 'ASSERT_GRANT_REQUEST',
    old: 'minutes < GRANT_MINUTES.min || minutes > GRANT_MINUTES.max', replacement: 'false' },
  { name: 'LABEL', assertion: 'ASSERT_GRANT_REQUEST', old: ' || UNSAFE_LABEL.test(label)', replacement: '' },
  { name: 'DETAIL', assertion: 'ASSERT_GRANT_DETAIL', old: ".join('\\n');", replacement: ".join(' | ');" },
  { name: 'SPEC', assertion: 'ASSERT_GRANT_SPEC', old: 'isRecord(rule) && isPermission(rule.permission)', replacement: 'isRecord(rule)' },
  { name: 'CANONICAL', assertion: 'ASSERT_GRANT_RULES',
    old: String.raw`const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : '/';`, replacement: 'const path = url.pathname;' },
  { name: 'ORDER', assertion: 'ASSERT_GRANT_RULES',
    old: 'return [...unique].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, rule]) => rule);', replacement: 'return [...unique].map(([, rule]) => rule);' },
];

fs.mkdirSync(path.join(repo, 'tests/.state'), { recursive: true });
const mirror = fs.mkdtempSync(path.join(repo, 'tests/.state/grants-mutants-'));
try {
  for (const dir of ['daemon', 'policy', 'shared']) fs.cpSync(path.join(repo, dir), path.join(mirror, dir), { recursive: true });
  fs.mkdirSync(path.join(mirror, 'tests/policy'), { recursive: true });
  fs.copyFileSync(path.join(repo, 'tests/policy/grants.ts'), path.join(mirror, 'tests/policy/grants.ts'));
  const real = fs.readFileSync(path.join(repo, 'daemon/grants.ts'), 'utf8');
  const baseline = spawnSync(process.execPath, [path.join(mirror, 'tests/policy/grants.ts'), 'pristine'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr);
  for (const mutation of mutations) {
    assert.equal(real.split(mutation.old).length, 2, `${mutation.name}: the mutation target must occur exactly once`);
    fs.writeFileSync(path.join(mirror, 'daemon/grants.ts'), real.replace(mutation.old, () => mutation.replacement));
    const result = spawnSync(process.execPath, [path.join(mirror, 'tests/policy/grants.ts'), mutation.name], { encoding: 'utf8', timeout: 30000 });
    const output = result.stdout + result.stderr;
    assert.equal(result.status, 1, `${mutation.name} must fail the suite:\n${output}`);
    assert.ok(output.includes(`FAIL ASSERTION grants: ${mutation.assertion}:`), `${mutation.name} must turn ${mutation.assertion} red:\n${output}`);
    console.log(`FALSIFIED grants (${mutation.name}: ${mutation.assertion} failed)`);
  }
  console.log(`== grants falsification: ${mutations.length} passed, 0 failed`);
} finally { fs.rmSync(mirror, { recursive: true, force: true }); } // Only this test's disposable mirror.
