// daemon/policy.ts — loads the gate policy and exposes pure check functions.
// Every check returns { outcome: 'allow' | 'hold' | 'deny', reason }.
// GADDI_POLICY_OFF=1 (test-only) makes every check return allow; the daemon logs a loud warning.

import fs from 'node:fs';
import crypto from 'node:crypto';
import { isRecord, parseJSON, errorMessage } from '../shared/protocol.ts';

export interface PolicyData {
 version: number; comment?: string;
 hold: { verbs: string[]; url_patterns: string[]; keys: { url: string; keys: string[] }[]; uploads?: boolean; extensions?: { disable?: boolean; uninstall?: boolean } };
 deny: { comment?: string; verbs_on_hosts: { host: string; verbs: string[] }[]; type_into: string[]; eval_patterns: string[] };
 approvals: { ttl_minutes: number };
 signin?: { remember: string[] };
 sends?: { remember: SendRule[] };
}
export interface Policy extends PolicyData { off: boolean; sources: string[] }
export interface SendRule { site: string; kind: 'click' | 'press'; reason: string }
export interface PolicyCheck { rememberable?: boolean; outcome: 'allow' | 'hold' | 'deny'; reason?: string }
type Schema = ((value: unknown) => boolean) | Schema[] | { [key: string]: Schema };

import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_POLICY = path.join(HERE, '..', 'policy', 'policy.default.json');

const ALLOW = (reason = 'ok'): PolicyCheck => ({ outcome: 'allow', reason });
const HOLD = (reason: string): PolicyCheck => ({ outcome: 'hold', reason });
const DENY = (reason: string): PolicyCheck => ({ outcome: 'deny', reason });

// Deep merge: objects recurse, arrays and scalars from the overlay replace the base.
function merge(base: unknown, overlay: unknown): unknown {
  if (!isRecord(base) || !isRecord(overlay)) return overlay === undefined ? base : overlay;
  const out = { ...base };
  for (const [k, v] of Object.entries(overlay)) out[k] = isRecord(base[k]) && isRecord(v) ? merge(base[k], v) : v;
  return out;
}

const string = (v: unknown): v is string => typeof v === 'string';
const text = (v: unknown): v is string => string(v) && v.trim().length > 0;
const pattern = (v: unknown) => { if (!text(v)) return false; new RegExp(v, 'i'); return true; };
function exactOrigin(value: unknown): boolean {
  if (!text(value)) return false;
  const url = new URL(value);
  return url.origin === value && !url.username && !url.password && (url.protocol === 'https:'
    || url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname));
}
const SEND_VERBS = ['send', 'send now', 'invia', 'invia ora'];
function sendReason(value: unknown): boolean {
  return typeof value === 'string' && SEND_VERBS.some(verb => value === 'verb:' + verb || value === 'enter-submits:' + verb);
}
const schema: Schema = {
  version: v => v === 3, comment: string,
  hold: { verbs: [text], url_patterns: [pattern], keys: [{ url: pattern, keys: [text] }], uploads: v => typeof v === 'boolean',
    extensions: { disable: v => typeof v === 'boolean', uninstall: v => typeof v === 'boolean' } },
  deny: { comment: string, verbs_on_hosts: [{ host: pattern, verbs: [text] }], type_into: [text], eval_patterns: [pattern] },
  approvals: { ttl_minutes: v => typeof v === 'number' && Number.isFinite(v) && v > 0 },
  signin: { remember: [exactOrigin] },
  sends: { remember: [{ site: exactOrigin, kind: v => v === 'click' || v === 'press', reason: sendReason }] },
};
function validate(value: unknown, shape: Schema = schema, at = 'policy', required = false): void {
  const invalid = (): never => { throw new Error(`${at}: invalid value`); };
  if (typeof shape === 'function') {
    try { if (!shape(value)) invalid(); } catch { invalid(); }
  } else if (Array.isArray(shape)) {
    if (!Array.isArray(value)) return invalid();
    value.forEach((v, i) => validate(v, shape[0], `${at}[${i}]`, true));
  } else {
    if (!isRecord(value)) return invalid();
    if (required && Object.keys(shape).some(k => !Object.hasOwn(value, k))) invalid();
    for (const [k, v] of Object.entries(value)) {
      if (!Object.hasOwn(shape, k)) throw new Error(`${at}.${k}: unknown field`);
      validate(v, shape[k], `${at}.${k}`);
    }
  }
}

