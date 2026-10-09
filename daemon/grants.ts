// daemon/grants.ts — session grants: the owner lets ONE chat skip a few holds, for a while.
//
// Invariants (each is falsified by a mutation in tests/gates/session-grant-mutations.test.sh):
//  1. Only three permissions exist: upload, post and delete. A hold whose reason is not in the tables
//     below stays held. Money, sends, sign-in, security, protected addresses, keys, navigation,
//     extension operations and any verb an overlay adds are not listed, so they can never be waived.
//     Unknown means held.
//  2. A grant is created only by the broker, after a signed owner decision, from the exact request
//     the owner saw. Nothing an agent or a page says can create one.
//  3. A grant belongs to one chat (its session key). A CLI call or another chat never uses it.
//  4. Grants live in memory only. A restart ends them all: authority is never read back from disk.
//  5. Remote approval (remote.ts) asks the owner's other device the same question a grant answers, through
//     the same scan (`waive` below), so it can never waive more than a grant could. It only ever adds a
//     decision on one request the owner could have approved himself; it creates no standing authority
//     except through the owner's own grant request, which it may approve for at most two hours.
import crypto from 'node:crypto';
import { isRecord } from '../shared/protocol.ts';
import { UPLOAD_HOLD, fold, hostOf, phraseIn, protections, rx } from './policy.ts';
import type { Policy, PolicyCheck } from './policy.ts';

export type GrantPermission = 'upload' | 'post' | 'delete';
export interface GrantRule { permission: GrantPermission; origin: string; path: string }
export interface GrantSpec { session: string; rules: GrantRule[]; minutes: number; label?: string }
// `approver` is set only when the owner answered from another device (remote.ts); a Touch ID grant has none.
export interface Grant extends GrantSpec { id: string; caller: string; createdAt: number; expiresAt: number; approver?: 'remote' }
export type GrantCheck = PolicyCheck & { grant?: string };
export interface GrantScope { kind: 'click' | 'press' | 'upload'; name?: string; destination?: string }
export type GrantEnd = 'expired' | 'session-ended' | 'revoked';

export const GRANT_MINUTES = { min: 5, max: 720 };
export const GRANT_RULES_MAX = 20, GRANT_RULE_CHARS = 300, GRANT_URL_CHARS = 200, GRANT_LABEL_CHARS = 60;

const PERMISSIONS: readonly string[] = ['upload', 'post', 'delete'];
export const isPermission = (value: unknown): value is GrantPermission => typeof value === 'string' && PERMISSIONS.includes(value);
// Invariant 1: these two lists are the whole of what a grant can waive, in folded spelling.
const POST_VERBS = ['post', 'publish', 'pubblica', 'share', 'condividi'];
const DELETE_VERBS = ['delete', 'delete forever', 'delete permanently', 'remove', 'elimina', 'elimina definitivamente', 'cancella', 'rimuovi'];
function verbPermission(verb: string): GrantPermission | undefined {
  const folded = fold(verb);
  return POST_VERBS.includes(folded) ? 'post' : DELETE_VERBS.includes(folded) ? 'delete' : undefined;
}

// What a hold's reason lets a grant waive. Anything not named here (url-pattern:, key:, money and
// send verbs, sign-in, extension operations, an overlay's own verbs) maps to nothing and stays held.
export function permissionFor(kind: GrantScope['kind'], reason: string | undefined): GrantPermission | undefined {
  if (reason === undefined) return undefined;
  if (kind === 'upload') return reason === UPLOAD_HOLD ? 'upload' : undefined;
  const prefix = kind === 'click' ? 'verb:' : 'enter-submits:';
  return reason.startsWith(prefix) ? verbPermission(reason.slice(prefix.length)) : undefined;
}

// ---------------------------------------------------------------- request validation
const NEVER = 'only upload, post and delete can be granted for a chat. Payments, purchases, sends, sign-in and security changes can never be granted: they stay held every time';
export const ruleString = (rule: GrantRule) => `${rule.permission} ${rule.origin}${rule.path}`;

