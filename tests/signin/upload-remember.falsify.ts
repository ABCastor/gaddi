// Break each permission boundary in a disposable mirror, then discard the mutant. Never edit production source.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const repo = path.resolve(import.meta.dirname, '../..'), state = path.join(repo, 'tests/.state');
fs.mkdirSync(state, { recursive: true });
const mutations = [
  { name: 'remembered exception disabled', old: "return ALLOW('owner remembered uploads on this site')", replacement: 'return check', assertion: 'ASSERT_UPLOAD_RULE_APPLIED' },
  { name: 'unremembered sites allowed', old: 'if (policy.uploads?.remember.includes(site))', replacement: 'if (true)', assertion: 'ASSERT_UPLOAD_DEFAULT_HELD' },
  { name: 'exact origin reduced to hostname', old: 'policy.uploads?.remember.includes(site)', replacement: 'policy.uploads?.remember.some(origin => new URL(origin).hostname === new URL(site).hostname)', assertion: 'ASSERT_UPLOAD_EXACT_SITE' },
  { name: 'built-in protected page eligibility removed', section: 'export function uploadSite', old: 'if (builtInPolicy.hold.url_patterns.some(pattern => rx(pattern)?.test(page.href))) return;', replacement: '', assertion: 'ASSERT_UPLOAD_PROTECTED_SITE' },
  { name: 'built-in refused host eligibility removed', section: 'export function uploadSite', old: 'if (builtInPolicy.deny.verbs_on_hosts.some(rule => rx(rule.host)?.test(hostOf(page.href)))) return;', replacement: '', assertion: 'ASSERT_UPLOAD_REFUSED_HOST' },
  { name: 'owner protected URL check removed', old: 'if (rx(pattern)?.test(url)) return HOLD(`url-pattern:${pattern}`);', replacement: '', assertion: 'ASSERT_UPLOAD_OWNER_PROTECTED' },
  { name: 'owner refused host check removed', old: 'if (protectedScope.hosts.some(host => rx(host)?.test(hostOf(url)))) return check;', replacement: '', assertion: 'ASSERT_UPLOAD_OWNER_HOST' },
  { name: 'origin schema validation removed', old: 'uploads: { remember: [exactOrigin] }', replacement: 'uploads: { remember: [() => true] }', assertion: 'ASSERT_UPLOAD_INVALID_SITE' },
  { name: 'unsigned remember accepted', file: 'daemon/approvals.ts', old: 'verifier.verify(proof, message(verb, a, isRecord(proof) ? proof.ts : undefined, remember));', replacement: '', assertion: 'ASSERT_UPLOAD_UNSIGNED_REJECTED' },
  { name: 'Allow once upgraded to permanent', file: 'daemon/proof.ts', old: 'if (site) return `${message}|remember|${site}`;', replacement: 'if (site) return message;', assertion: 'ASSERT_UPLOAD_ONCE_FORGE' },
  { name: 'policy saved after resolving approval', file: 'daemon/approvals.ts', old: 'onRemember(send?.site ?? upload ?? signinSite(a.url), send);', replacement: "resolve(a, 'granted'); onRemember(send?.site ?? upload ?? signinSite(a.url), send);", assertion: 'ASSERT_UPLOAD_SAVE_BEFORE_RESOLVE' },
  { name: 'secret filename refusal removed', file: 'daemon/uploads.ts', old: 'if (PROTECTED_NAMES.some(pattern => pattern.test(name))) refuse(`${name} looks like a key, token or credentials file`);', replacement: '', assertion: 'ASSERT_UPLOAD_REFUSED_FILE' },
  { name: 'revoke does not remove the site', old: 'if (remember) sites.add(site as string); else sites.delete(site as string);', section: 'export function setUploadRemember', replacement: 'if (remember) sites.add(site as string);', assertion: 'ASSERT_UPLOAD_REVOKED' },
  { name: 'daemon upload wiring removed', file: 'daemon/daemon.ts', test: 'upload-broker.ts', old: 'check = checkRememberedUpload(policy, pageURL, check);', replacement: '', assertion: 'ASSERT_UPLOAD_WIRE_REMEMBERABLE' },
  { name: 'daemon audit reason omitted', file: 'daemon/daemon.ts', test: 'upload-broker.ts', old: "if (check.outcome === 'allow' && !params.approval) meta.reason = check.reason;", replacement: '', assertion: 'ASSERT_UPLOAD_WIRE_AUDIT' },
  { name: 'daemon change event omitted', file: 'daemon/daemon.ts', test: 'upload-broker.ts', old: "emit('uploads.remembered', { sites: policy.uploads?.remember ?? [] });", replacement: '', assertion: 'ASSERT_UPLOAD_WIRE_EVENT' },
];
for (const mutation of mutations) {
  const root = fs.mkdtempSync(path.join(state, 'upload-mutant-'));
  try {
    for (const dir of ['daemon', 'policy', 'shared']) fs.cpSync(path.join(repo, dir), path.join(root, dir), { recursive: true });
    const test = 'tests/signin/' + (mutation.test ?? 'upload-remember.test.ts');
    fs.mkdirSync(path.join(root, 'tests/signin'), { recursive: true }); fs.copyFileSync(path.join(repo, test), path.join(root, test));
    fs.mkdirSync(path.join(root, 'tests/fixtures'), { recursive: true });
    fs.copyFileSync(path.join(repo, 'tests/fixtures/owner-home.ts'), path.join(root, 'tests/fixtures/owner-home.ts'));
    const file = path.join(root, mutation.file ?? 'daemon/policy.ts'), source = fs.readFileSync(file, 'utf8');
    const start = mutation.section ? source.indexOf(mutation.section) : 0;
    assert.ok(start >= 0 && source.slice(start).includes(mutation.old), 'Mutation anchor missing: ' + mutation.name);
    fs.writeFileSync(file, source.slice(0, start) + source.slice(start).replace(mutation.old, mutation.replacement));
    const result = spawnSync(process.execPath, [path.join(root, test)], { encoding: 'utf8', timeout: 15000 });
    const output = result.stdout + result.stderr;
    assert.equal(result.status, 1, output); assert.ok(output.includes(mutation.assertion), output);
    console.log(`FALSIFIED upload remember (${mutation.name}: ${mutation.assertion} failed)`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); } // Only this disposable mirror.
}
console.log(`== upload remember falsification: ${mutations.length} passed, 0 failed`);
