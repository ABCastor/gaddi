import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ImageBox } from '../shared/protocol.ts';
import { isRecord } from '../shared/protocol.ts';
import type { createProofVerifier, approvalMessage } from './proof.ts';
import { signinSite } from './signin.ts';
import { sendRule } from './policy.ts';
import type { SendRule } from './policy.ts';
import type { GrantScope, GrantSpec } from './grants.ts';

export interface ApprovalRecord { id: string; kind: string; tab: number | null; caller: string; url: string; detail: string; reason: string; actionHash: string; status: string; createdAt: string; expiresAt: string; resolvedAt?: string; by?: string; decidedAt?: string; usedAt?: string; imagePath?: string; box?: ImageBox; targetSelector?: string; rememberable?: boolean; grant?: GrantSpec }
// What the broker saw when it held an action, for remote approval (remote.ts) to judge again every time it is
// asked. Invariant: this is kept in memory only, beside the record and never in it, so it is not written to
// state.json and cannot reach publicView. It holds the full page address because a query can make a page
// protected, and the raw hold reason, accessible name and link destination the grant scan reads.
export interface RemoteFacts { pageURL: string; reason?: string; scope: GrantScope }
export type Emit = (event: string, data: unknown) => void;
export type ApprovalAction = { method: string; caller: string; url: string; [key: string]: unknown };
// Persisted JSON is retained verbatim. Only its action binding was historically required.
export type StoredApproval = { [K in keyof ApprovalRecord]?: unknown } & Record<string, unknown>;
export type StoredApprovalRef = { id: unknown; reason: unknown; expires: unknown };

export class GateError extends Error {
  code: string;
  approval?: StoredApprovalRef;
  constructor(code: string, message: string, approval?: StoredApprovalRef) {
    super(message);
    this.code = code;
    if (approval) this.approval = approval;
  }
}