function parseRule(input: unknown, policy: Policy): GrantRule {
  if (typeof input !== 'string' || input.length > GRANT_RULE_CHARS) throw new Error(`each rule must be text of at most ${GRANT_RULE_CHARS} characters`);
  const words = input.trim().split(/\s+/);
  const permission = words[0].toLowerCase();
  if (!isPermission(permission)) throw new Error(`"${permission.slice(0, 20)}" cannot be granted: ${NEVER}`);
  if (words.length !== 2) throw new Error('each rule must look like "<upload|post|delete> <https address prefix>"');
  const text = words[1];
  const bad = (why: string): never => { throw new Error(`rule address ${why}`); };
  if (text.length > GRANT_URL_CHARS) bad(`is longer than ${GRANT_URL_CHARS} characters`);
  if (/[\\?#]|%(?:2e|2f|5c)/i.test(text) || /[\u0000-\u001f\u007f-\u009f]/.test(text)) bad('must be a plain address prefix: no query, fragment, backslash, or encoded dot or slash');
  let url: URL;
  try { url = new URL(text); } catch { return bad('must be a full address starting with https://'); }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) bad('must use https (http is accepted only on localhost)');
  if (url.username || url.password) bad('must not contain a username or password');
  // The raw spelling is checked, not the parser's output, because the parser quietly resolves dots.
  const raw = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/]*(\/.*)?$/.exec(text)?.[1] ?? '/';
  const segments = raw.split('/').slice(1);
  segments.forEach((segment, index) => {
    if (segment === '.' || segment === '..') bad('must not contain . or .. segments');
    if (segment === '' && index < segments.length - 1) bad('must not contain empty path segments (//)');
  });
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : '/';
  const canonical = url.origin + path;
  if (canonical.length > GRANT_URL_CHARS) bad(`is longer than ${GRANT_URL_CHARS} characters`);
  // A site Gaddi refuses outright, or an address on the protected list, is never worth a grant.
  const { hosts, patterns } = protections(policy);
  if (hosts.some(host => rx(host)?.test(hostOf(canonical)))) bad('is on a protected site: it can never be granted');
  if (patterns.some(pattern => rx(pattern)?.test(canonical))) bad('is a protected address (payments, security, account closure): it can never be granted');
  return { permission, origin: url.origin, path };
}

export function parseGrantRules(input: unknown, policy: Policy): GrantRule[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > GRANT_RULES_MAX) throw new Error(`rules must list 1 to ${GRANT_RULES_MAX} rules`);
  const unique = new Map<string, GrantRule>();
  for (const entry of input as unknown[]) {
    const rule = parseRule(entry, policy);
    unique.set(ruleString(rule), rule);
  }
  // One order for the same set, so an identical request hashes identically.
  return [...unique].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, rule]) => rule);
}

// The label is an agent's own words, shown to the owner as such. No control, format or line characters.
const UNSAFE_LABEL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
export function parseGrantRequest(params: { rules?: unknown; minutes?: unknown; label?: unknown }, policy: Policy) {
  const rules = parseGrantRules(params.rules, policy);
  const { minutes, label } = params;
  if (typeof minutes !== 'number' || !Number.isSafeInteger(minutes) || minutes < GRANT_MINUTES.min || minutes > GRANT_MINUTES.max) {
    throw new Error(`minutes must be a whole number from ${GRANT_MINUTES.min} to ${GRANT_MINUTES.max}`);
  }
  if (label !== undefined && (typeof label !== 'string' || label.length > GRANT_LABEL_CHARS || UNSAFE_LABEL.test(label))) {
    throw new Error(`label must be plain text of at most ${GRANT_LABEL_CHARS} characters`);
  }
  const text = typeof label === 'string' ? label.trim() : '';
  return { rules, minutes, label: text || undefined };
}

export function isGrantSpec(value: unknown): value is GrantSpec {
  return isRecord(value) && typeof value.session === 'string' && typeof value.minutes === 'number'
    && Array.isArray(value.rules) && value.rules.every(rule => isRecord(rule) && isPermission(rule.permission)
      && typeof rule.origin === 'string' && typeof rule.path === 'string')
    && (value.label === undefined || typeof value.label === 'string');
}