function assertPolicy(value: unknown): asserts value is PolicyData {
  validate(value);
  if (!isRecord(value) || !isRecord(value.hold) || !isRecord(value.deny) || !isRecord(value.approvals)
    || !['verbs', 'url_patterns', 'keys'].every(k => Array.isArray(value.hold && isRecord(value.hold) ? value.hold[k] : undefined))
    || !['verbs_on_hosts', 'type_into', 'eval_patterns'].every(k => Array.isArray(value.deny && isRecord(value.deny) ? value.deny[k] : undefined))
    || typeof value.approvals.ttl_minutes !== 'number' || typeof value.version !== 'number') throw new Error('policy: missing required fields');
}

export function loadPolicy({ overlay = path.join(process.env.GADDI_HOME || path.join(os.homedir(), 'Library/Application Support/Gaddi'), 'policy.json'), off = process.env.GADDI_POLICY_OFF === '1', log = () => {} }: { overlay?: string; off?: boolean; log?: (message: string) => void } = {}): Policy {
  let policy: unknown = parseJSON(fs.readFileSync(DEFAULT_POLICY, 'utf8'));
  validate(policy);
  const sources = [DEFAULT_POLICY];
  // Invariant: an existing overlay must parse and validate before the broker can listen.
  try {
    if (fs.lstatSync(overlay, { throwIfNoEntry: false })) {
      const local = parseJSON(fs.readFileSync(overlay, 'utf8'));
      validate(local);
      assertPolicy(policy);
      const passwords = policy.deny.eval_patterns;
      policy = merge(policy, local);
      // User expression rules add restrictions without removing built-in password checks.
      assertPolicy(policy);
      const localPatterns = isRecord(local) && isRecord(local.deny) && Array.isArray(local.deny.eval_patterns) ? local.deny.eval_patterns.filter((v): v is string => typeof v === 'string') : [];
      policy.deny.eval_patterns = [...new Set([...passwords, ...localPatterns])];
      sources.push(overlay);
    }
  } catch (error) {
    throw new Error(`Invalid policy overlay ${overlay}: ${errorMessage(error)}`);
  }
  assertPolicy(policy);
  for (const rule of policy.sends?.remember ?? []) {
    if (!sendRule(rule.site, rule.kind, rule.reason)) throw new Error('policy.sends.remember: invalid send scope');
  }
  if (off) {
    log('!!!!!!!!!! GADDI_POLICY_OFF=1: EVERY GATE IS DISABLED. Test-only. Never run like this for real work. !!!!!!!!!!');
  }
  return { ...policy, off: !!off, sources };
}

// Called only after the daemon verifies an app decision. Preserve the owner's other rules.
export function setSigninRemember(overlay: string, site: unknown, remember: boolean, off = false): Policy {
  validate({ signin: { remember: [site] } });
  const current = loadPolicy({ overlay, off });
  const local: unknown = fs.existsSync(overlay) ? parseJSON(fs.readFileSync(overlay, 'utf8')) : {};
  validate(local);
  if (!isRecord(local)) throw new Error('Invalid policy overlay');
  const sites = new Set(current.signin?.remember ?? []);
  if (remember) sites.add(site as string); else sites.delete(site as string);
  const updated = { ...local, signin: { remember: [...sites] } };
  return saveRememberedPolicy(overlay, updated, off);
}

function saveRememberedPolicy(overlay: string, updated: unknown, off: boolean): Policy {
  validate(updated);
  const temporary = overlay + '.' + crypto.randomUUID() + '.tmp';
  try {
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(updated, null, 2) + '\n'); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temporary, overlay);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  return loadPolicy({ overlay, off });
}

