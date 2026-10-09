// Mutations are confined to a disposable mirror; the real source is never edited. Each one breaks ONE rule in
// daemon/remote.ts and the named check in tests/policy/remote.ts must turn red.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const repo = path.resolve(import.meta.dirname, '../..');
interface Mutation { name: string; old: string; replacement: string; assertion: string }
const ELIGIBLE = "if (!active || a.status !== 'pending') return false;";
const mutations: Mutation[] = [
  // Which requests can ever be answered from another device.
  { name: 'OFF', assertion: 'ASSERT_REMOTE_KINDS', old: ELIGIBLE, replacement: "if (a.status !== 'pending') return false;" },
  { name: 'PENDING', assertion: 'ASSERT_REMOTE_KINDS', old: ELIGIBLE, replacement: 'if (!active) return false;' },
  { name: 'FACTS_KIND', assertion: 'ASSERT_REMOTE_KINDS', old: 'facts.scope.kind === a.kind', replacement: 'true' },
  { name: 'SCOPE', assertion: 'ASSERT_REMOTE_KINDS',
    old: "remoteWaivable(policy, facts.pageURL, { outcome: 'hold', reason: facts.reason }, facts.scope)", replacement: 'true' },
  { name: 'CAP', assertion: 'ASSERT_REMOTE_KINDS', old: 'a.grant.minutes <= REMOTE_GRANT_MINUTES', replacement: 'true' },
  { name: 'CAP_VALUE', assertion: 'ASSERT_REMOTE_KINDS', old: 'export const REMOTE_GRANT_MINUTES = 120;', replacement: 'export const REMOTE_GRANT_MINUTES = 720;' },
  { name: 'GRANT_SPEC', assertion: 'ASSERT_REMOTE_KINDS', old: 'isGrantSpec(a.grant) && ', replacement: '' },
  // How a key becomes the trusted one, and stops being.
  { name: 'ENABLE_PROOF', assertion: 'ASSERT_REMOTE_KEYS',
    old: 'proofs.verify(proof, enableMessage(fingerprint, isRecord(proof) ? proof.ts : undefined));', replacement: '' },
  { name: 'ENABLE_MATCH', assertion: 'ASSERT_REMOTE_KEYS', old: 'if (!found || found.fingerprint !== fingerprint) {', replacement: 'if (!found) {' },
  { name: 'ENABLE_FORMAT', assertion: 'ASSERT_REMOTE_KEYS',
    old: "if (typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint)) {", replacement: "if (typeof fingerprint !== 'string') {" },
  { name: 'SAVE_MODE', assertion: 'ASSERT_REMOTE_KEYS', old: "fs.openSync(temporary, 'wx', 0o600)", replacement: "fs.openSync(temporary, 'wx', 0o777)" },
  { name: 'LOAD_FORGET', assertion: 'ASSERT_REMOTE_KEYS', old: "load(); // the owner's saved choice, read back at startup", replacement: '' },
  { name: 'LOAD_FINGERPRINT', assertion: 'ASSERT_REMOTE_KEYS',
    old: "if (!key || fingerprintOf(key) !== saved.fingerprint) throw new Error('key');", replacement: "if (!key) throw new Error('key');" },
  { name: 'LOAD_DATE', assertion: 'ASSERT_REMOTE_KEYS', old: ' || !Number.isFinite(Date.parse(saved.enabledAt))', replacement: '' },
  { name: 'CANDIDATE_PUBLIC', assertion: 'ASSERT_REMOTE_KEYS', old: " || !pem.trimStart().startsWith('-----BEGIN PUBLIC KEY-----')", replacement: '' },
  { name: 'CANDIDATE_TYPE', assertion: 'ASSERT_REMOTE_KEYS', old: "return key.asymmetricKeyType === 'ed25519' ? key : undefined;", replacement: 'return key;' },
  { name: 'DISABLE_ACTIVE', assertion: 'ASSERT_REMOTE_KEYS', old: 'active = undefined;', replacement: 'void 0;' },
  { name: 'DISABLE_FILE', assertion: 'ASSERT_REMOTE_KEYS', old: 'try { fs.unlinkSync(statePath); }', replacement: 'try { void 0; }' },
  { name: 'DISABLE_SILENT', assertion: 'ASSERT_REMOTE_KEYS',
    old: "if (was || removed) emit('remote.changed', { enabled: false });", replacement: "emit('remote.changed', { enabled: false });" },
  // What makes one decision valid.
  { name: 'SIG', assertion: 'ASSERT_REMOTE_DECISION', old: "if (!valid) return invalid('decision signature verification failed');", replacement: '' },
  { name: 'DIGEST', assertion: 'ASSERT_REMOTE_DECISION', old: '|${remoteDigest(a)}|${nonce}|${ts}`', replacement: '|${nonce}|${ts}`' },
  { name: 'NONCE_FORMAT', assertion: 'ASSERT_REMOTE_DECISION', old: ' || !NONCE.test(nonce)', replacement: '' },
  { name: 'WINDOW', assertion: 'ASSERT_REMOTE_DECISION', old: 'if (Math.abs(Date.now() - ts) > WINDOW_MS) return invalid(', replacement: 'if (false) return invalid(' },
  { name: 'INTEGER', assertion: 'ASSERT_REMOTE_DECISION',
    old: "if (typeof ts !== 'number' || !Number.isSafeInteger(ts)) return invalid(", replacement: "if (typeof ts !== 'number') return invalid(" },
  { name: 'SPEND', assertion: 'ASSERT_REMOTE_DECISION',
    old: "proofs.spend([sha256(signature), sha256(Buffer.from('remote|' + nonce, 'utf8'))]);", replacement: '' },
  { name: 'SPEND_NONCE', assertion: 'ASSERT_REMOTE_DECISION', old: ", sha256(Buffer.from('remote|' + nonce, 'utf8'))", replacement: '' },
];