// ---------------------------------------------------------------- the text the owner signs
export function ruleLine(rule: GrantRule) {
  const url = new URL(rule.origin);
  return `${rule.permission} on ${url.protocol === 'http:' ? 'http://' : ''}${url.host}${rule.path === '/' ? '' : rule.path}`;
}
export function durationText(minutes: number) {
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  return `${hours} ${hours === 1 ? 'hour' : 'hours'}${rest ? ` ${rest} minutes` : ''}`;
}
// Invariant 2: the owner's signature covers a digest of exactly this text (proof.ts binds `detail`),
// and a pending record never changes. So what he reads is what he approves.
export function grantDetail(rules: readonly GrantRule[], minutes: number, label?: string) {
  return [...rules.map(ruleLine), `for ${durationText(minutes)}`, ...(label ? [`“${label}”`] : [])].join('\n');
}

// ---------------------------------------------------------------- use
function parseURL(text: string): URL | undefined {
  try { return new URL(text); } catch { return undefined; }
}
// A rule covers its own address and anything below it, on a path-segment boundary: /settings covers
// /settings and /settings/profile, never /settingsX. The origin must match exactly.
function covers(rule: GrantRule, url: URL) {
  return url.origin === rule.origin && (rule.path === '/' || url.pathname === rule.path || url.pathname.startsWith(rule.path + '/'));
}
function protectedAddress(policy: Policy, url: URL) {
  const { hosts, patterns } = protections(policy);
  return patterns.some(pattern => rx(pattern)?.test(url.href)) || hosts.some(host => rx(host)?.test(hostOf(url.href)));
}

// Which rule set, if any, covers `needed` at `target`. A session grant answers from its own rules; remote
// approval (below) answers "yes, anywhere" because the owner decides that one request by hand.
type Cover = (needed: GrantPermission, target: URL) => { id: string } | undefined;

// Turns a hold into an allow only when every one of these holds; otherwise the hold is returned untouched.
// A deny is never changed, and with policy off nothing is held, so nothing here can add authority.
//  - the hold maps to a permission in the tables above (invariant 1);
//  - the cover has a rule of that permission covering the page (invariant 3 is the caller's job: a session
//    grant passes only the calling chat's own grants, none for a CLI call);
//  - the page is not a protected address;
//  - every hold verb in the full accessible name maps to a permission covered on this page, so
//    "Post and pay" stays held even though "post" alone would be waived;
//  - a link's destination is on the same site, covered for the same permission, and not protected.
// Session grants and remote approval share this one scan; neither has a copy of it to drift.
function waive(coveredBy: Cover, policy: Policy, pageURL: string, check: PolicyCheck, scope: GrantScope): GrantCheck {
  const permission = permissionFor(scope.kind, check.reason);
  const page = parseURL(pageURL);
  if (!permission || !page || protectedAddress(policy, page)) return check;
  const grant = coveredBy(permission, page);
  if (!grant) return check;
  if (scope.kind !== 'upload') {
    for (const verb of protections(policy).verbs) {
      if (!phraseIn(scope.name, verb)) continue;
      const needed = verbPermission(verb);
      if (!needed || !coveredBy(needed, page)) return check;
    }
  }
  if (scope.destination) {
    const target = parseURL(scope.destination);
    if (!target || target.origin !== page.origin || protectedAddress(policy, target) || !coveredBy(permission, target)) return check;
  }
  return { outcome: 'allow', reason: 'session grant', grant: grant.id };
}

export function checkGrant(grants: readonly Grant[], policy: Policy, pageURL: string, check: PolicyCheck, scope: GrantScope): GrantCheck {
  if (check.outcome !== 'hold' || grants.length === 0) return check;
  return waive((needed, target) =>
    grants.find(grant => grant.rules.some(rule => rule.permission === needed && covers(rule, target))), policy, pageURL, check, scope);
}

// The addresses a grant rule can name: https, or http on this Mac, with no credentials in the address (parseRule
// refuses everything else). A page a rule could never name is never covered by any grant, so it is never answerable
// from another device either. tests/policy/grants.ts holds the two lists to the same table.
function grantableAddress(url: URL) {
  return (url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)) && !url.username && !url.password;
}

