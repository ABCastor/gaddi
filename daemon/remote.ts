// daemon/remote.ts — the owner answers some holds from another device (a local bot, for instance a Telegram bot).
//
// It is OFF by default, it is switched ON only by the owner's Touch ID at the Mac, and anyone who can reach the
// socket may switch it OFF, because switching off only removes authority. Only the holds a session grant may
// waive (grants.ts) can be answered this way: uploads, posts and deletes on pages that are not protected, and a
// session-grant request of two hours or less. Everything else stays Touch ID only.
//
// Invariants (each is falsified by a mutation in tests/gates/remote-approver-mutations.test.sh):
//  1. Trust is ONE Ed25519 public key that the owner enabled with a Touch ID signature over that key's fingerprint
//     (`remote.enable`). The drop-in file the bot writes is only a candidate: inert until enabled, and once
//     enabled, changing it does nothing until the owner enables again. Verification uses the stored key only.
//  2. What may be answered remotely is computed by the broker, from facts it kept when it held the request,
//     through the very scan a session grant uses (grants.ts `remoteWaivable`). Payments, purchases, sends,
//     sign-in, security and protected pages, key holds, navigation, extension operations and eval are never
//     remotely approvable, whatever a signature says. Unknown means no.
//  3. A decision is bound to one request (verb, id, kind and a digest of the text the owner reads), carries a nonce
//     and a timestamp, and is single use: its signature and its nonce are written to the durable journal BEFORE the
//     broker acts, so a replay fails, also after a restart.
//  4. HONEST LIMIT: the remote approver's key is a file readable by any process running as the same macOS user,
//     so this path is WEAKER than Touch ID. A process that can read that key can approve exactly what this module
//     allows, and nothing beyond it. That is why invariants 1-3 exist and why the scope is small. A process that can
//     WRITE the broker's own files can do more (write remote.json and restart the broker; or replace approver.pub,
//     which the Touch ID path trusts the same way): that is the account-level trust the whole broker already assumes.
import crypto from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import fs from 'node:fs';
import { hasErrorCode, isRecord, parseJSON } from '../shared/protocol.ts';
import { GateError, remoteDigest } from './approvals.ts';
import type { RemoteFacts, StoredApproval } from './approvals.ts';
import { isGrantSpec, remoteWaivable } from './grants.ts';
import type { Policy } from './policy.ts';
import type { createProofVerifier } from './proof.ts';

// The longest session grant that may be approved from another device, in minutes.
export const REMOTE_GRANT_MINUTES = 120;
// How far a decision's timestamp may be from now. The Secure Enclave proof allows 60 s; a phone adds latency.
const WINDOW_MS = 120000;
const NONCE = /^[A-Za-z0-9_-]{16,128}$/;
const KEY_FILE_MAX = 4096;

export const enableMessage = (fingerprint: string, ts: unknown) => `remote.enable|${fingerprint}|${ts}`;
// The text the remote approver signs. `digest` is remoteDigest(record): kind, id and the detail the owner reads.
export function decisionMessage(verb: string, a: { id?: unknown; kind?: unknown; detail?: unknown }, nonce: string, ts: number) {
  return `gaddi-remote|${verb}|${String(a.id)}|${String(a.kind)}|${remoteDigest(a)}|${nonce}|${ts}`;
}
const sha256 = (data: Buffer) => crypto.createHash('sha256').update(data).digest('hex');

// Only a PUBLIC key in SPKI PEM form is accepted. A private key left in the drop-in file is refused outright
// (createPublicKey would happily derive from it), and anything that is not Ed25519 is not a candidate.
function ed25519(pem: string): KeyObject | undefined {
  if (pem.length > KEY_FILE_MAX || !pem.trimStart().startsWith('-----BEGIN PUBLIC KEY-----')) return undefined;
  try {
    const key = crypto.createPublicKey(pem);
    return key.asymmetricKeyType === 'ed25519' ? key : undefined;
  } catch { return undefined; }
}
const fingerprintOf = (key: KeyObject) => sha256(key.export({ type: 'spki', format: 'der' }));

