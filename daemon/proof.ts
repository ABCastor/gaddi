import fs from 'node:fs';
import { hasErrorCode, isRecord } from '../shared/protocol.ts';
import type { StoredApproval } from './approvals.ts';
import crypto from 'node:crypto';
import { GateError } from './approvals.ts';
import { signinSite } from './signin.ts';
import { sendRule } from './policy.ts';
import type { SendRule } from './policy.ts';

export function approvalMessage(verb: string, a: Pick<StoredApproval, "id" | "kind" | "tab" | "detail" | "url" | "reason" | "rememberable">, ts: unknown, remember = false) {
  const digest = crypto.createHash('sha256').update(a.detail as string, 'utf8').digest('hex');
  const message = `${verb}|${a.id}|${a.kind}|${a.tab ?? ''}|${digest}|${ts}`;
  if (!remember) return message;
  if (verb !== 'grant') throw new GateError('approval-invalid', 'only a sign-in grant or eligible send grant can remember a site');
  if (a.kind === 'signin') return `${message}|remember|${signinSite(a.url)}`;
  const send = a.rememberable === true ? sendRule(a.url, a.kind, a.reason) : undefined;
  if (!send) throw new GateError('approval-invalid', 'only a sign-in grant or eligible send grant can remember a site');
  return `${message}|remember|${send.site}|${send.reason}`;
}

export function signinRevokeMessage(site: string, ts: unknown) { return `signin.revoke|${site}|${ts}`; }

export function sendRevokeMessage(rule: SendRule, ts: unknown) {
  if (!sendRule(rule.site, rule.kind, rule.reason)) throw new GateError('approval-invalid', 'exact send scope required');
  return `sends.revoke|${rule.site}|${rule.kind}|${rule.reason}|${ts}`;
}

export function createProofVerifier({ publicKeyPath, usedPath }: { publicKeyPath: string; usedPath: string }) {
  const used = new Set<string>();
  try {
    for (const line of fs.readFileSync(usedPath, 'utf8').split('\n').filter(Boolean)) {
      if (!/^[a-f0-9]{64}$/.test(line)) throw new Error('invalid proof journal');
      used.add(line);
    }
  } catch (e) { if (!hasErrorCode(e, 'ENOENT')) throw e; }

  // Invariant: only a fresh P-256 signature for the exact operation grants authority.
  // Record its decoded signature durably BEFORE acting, so replay (even after restart or
  // with alternative base64 spelling or the equivalent ECDSA (r, n-s) signature) cannot
  // grant authority twice. The authenticated operation+timestamp is also single-use. Journal errors fail closed.
  function verify(proof: unknown, message: string) {
    const invalid = (reason: string): never => { throw new GateError('proof-invalid', reason); };
    if (!isRecord(proof) || typeof proof.ts !== 'number' || !Number.isSafeInteger(proof.ts) || typeof proof.sig !== 'string') return invalid('signed proof {ts, sig} required');
    if (Math.abs(Date.now() - proof.ts) > 60000) invalid('proof timestamp outside 60 seconds');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(proof.sig) || proof.sig.length > 128) invalid('invalid proof signature');
    const signature = Buffer.from(proof.sig, 'base64');
    const fingerprint = crypto.createHash('sha256').update(signature).digest('hex');
    const operation = crypto.createHash('sha256').update('message|' + message, 'utf8').digest('hex');
    if (used.has(fingerprint) || used.has(operation)) invalid('proof signature or operation already used');
    let valid = false;
    try {
      const key = crypto.createPublicKey(fs.readFileSync(publicKeyPath));
      valid = key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1'
        && crypto.verify('sha256', Buffer.from(message, 'utf8'), { key, dsaEncoding: 'der' }, signature);
    } catch { invalid('approver key or signature unavailable or invalid'); }
    if (!valid) invalid('proof signature verification failed');
    const fd = fs.openSync(usedPath, 'a', 0o600);
    try { fs.writeFileSync(fd, fingerprint + '\n' + operation + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    used.add(fingerprint); used.add(operation);
  }
  return { verify };
}