// The same private atomic overlay writer serves both owner-signed remember choices.
export function setSendRemember(overlay: string, rule: SendRule, remember: boolean, off = false): Policy {
  validate({ sends: { remember: [rule] } });
  if (!sendRule(rule.site, rule.kind, rule.reason)) throw new Error('policy.sends.remember: invalid value');
  const current = loadPolicy({ overlay, off });
  const local: unknown = fs.existsSync(overlay) ? parseJSON(fs.readFileSync(overlay, 'utf8')) : {};
  validate(local);
  if (!isRecord(local)) throw new Error('Invalid policy overlay');
  const rules = (current.sends?.remember ?? []).filter(existing => !sameSendRule(existing, rule));
  if (remember) rules.push(rule);
  return saveRememberedPolicy(overlay, { ...local, sends: { remember: rules } }, off);
}
const sameSendRule = (a: SendRule, b: SendRule) => a.site === b.site && a.kind === b.kind && a.reason === b.reason;

// Reject refused hosts and protected pages even when an overlay loosens ordinary holds.
const builtInPolicy: PolicyData = JSON.parse(fs.readFileSync(DEFAULT_POLICY, 'utf8'));
export function sendRule(url: unknown, kind: unknown, reason: unknown): SendRule | undefined {
  if (!(kind === 'click' && typeof reason === 'string' && reason.startsWith('verb:')
    || kind === 'press' && typeof reason === 'string' && reason.startsWith('enter-submits:')) || !sendReason(reason)) return;
  try {
    const page = new URL(String(url));
    if (!exactOrigin(page.origin) || page.username || page.password) return;
    if (builtInPolicy.deny.verbs_on_hosts.some(rule => rx(rule.host)?.test(hostOf(page.href))
      && rule.verbs.some(verb => SEND_VERBS.includes(fold(verb))))) return;
    if (builtInPolicy.hold.url_patterns.some(pattern => rx(pattern)?.test(page.href))) return;
    return { site: page.origin, kind: kind as SendRule['kind'], reason: reason as string };
  } catch { return; }
}

// Only a held send can use this exception. Refusals, mixed destructive labels,
// protected pages/destinations and other hold kinds retain their original gates.
export function checkRememberedSend(policy: Policy, url: string, kind: string, check: PolicyCheck,
  name = '', destination = ''): PolicyCheck {
  if (check.outcome !== 'hold') return check;
  const rule = sendRule(url, kind, check.reason);
  if (!rule) return check;
  for (const pattern of policy.hold.url_patterns) {
    if (rx(pattern)?.test(url) || destination && rx(pattern)?.test(destination)) return HOLD(`url-pattern:${pattern}`);
  }
  if (destination && !sendRule(destination, kind, check.reason)) return HOLD('send destination requires approval');
  const dangerous = matchVerb(name, [...builtInPolicy.hold.verbs, ...policy.hold.verbs].filter(verb => !SEND_VERBS.includes(fold(verb))));
  if (dangerous) return HOLD(`verb:${dangerous}`);
  if (policy.sends?.remember.some(existing => sameSendRule(existing, rule))) return ALLOW('owner remembered this send kind on this site');
  return { ...check, rememberable: true };
}

// ---------------------------------------------------------------- helpers
// Only the owner's policy can remember a site; POLICY_OFF grants no sign-in authority.
export function checkSignin(policy: Policy, site: string): PolicyCheck {
  return policy.signin?.remember.includes(site) ? ALLOW('owner remembered this site') : HOLD('sign-in needs owner approval');
}
export function hostOf(url: string) {
  try { return new URL(url).hostname.toLowerCase().replace(/\.$/, ''); } catch { return ''; }
}
// Fold accents, lowercase, collapse whitespace: "Procedi  al PAGAMENTO" -> "procedi al pagamento"
export function fold(s: unknown) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// whole word / phrase match of a folded verb inside a folded name
export function phraseIn(name: unknown, verb: unknown) {
  const n = fold(name), v = fold(verb);
  if (!n || !v) return false;
  return new RegExp(`(^|[^a-z0-9])${esc(v)}([^a-z0-9]|$)`).test(n);
}
// the longest matching verb names the reason ("pay now" rather than "pay")
function matchVerb(name: unknown, verbs: string[]) {
  let best: string | null = null;
  for (const v of verbs || []) if (phraseIn(name, v) && (!best || fold(v).length > fold(best).length)) best = v;
  return best;
}
function rx(pattern: string) { try { return new RegExp(pattern, 'i'); } catch { return null; } }
// Action URL holds apply on every host.
export function checkNavigation(policy: Policy, url: string) {
  if (policy.off) return ALLOW('policy-off');
  for (const pattern of policy.hold.url_patterns || []) {
    const r = rx(pattern);
    if (r && r.test(url)) return HOLD(`url-pattern:${pattern}`);
  }
  return ALLOW();
}