fs.mkdirSync(path.join(repo, 'tests/.state'), { recursive: true });
const mirror = fs.mkdtempSync(path.join(repo, 'tests/.state/remote-mutants-'));
try {
  for (const dir of ['daemon', 'policy', 'shared']) fs.cpSync(path.join(repo, dir), path.join(mirror, dir), { recursive: true });
  fs.mkdirSync(path.join(mirror, 'tests/policy'), { recursive: true });
  fs.copyFileSync(path.join(repo, 'tests/policy/remote.ts'), path.join(mirror, 'tests/policy/remote.ts'));
  const real = fs.readFileSync(path.join(repo, 'daemon/remote.ts'), 'utf8');
  const baseline = spawnSync(process.execPath, [path.join(mirror, 'tests/policy/remote.ts'), 'pristine'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr);
  for (const mutation of mutations) {
    assert.equal(real.split(mutation.old).length, 2, `${mutation.name}: the mutation target must occur exactly once`);
    fs.writeFileSync(path.join(mirror, 'daemon/remote.ts'), real.replace(mutation.old, () => mutation.replacement));
    const result = spawnSync(process.execPath, [path.join(mirror, 'tests/policy/remote.ts'), mutation.name], { encoding: 'utf8', timeout: 30000 });
    const output = result.stdout + result.stderr;
    assert.equal(result.status, 1, `${mutation.name} must fail the suite:\n${output}`);
    assert.ok(output.includes(`FAIL ASSERTION remote: ${mutation.assertion}:`), `${mutation.name} must turn ${mutation.assertion} red:\n${output}`);
    console.log(`FALSIFIED remote (${mutation.name}: ${mutation.assertion} failed)`);
  }
  console.log(`== remote falsification: ${mutations.length} passed, 0 failed`);
} finally { fs.rmSync(mirror, { recursive: true, force: true }); } // Only this test's disposable mirror.
