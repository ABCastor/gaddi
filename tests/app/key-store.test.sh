#!/bin/bash
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
BUNDLE="$(bash "$REPO/app/build.sh")"
STATE="$REPO/tests/.state/app-key-store-$$"
mkdir -p "$STATE"
# Exercise an isolated store. No daemon, authentication or signing is invoked.
node - "$BUNDLE/Contents/MacOS/Gaddi" "$STATE" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { createPublicKey, createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const [app, state] = process.argv.slice(2);
const directory = path.join(state, 'keys');
const keyPath = path.join(directory, 'approver.key');
const publicPath = path.join(directory, 'approver.pub');
// Allow isolated full-suite runs to keep even the optional fallback off live keys.
const homePublicPath = process.env.GADDI_TEST_PUBLIC_HOME || process.env.HOME || os.homedir();
const defaultPublicPath = path.join(homePublicPath, 'Library', 'Application Support', 'Gaddi', 'approver.pub');

function isInteractionNotAllowed(result) {
  return (result.status === 3 || result.status === 1) && /-25308/.test(result.stderr);
}

function validateP256Spki(publicPemPath) {
  const pem = fs.readFileSync(publicPemPath, 'utf8');
  assert.match(pem, /^-----BEGIN PUBLIC KEY-----\n[\s\S]+\n-----END PUBLIC KEY-----\n$/);
  const publicKey = createPublicKey({ key: pem, format: 'pem', type: 'spki' });
  assert.equal(publicKey.asymmetricKeyType, 'ec');
  assert.equal(publicKey.asymmetricKeyDetails.namedCurve, 'prime256v1');
  return publicKey;
}

function run() {
  const result = spawnSync(app, ['--print-public-key'], { encoding: 'utf8', timeout: 20000, env: { ...process.env, GADDI_KEY_DIR: directory } });
  assert.ifError(result.error); // A hung process/prompt is a failure, never a skip.
  assert.equal(result.signal, null);
  return result;
}
const first = run();
fs.writeFileSync(path.join(state, 'print-public-key.log'), first.stderr);
if (first.status !== 0) {
  if (isInteractionNotAllowed(first)) {
    console.log('SKIP app key store: isolated creation requires user-interactive Secure Enclave context (OSStatus error -25308).');
    if (fs.existsSync(defaultPublicPath)) {
      const publicKey = validateP256Spki(defaultPublicPath);
      assert.equal(publicKey.export({ format: 'pem', type: 'spki' }), fs.readFileSync(defaultPublicPath, 'utf8'));
      console.log('PASS app key store: fallback user-level approver.pub is valid P-256 SPKI PEM');
    } else {
      console.log(`SKIP app key store: no fallback public key found at ${defaultPublicPath}`);
    }
    process.exit(0);
  }
  if (first.status === 3) assert.match(first.stderr, /Secure Enclave unavailable: approvals need it/);
  assert.equal(fs.existsSync(keyPath), false, 'Failed creation must not publish a key');
  console.error(`FAIL app key store: isolated key unavailable (exit ${first.status})`);
  console.error(first.stderr.trim());
  process.exit(1);
}
const stat = fs.lstatSync(keyPath);
assert.ok(stat.isFile() && stat.size > 0, 'Missing or empty enclave blob');
assert.equal(stat.mode & 0o777, 0o600, 'approver.key must be mode 0600');
console.log('PASS app key store: nonempty approver.key has mode 0600');
const pem = fs.readFileSync(publicPath, 'utf8');
assert.match(pem, /^-----BEGIN PUBLIC KEY-----\n[\s\S]+\n-----END PUBLIC KEY-----\n$/);
const publicKey = validateP256Spki(publicPath);
assert.equal(publicKey.export({ format: 'pem', type: 'spki' }), pem);
assert.equal(first.stdout, pem);
console.log('PASS app key store: approver.pub is valid P-256 SPKI PEM');
const digest = () => createHash('sha256').update(fs.readFileSync(keyPath)).digest('hex');
const before = digest();
const second = run();
assert.equal(second.status, 0, second.stderr);
assert.equal(second.stdout, pem, 'Public identity changed across processes');
assert.equal(fs.readFileSync(publicPath, 'utf8'), pem);
assert.equal(digest(), before, 'Stored enclave blob changed');
assert.equal(fs.statSync(keyPath).mode & 0o777, 0o600);
console.log('PASS app key store: fresh process retains blob and public identity');
console.log('== app key store: 3 passed, 0 failed');
NODE