// Whether this hold is one a session grant covering the whole site could waive. Remote approval (remote.ts)
// uses it to decide which requests may be answered from another device: the same permissions, the same
// protected addresses, the same mixed-name and destination rules, the same addresses, and nothing else.
const EVERYTHING = { id: 'remote' };
export function remoteWaivable(policy: Policy, pageURL: string, check: PolicyCheck, scope: GrantScope): boolean {
  if (check.outcome !== 'hold') return false;
  return waive((_needed, target) => grantableAddress(target) ? EVERYTHING : undefined, policy, pageURL, check, scope).outcome === 'allow';
}

// ---------------------------------------------------------------- the store
// Invariant 4: this map is the only place a grant exists. Nothing is written to disk or read back.
export function createGrants({ minuteMs = 60000, now = Date.now, emit = () => {}, audit = () => {}, log = () => {} }: {
  minuteMs?: number; now?: () => number; emit?: (event: string, data: unknown) => void; audit?: (entry: Record<string, unknown>) => void;
  log?: (...args: unknown[]) => void;
} = {}) {
  const entries = new Map<string, { grant: Grant; timer: NodeJS.Timeout }>();
  const iso = (ms: number) => new Date(ms).toISOString();
  // The public shape never carries the session key: it is what ties a grant to its chat.
  const view = (grant: Grant, mine?: string) => ({ id: grant.id, caller: grant.caller, label: grant.label ?? null,
    rules: grant.rules.map(ruleString), createdAt: iso(grant.createdAt), expiresAt: iso(grant.expiresAt),
    ...(grant.approver ? { approver: grant.approver } : {}),
    mine: mine !== undefined && grant.session === mine });
  const snapshot = (mine?: string) => [...entries.values()].map(entry => view(entry.grant, mine));
  function end(id: string, reason: GrantEnd) {
    const entry = entries.get(id);
    if (!entry) return false;
    // The authority is gone before anything is written: a failing audit must never keep a grant alive
    // or take the broker down from a timer.
    entries.delete(id); clearTimeout(entry.timer);
    try { audit({ ts: iso(now()), caller: entry.grant.caller, method: 'grant.end', tab: null, url: '', grant: id, reason, outcome: 'allow', ms: 0 }); }
    catch { log('session grant end could not be audited'); }
    emit('grants.changed', { grants: snapshot() });
    return true;
  }
  // Expiry is checked whenever a grant is looked at, not only by the timer, so a late timer never extends one.
  function expireDue() {
    for (const [id, entry] of [...entries]) if (entry.grant.expiresAt <= now()) end(id, 'expired');
  }
  function activate(spec: GrantSpec & { caller: string; approver?: 'remote' }): Grant {
    const created = now();
    const grant: Grant = { id: crypto.randomBytes(8).toString('hex'), session: spec.session, caller: spec.caller,
      ...(spec.label ? { label: spec.label } : {}), rules: spec.rules, minutes: spec.minutes, createdAt: created,
      ...(spec.approver ? { approver: spec.approver } : {}),
      expiresAt: created + spec.minutes * minuteMs };
    // Fail closed: a grant whose start cannot be written to the audit does not come into being.
    audit({ ts: iso(created), caller: grant.caller, method: 'grant.start', tab: null, url: '', grant: grant.id,
      ...(grant.approver ? { approver: grant.approver } : {}),
      rules: grant.rules.map(ruleString), expiresAt: iso(grant.expiresAt), outcome: 'allow', ms: 0 });
    const timer = setTimeout(() => end(grant.id, 'expired'), Math.max(0, grant.expiresAt - created));
    timer.unref();
    entries.set(grant.id, { grant, timer });
    emit('grants.changed', { grants: snapshot() });
    return grant;
  }
  // The calling chat's own unexpired grants. No session key (a CLI call) has none.
  function active(session: string | undefined): Grant[] {
    expireDue();
    return session === undefined ? [] : [...entries.values()].map(entry => entry.grant).filter(grant => grant.session === session);
  }
  function list(mine?: string) {
    expireDue();
    return snapshot(mine);
  }
  function revoke(id: string) { return end(id, 'revoked'); }
  function endSession(session: string) {
    let ended = 0;
    for (const [id, entry] of [...entries]) if (entry.grant.session === session && end(id, 'session-ended')) ended++;
    return ended;
  }
  function stop() { for (const entry of entries.values()) clearTimeout(entry.timer); }
  return { activate, active, list, revoke, endSession, stop };
}