export function createRemote({ statePath, keyPath, proofs, emit = () => {}, log = () => {} }: {
  statePath: string; keyPath: string; proofs: Pick<ReturnType<typeof createProofVerifier>, 'verify' | 'spend'>;
  emit?: (event: string, data: unknown) => void; log?: (...args: unknown[]) => void;
}) {
  // The one key that may answer, with when the owner turned it on. Absent means off.
  let active: { key: KeyObject; fingerprint: string; enabledAt: string } | undefined;

  // Enablement survives a restart, like a remembered sign-in: it is the owner's standing choice. But only a file
  // that is exactly what enable() wrote is believed; a key that is not Ed25519, a fingerprint that does not match
  // its key, or a missing field means off.
  function load() {
    let text: string;
    try { text = fs.readFileSync(statePath, 'utf8'); }
    catch (error) {
      if (!hasErrorCode(error, 'ENOENT')) log('remote approval state could not be read: it stays off');
      return;
    }
    try {
      const saved = parseJSON(text);
      if (!isRecord(saved) || typeof saved.publicKey !== 'string' || typeof saved.fingerprint !== 'string'
        || typeof saved.enabledAt !== 'string' || !Number.isFinite(Date.parse(saved.enabledAt))) throw new Error('shape');
      const key = ed25519(saved.publicKey);
      if (!key || fingerprintOf(key) !== saved.fingerprint) throw new Error('key');
      active = { key, fingerprint: saved.fingerprint, enabledAt: saved.enabledAt };
      log(`remote approval is on (key ${saved.fingerprint.slice(0, 16)})`);
    } catch { log('remote approval state is invalid: it stays off'); }
  }
  load(); // the owner's saved choice, read back at startup

  // The key the bot dropped, read afresh on every call. It authorizes nothing by itself.
  function candidate(): { key: KeyObject; fingerprint: string } | undefined {
    try {
      const stat = fs.statSync(keyPath);
      if (!stat.isFile() || stat.size > KEY_FILE_MAX) return undefined;
      const key = ed25519(fs.readFileSync(keyPath, 'utf8'));
      return key ? { key, fingerprint: fingerprintOf(key) } : undefined;
    } catch { return undefined; }
  }

  function status() {
    const found = candidate();
    return { enabled: active !== undefined, ...(active ? { fingerprint: active.fingerprint, enabledAt: active.enabledAt } : {}),
      candidate: found ? { fingerprint: found.fingerprint } : null };
  }

  function save(state: { publicKey: string; fingerprint: string; enabledAt: string }) {
    const temporary = statePath + '.' + crypto.randomUUID() + '.tmp';
    try {
      const fd = fs.openSync(temporary, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(state, null, 2) + '\n'); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      fs.renameSync(temporary, statePath);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }

  // Invariant 1. The owner's signature names the fingerprint he was shown. The key stored is the one in the drop-in
  // file as it is NOW, and only if it has exactly that fingerprint: a file swapped after he looked is refused. A
  // refusal after the proof was checked has still spent that proof; he simply asks again.
  function enable(fingerprint: unknown, proof: unknown) {
    if (typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint)) {
      throw new GateError('approval-invalid', 'the fingerprint of the key to turn on is required');
    }
    proofs.verify(proof, enableMessage(fingerprint, isRecord(proof) ? proof.ts : undefined));
    const found = candidate();
    if (!found || found.fingerprint !== fingerprint) {
      throw new GateError('approval-invalid', 'the key file is missing, or is no longer the key you were shown: nothing was turned on');
    }
    const enabledAt = new Date().toISOString();
    // Written before it takes effect, so a failed write turns nothing on.
    save({ publicKey: String(found.key.export({ type: 'spki', format: 'pem' })), fingerprint, enabledAt });
    active = { key: found.key, fingerprint, enabledAt };
    emit('remote.changed', { enabled: true, fingerprint });
    return status();
  }

  // Ending it only removes authority, so it needs no proof and any client may ask: the app's button, the bot's own
  // "off", `gaddi remote off`. The authority is gone before anything is written, and the saved state is removed
  // so a restart does not bring it back.
  function disable() {
    const was = active !== undefined;
    active = undefined;
    let removed = true;
    try { fs.unlinkSync(statePath); }
    catch (error) {
      if (!hasErrorCode(error, 'ENOENT')) throw new Error('remote approval is off for now, but its saved state could not be removed: it would come back after a restart');
      removed = false;
    }
    if (was || removed) emit('remote.changed', { enabled: false });
    return status();
  }

  // Invariant 2. Judged afresh from live state every time it is asked (a list, an event, a decision): whether it is
  // on, the record's own status, and the facts the broker kept. A request never carries a verdict that is merely
  // trusted. Unknown means no.
  function eligible(a: StoredApproval, facts: RemoteFacts | undefined, policy: Policy): boolean {
    if (!active || a.status !== 'pending') return false;
    if (a.kind === 'grant') return isGrantSpec(a.grant) && a.grant.minutes <= REMOTE_GRANT_MINUTES;
    if (a.kind !== 'click' && a.kind !== 'press' && a.kind !== 'upload') return false;
    return facts !== undefined && facts.scope.kind === a.kind
      && remoteWaivable(policy, facts.pageURL, { outcome: 'hold', reason: facts.reason }, facts.scope);
  }

  // Invariant 3. Checks one decision and spends it. Returns the verb only when the signature is the stored key's,
  // over exactly this request, fresh, and neither the signature nor the nonce has ever been used.
  function verify(a: StoredApproval, params: { verb?: unknown; nonce?: unknown; ts?: unknown; sig?: unknown }): 'grant' | 'deny' {
    if (!active) throw new GateError('denied', 'approving from another device is turned off');
    const invalid = (reason: string): never => { throw new GateError('proof-invalid', reason); };
    const { verb, nonce, ts, sig } = params;
    if (verb !== 'grant' && verb !== 'deny') return invalid('verb must be grant or deny');
    if (typeof nonce !== 'string' || !NONCE.test(nonce)) return invalid('nonce must be 16 to 128 letters, digits, - or _');
    if (typeof ts !== 'number' || !Number.isSafeInteger(ts)) return invalid('ts must be a whole number of milliseconds');
    if (Math.abs(Date.now() - ts) > WINDOW_MS) return invalid('decision timestamp outside 120 seconds');
    if (typeof sig !== 'string' || sig.length > 100 || !/^[A-Za-z0-9+/]+={0,2}$/.test(sig)) return invalid('invalid decision signature');
    const signature = Buffer.from(sig, 'base64');
    if (signature.length !== 64) return invalid('invalid decision signature');
    let valid = false;
    try { valid = crypto.verify(null, Buffer.from(decisionMessage(verb, a, nonce, ts), 'utf8'), active.key, signature); }
    catch { return invalid('decision signature could not be checked'); }
    if (!valid) return invalid('decision signature verification failed');
    // Spent only after it verified, so unsigned noise never grows the journal; spent before anything is done.
    proofs.spend([sha256(signature), sha256(Buffer.from('remote|' + nonce, 'utf8'))]);
    return verb;
  }

  return { status, enabled: () => active !== undefined, enable, disable, eligible, verify };
}