// Persist only redacted display text and a digest of the exact action, never URL queries.
export function cleanURL(value: unknown) {
  try {
    const url = new URL(String(value));
    url.search = ''; url.hash = ''; url.username = ''; url.password = '';
    return url.href;
  } catch { return ''; }
}
export function cleanDetail(value: unknown) {
  return String(value ?? '').replace(/(?:https?|file):\/\/[^\s"'<>]+/gi, cleanURL)
    .replace(/\?[^\s<>]*/g, '');
}
// Invariant: a session grant request names its chat by session key. That key is the only thing
// that ties the grant to one chat, so it never leaves the broker: not in lists, events or state.
// The owner sees and signs the request's `detail` text, which carries everything he decides on.
export function publicView({ actionHash, targetSelector, grant, ...record }: StoredApproval) {
  const site = record.kind === 'signin' ? signinSite(record.url)
    : record.rememberable === true ? sendRule(record.url, record.kind, record.reason)?.site : undefined;
  return site ? { ...record, site } : record;
}
export function approvalRef(a: StoredApproval) { return { id: a.id, reason: a.reason, expires: a.expiresAt }; }
// What a remote approver signs for one request: kind, id and the detail text the owner reads, so a decision
// cannot be moved to another request or to a request whose text changed.
export function remoteDigest(a: { kind?: unknown; id?: unknown; detail?: unknown }) {
  return crypto.createHash('sha256').update(`${String(a.kind)}|${String(a.id)}|${String(a.detail)}`, 'utf8').digest('hex');
}
function actionHash(action: ApprovalAction) { return crypto.createHash('sha256').update(JSON.stringify(action)).digest('hex'); }

export function createApprovals({ ttlMinutes = 10, onChange = () => {}, emit = () => {}, imageRoot, log = () => {}, remote = () => false }:
  { ttlMinutes?: number; onChange?: () => void; emit?: Emit; imageRoot?: string; log?: (...args: unknown[]) => void;
    // Whether the owner's other device may answer this record right now (remote.ts decides, from live state).
    remote?: (a: StoredApproval, facts: RemoteFacts | undefined) => boolean }) {
  const entries = new Map<unknown, StoredApproval>();
  // Invariant: remote approval's facts live here and nowhere else (see RemoteFacts). A record restored after a
  // restart has none, so it can only be answered with Touch ID until the agent's retry attaches them again.
  const facts = new WeakMap<StoredApproval, RemoteFacts>();
  // Every record that leaves this module goes through here: what publicView shows, plus, while the owner's other
  // device may answer it, `remote: true` and the digest that device signs. Computed on every call from the live
  // state, never remembered, so turning the feature off removes the flag from the next list and event.
  const view = (a: StoredApproval) => remote(a, facts.get(a)) ? { ...publicView(a), remote: true, digest: remoteDigest(a) } : publicView(a);
  // Derive file names ourselves; a persisted path never authorizes deletion elsewhere.
  const imageFile = (id: unknown) => imageRoot && typeof id === 'string' && /^[a-f0-9]{16}$/.test(id)
    ? path.join(imageRoot, id + '.jpg') : undefined;
  function removePicture(a: StoredApproval) {
    const file = imageFile(a.id);
    if (file) {
      try { fs.rmSync(file, { force: true }); }
      catch { log('approval capture cleanup failed'); }
    }
    delete a.imagePath; delete a.box;
  }
  function savePicture(a: StoredApproval, picture: unknown) {
    if (picture === undefined || !imageRoot) return;
    try {
      if (!isRecord(picture) || picture.mimeType !== 'image/jpeg' || typeof picture.data !== 'string'
        || picture.data.length > 1400000 || !isRecord(picture.box)) throw new Error('invalid capture');
      const { width, height, box } = picture;
      if (typeof width !== 'number' || typeof height !== 'number' || !Number.isInteger(width) || !Number.isInteger(height)
        || width < 1 || height < 1 || width > 1200 || height > 720
        || !['x', 'y', 'width', 'height'].every(key => typeof box[key] === 'number' && Number.isFinite(box[key]))) throw new Error('invalid capture');
      const b = box as unknown as ImageBox;
      if (b.x < 0 || b.y < 0 || b.width <= 0 || b.height <= 0 || b.x + b.width > width + 0.01 || b.y + b.height > height + 0.01) throw new Error('invalid box');
      const bytes = Buffer.from(picture.data, 'base64');
      if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) throw new Error('invalid JPEG');
      fs.mkdirSync(imageRoot, { recursive: true, mode: 0o700 });
      fs.chmodSync(imageRoot, 0o700);
      const file = imageFile(a.id)!;
      fs.writeFileSync(file, bytes, { mode: 0o600, flag: 'wx' });
      a.imagePath = file; a.box = { x: b.x, y: b.y, width: b.width, height: b.height };
    } catch {
      removePicture(a);
      log('approval capture unavailable: invalid image or storage failure');
    }
  }
  function pruneImages() {
    if (!imageRoot || !fs.existsSync(imageRoot)) return;
    expire();
    const keep = new Set([...entries.values()].filter(a => (a.status === 'pending' || a.status === 'granted')
      && a.imagePath === imageFile(a.id) && isRecord(a.box)).map(a => path.basename(String(a.imagePath))));
    for (const name of fs.readdirSync(imageRoot)) if (name.endsWith('.jpg') && !keep.has(name)) {
      try { fs.rmSync(path.join(imageRoot, name), { force: true }); }
      catch { log('approval capture orphan cleanup failed'); }
    }
    for (const a of entries.values()) if (a.imagePath && !keep.has(path.basename(String(a.imagePath)))) {
      delete a.imagePath; delete a.box;
    }
  }
  // Invariant: a session grant request is never written to disk. It names a chat by its session key,
  // and that chat does not survive a restart, so a restored request could never be honoured.
  function persistable() { return [...entries.values()].filter(a => a.kind !== 'grant'); }
  function restore(list: unknown) {
    // Invariant: approval records without an action binding cannot authorize a tab action.
    if (list && !Array.isArray(list) && typeof list !== 'string') throw new TypeError('(list || []) is not iterable');
    for (const a of Array.isArray(list) || typeof list === 'string' ? list : []) if (isRecord(a) && a.id && /^[a-f0-9]{64}$/.test(String(a.actionHash)) && a.kind !== 'grant') {
      // A restored sign-in must have a valid origin before snapshots or expiry can expose it.
      if (a.kind === 'signin') {
        try { signinSite(a.url); } catch { continue; }
      }
      // Invariant: persisted status alone never restores grant authority. A daemon restart
      // requires a fresh signed app decision; the durable proof journal still rejects replay.
      if (a.status === 'granted') { a.status = 'pending'; delete a.resolvedAt; delete a.by; delete a.decidedAt; }
      entries.set(a.id, a);
    }
  }
  function resolve(a: StoredApproval, status: string, extra: Partial<ApprovalRecord> = {}) {
    if (status !== 'granted') removePicture(a);
    Object.assign(a, extra, { status, resolvedAt: new Date().toISOString() });
    onChange();
    emit('approval.resolved', { approval: view(a), tab: a.tab });
  }
  function expire() {
    for (const a of entries.values()) {
      if ((a.status === 'pending' || a.status === 'granted') && Date.now() >= Date.parse(String(a.expiresAt))) resolve(a, 'expired');
    }
  }
  const timer = setInterval(expire, 1000);
  timer.unref();
  function pendingFor(action: ApprovalAction, targetSelector?: string) {
    expire();
    return [...entries.values()].find(a => a.status === 'pending' && a.actionHash === actionHash(action) && a.targetSelector === targetSelector);
  }
  function hold({ kind, tab = null, caller, url, detail, reason, action, picture, targetSelector, rememberable = false, grant, remoteFacts }: { kind: string; tab?: unknown; caller: string; url: unknown; detail: string; reason?: string; action: ApprovalAction; picture?: unknown; targetSelector?: string; rememberable?: boolean; grant?: GrantSpec; remoteFacts?: RemoteFacts }) {
    expire();
    const hash = actionHash(action);
    const existing = pendingFor(action, targetSelector);
    if (existing) return existing;
    const now = Date.now();
    const a = { id: crypto.randomBytes(8).toString('hex'), kind, tab, caller, url: cleanURL(url),
      ...(rememberable ? { rememberable: true } : {}), ...(targetSelector ? { targetSelector } : {}), ...(grant ? { grant } : {}),
      // A session grant's text is built by the broker from validated parts (no queries; its label is cleaned
      // first) and is exactly what the owner signs, so it is stored as built and never rewritten.
      detail: kind === 'grant' ? detail : cleanDetail(detail), reason: cleanDetail(reason), actionHash: hash, status: 'pending',
      createdAt: new Date(now).toISOString(), expiresAt: new Date(now + ttlMinutes * 60000).toISOString() };
    savePicture(a, picture);
    entries.set(a.id, a);
    // Attached before the event goes out, so the first announcement already says whether it can be answered remotely.
    if (remoteFacts) facts.set(a, remoteFacts);
    const recent = [...entries.values()].filter(x => !(x.status === 'pending' || x.status === 'granted'));
    for (const old of recent.slice(0, Math.max(0, recent.length - 40))) entries.delete(old.id);
    onChange();
    emit('approval.pending', { approval: view(a), tab });
    return a;
  }
  // The agent asked again for a request that is still waiting: the verdict is a function of the action the
  // hash binds, so the facts are simply refreshed. This is also how a record restored after a restart gets them
  // back; if that makes it answerable from the owner's other device, it is announced again, so a listener that
  // only watches events learns of it.
  function attach(a: StoredApproval, remoteFacts: RemoteFacts | undefined) {
    const before = remote(a, facts.get(a));
    if (remoteFacts) facts.set(a, remoteFacts);
    else facts.delete(a);
    if (!before && remote(a, facts.get(a))) emit('approval.pending', { approval: view(a), tab: a.tab });
  }
  function get(id: unknown) {
    expire();
    const a = entries.get(String(id));
    if (!a) throw new GateError('approval-unknown', `approval ${id}: unknown`);
    return a;
  }
  // Invariant: authority is signed, single use, and bound to the caller, resolved tab,
  // current page, and full action (queries included only in its hash). Files grant nothing.
  function consume(id: unknown, action: ApprovalAction, targetSelector?: string) {
    const a = get(id);
    if (a.actionHash !== actionHash(action)) throw new GateError('approval-mismatch', `approval ${id} is for a different action`);
    if (a.targetSelector !== undefined && a.targetSelector !== targetSelector) throw new GateError('approval-mismatch', `approval ${id} is for a different element`);
    if (a.status === 'pending') throw new GateError('held', `approval ${id} still pending`, approvalRef(a));
    if (a.status === 'denied') throw new GateError('denied', `approval ${id} was denied`);
    if (a.status !== 'granted') throw new GateError(`approval-${a.status}`, `approval ${id} is ${a.status}`);
    resolve(a, 'used', { usedAt: new Date().toISOString() });
    return view(a);
  }
  function signed(id: unknown, verb: 'grant' | 'deny', proof: unknown, verifier: ReturnType<typeof createProofVerifier>, message: typeof approvalMessage,
    { remember = false, onRemember }: { remember?: unknown; onRemember?: (site: string, send?: SendRule) => void } = {}) {
    const a = get(id);
    if (a.status !== 'pending') throw new GateError('approval-invalid', `approval ${id} is not pending`);
    const send = a.rememberable === true ? sendRule(a.url, a.kind, a.reason) : undefined;
    if (typeof remember !== 'boolean' || remember && (verb !== 'grant' || a.kind !== 'signin' && !send)) {
      throw new GateError('approval-invalid', 'remember requires a boolean on a sign-in grant or eligible send grant');
    }
    verifier.verify(proof, message(verb, a, isRecord(proof) ? proof.ts : undefined, remember));
    // Durable policy must be saved before a remember decision can resolve the hold.
    if (remember) {
      if (!onRemember) throw new GateError('approval-invalid', 'remember storage unavailable');
      onRemember(send?.site ?? signinSite(a.url), send);
    }
    resolve(a, verb === 'grant' ? 'granted' : 'denied', { by: 'signed-proof' });
    return view(a);
  }
  // The owner's other device answered. Its signature was checked and spent by remote.ts before this runs.
  // Invariant: only a pending record is resolved, and `by` says who decided, so the record, the events and the
  // owner's panel can always tell a Touch ID answer from a remote one.
  function resolveRemote(id: unknown, verb: 'grant' | 'deny') {
    const a = get(id);
    if (a.status === 'pending') resolve(a, verb === 'grant' ? 'granted' : 'denied', { by: 'remote', decidedAt: new Date().toISOString() });
    else throw new GateError('approval-invalid', `approval ${id} is not pending`);
    return view(a);
  }
  function cancel(id: unknown) {
    const a = get(id);
    if (!(a.status === 'pending' || a.status === 'granted')) throw new GateError('approval-invalid', `approval ${id} is ${a.status}`);
    resolve(a, 'cancelled');
    return view(a);
  }
  // A session grant has no agent retry: the broker acts on the signed decision itself, then closes
  // the record here, so a decision can never be acted on twice.
  function complete(id: unknown) {
    // No expiry sweep here: this closes the very record a signature resolved a moment ago, and a
    // sweep landing in between must not turn a granted decision into an error after it was acted on.
    const a = entries.get(String(id));
    if (!a || a.status !== 'granted') throw new GateError('approval-invalid', `approval ${id} is ${a ? String(a.status) : 'unknown'}`);
    resolve(a, 'used', { usedAt: new Date().toISOString() });
    return view(a);
  }
  // Whether the owner's other device may answer this record right now. The very call that decides the `remote`
  // flag in every list and event, so what the device is shown and what the broker accepts cannot disagree.
  function remotable(a: StoredApproval) { return remote(a, facts.get(a)); }
  function pendingMatching(test: (a: StoredApproval) => boolean) {
    expire();
    return [...entries.values()].filter(a => a.status === 'pending' && test(a));
  }
  function list() {
    expire();
    const all = [...entries.values()];
    return { pending: all.filter(a => (a.status === 'pending' || a.status === 'granted')).map(view),
      recent: all.filter(a => !(a.status === 'pending' || a.status === 'granted')).reverse().slice(0, 20).map(view) };
  }
  return { pendingFor, pendingMatching, pruneImages, hold, attach, remotable, consume, signed, resolveRemote, cancel, complete, get, list, restore, persistable, stop: () => clearInterval(timer) };
}