export function checkClick(policy: Policy, host: string, accessibleName: string) {
  if (policy.off) return ALLOW('policy-off');
  const name = accessibleName || '';
  for (const rule of (policy.deny.verbs_on_hosts || [])) {
    const r = rx(rule.host);
    if (!r || !r.test(host || '')) continue;
    const v = matchVerb(name, rule.verbs);
    if (v) return DENY(`verb:${v} on ${host}`);
  }
  const v = matchVerb(name, policy.hold.verbs);
  if (v) return HOLD(`verb:${v}`);
  return ALLOW();
}

function normKey(key: string) {
  return String(key || '').split('+').map(k => {
    const t = k.trim().toLowerCase();
    if (t === 'cmd' || t === 'command' || t === 'meta') return 'meta';
    if (t === 'ctrl' || t === 'control') return 'control';
    // The Chrome bridge dispatches Return as Enter; both spellings must hit the same gate.
    if (t === 'return') return 'enter';
    return t;
  }).sort().join('+');
}

export function checkPress(policy: Policy, host: string, key: string, focusedFormSubmitName?: string) {
  if (policy.off) return ALLOW('policy-off');
  const k = normKey(key);
  for (const rule of (policy.hold.keys || [])) {
    const r = rx(rule.url);
    if (!r || !r.test(host || '')) continue;
    if ((rule.keys || []).some(x => normKey(x) === k)) return HOLD(`key:${key} on ${host}`);
  }
  if (k === 'enter' && focusedFormSubmitName) {
    const v = matchVerb(focusedFormSubmitName, policy.hold.verbs);
    if (v) return HOLD(`enter-submits:${v}`);
  }
  return ALLOW();
}

// info: { selector, tag, type, autocomplete, matched: [selectors the browser said el.matches()] }
export function checkType(policy: Policy, info: Record<string, unknown>) {
  if (policy.off) return ALLOW('policy-off');
  const el = info || {};
  const tag = fold(el.tag), type = fold(el.type), ac = fold(el.autocomplete);
  for (const sel of (policy.deny.type_into || [])) {
    const matched = el.matched || [];
    if (!Array.isArray(matched) && typeof matched !== 'string') throw new TypeError('(el.matched || []).includes is not a function');
    if (matched.includes(sel)) return DENY(`type-into:${sel}`);
    const m = /^([a-z]*)\[(\w+)=["']?([^"'\]]+)["']?\]$/i.exec(sel.trim());
    if (m) {
      const [, t, attr, val] = m;
      if (t && fold(t) !== tag) continue;
      const have = attr === 'type' ? type : attr === 'autocomplete' ? ac : fold(el[attr]);
      if (have === fold(val)) return DENY(`type-into:${sel}`);
    } else if (fold(sel) === tag) return DENY(`type-into:${sel}`);
  }
  if (type === 'password') return DENY('type-into:password');
  return ALLOW();
}

// Attaching a local file sends it to the site: one-way unless the person's policy says otherwise.
export function checkUpload(policy: Policy) {
  if (policy.off) return ALLOW('policy-off');
  return policy.hold.uploads === false ? ALLOW() : HOLD('upload of a local file');
}

export function checkExtension(policy: Policy, operation: string, ownRepo = false): PolicyCheck {
  // Folder trust is a fixed install boundary, not a page-action overlay escape.
  if (operation === 'install') return ownRepo ? ALLOW('owner repository') : HOLD('install extension outside owner repositories');
  if (operation === 'disable' || operation === 'uninstall') return policy.off || policy.hold.extensions?.[operation] === false
    ? ALLOW() : HOLD(`${operation} Chrome extension`);
  return ALLOW();
}

export function checkEval(policy: Policy, expression: string) {
  if (policy.off) return ALLOW('policy-off');
  const src = String(expression || '');
  for (const p of (policy.deny.eval_patterns || [])) {
    const r = rx(p);
    if (r && r.test(src)) return DENY(`eval-pattern:${p}`);
  }
  return ALLOW();
}
