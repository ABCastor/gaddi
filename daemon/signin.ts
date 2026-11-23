import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';
import { isRecord } from '../shared/protocol.ts';
import type { ChromeParams, SigninProbe, SigninResult } from '../shared/protocol.ts';

export interface LoginItem { id: string; title: string; urls: string[] }
export type LoginSelection = { outcome: 'selected'; item: LoginItem } | SigninResult;

function websiteURL(value: unknown): { url: URL; authority: string } {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value) || /[\s\\]/.test(value)) throw new Error('Invalid sign-in site');
  const authority = value.match(/^https?:\/\/([^/?#]*)/i)?.[1] || '';
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Invalid sign-in site'); }
  if (authority.includes('@') || url.username || url.password || !url.hostname) throw new Error('Invalid sign-in site');
  return { url, authority };
}
export function signinSite(value: unknown): string {
  const { url, authority } = websiteURL(value);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && /^(?:localhost|127\.0\.0\.1)(?::[0-9]+)?$/.test(authority))) {
    throw new Error('Sign-in requires HTTPS');
  }
  return url.origin;
}

// Include PRIVATE rules: tenants of github.io, appspot.com etc. are distinct sites.
const exact = new Set<string>(), wildcard = new Set<string>(), exceptions = new Set<string>();
for (const line of fs.readFileSync(new URL('./public-suffix-list.dat', import.meta.url), 'utf8').split('\n')) {
  const rule = line.trim();
  if (!rule || rule.startsWith('//')) continue;
  const kind = rule.startsWith('!') ? exceptions : rule.startsWith('*.') ? wildcard : exact;
  const domain = domainToASCII(rule.replace(/^!|^\*\./, ''));
  if (domain) kind.add(domain);
}
export function registrable(host: string): string | undefined {
  if (isIP(host) || host.startsWith('[')) return undefined;
  const labels = host.split('.');
  let suffix = 0;
  for (let i = 0; i < labels.length; i++) {
    const candidate = labels.slice(i).join('.');
    if (exceptions.has(candidate)) return labels.slice(i).join('.');
    if (exact.has(candidate)) suffix = Math.max(suffix, labels.length - i);
    if (i > 0 && wildcard.has(candidate)) suffix = Math.max(suffix, labels.length - i + 1);
  }
  // Unknown suffixes match only their exact host, never a guessed last-two-label domain.
  return suffix && labels.length > suffix ? labels.slice(-suffix - 1).join('.') : undefined;
}
function matches(item: LoginItem, site: string): boolean {
  const host = new URL(site).hostname.replace(/\.$/, ''), domain = registrable(host);
  return item.urls.some(value => {
    try {
      // Stored websites may use HTTP; the destination still passes signinSite's strict check.
      const candidate = websiteURL(value).url.hostname.replace(/\.$/, '');
      return candidate === host || !!domain && registrable(candidate) === domain;
    } catch { return false; }
  });
}
export function chooseLogin(items: LoginItem[], value: string, requested?: unknown): LoginSelection {
  const site = signinSite(value);
  if (requested !== undefined && (typeof requested !== 'string' || !requested.trim())) {
    return { outcome: 'failed', site, reason: 'Invalid login selection' };
  }
  const candidates = items.filter(item => matches(item, site) && (requested === undefined || item.id === requested || item.title === requested));
  if (!candidates.length) return { outcome: requested === undefined ? 'no_login' : 'failed', site, reason: requested === undefined ? 'No matching login in the vaults agents can read (Automation or Shared)' : 'Selected login does not match this site' };
  if (candidates.length > 1) return { outcome: 'choose', site, reason: JSON.stringify(candidates.map(item => item.title)) };
  return { outcome: 'selected', item: candidates[0] };
}

// OP-DIAGNOSTICS. Every op failure becomes one fixed category so a sign-in can say which stage broke:
// the binary, the token file, the op process (exit, timeout, oversize) or the shape of what it returned.
// INVARIANT: an OpFailure holds only a category from this list and elapsed milliseconds. Never put op's
// stdout or stderr, item contents, a field label or value, a credential, the token or a path in it:
// categories reach the agent's reply and the audit.
export type OpFailureKind = 'binary-missing' | 'token-missing' | 'token-unreadable' | 'token-empty' | 'home-unavailable'
  | `${'list' | 'get' | 'otp' | 'create'}-${'spawn' | 'exit' | 'timeout' | 'oversize' | 'malformed'}`
  | `schema-${'missing' | 'duplicate'}-${'username' | 'password'}` | 'budget';
export class OpFailure extends Error {
  readonly kind: OpFailureKind; readonly elapsedMs: number;
  // The message stays the old fixed sentence of each operation, so existing callers read the same text.
  constructor(kind: OpFailureKind, elapsedMs = 0, message = '1Password lookup failed') { super(message); this.kind = kind; this.elapsedMs = elapsedMs; }
}
const rethrow = (error: unknown, fallback: OpFailureKind, message: string): never => {
  throw new OpFailure(failureKind(error, fallback), error instanceof OpFailure ? error.elapsedMs : 0, message);
};
const failureKind = (error: unknown, fallback: OpFailureKind): OpFailureKind => error instanceof OpFailure ? error.kind : fallback;
// The agent-facing and audited pair for a failed 1Password step: `<step>:<kind>` and whole milliseconds.
export function opDiagnostic(step: string, error: unknown, elapsedMs: number, fallback: OpFailureKind): { category: string; elapsed_ms: number } {
  return { category: `${step}:${failureKind(error, fallback)}`, elapsed_ms: Math.max(0, Math.round(elapsedMs)) };
}

// launchd starts the broker with PATH=/usr/bin:/bin:/usr/sbin:/sbin, so look where Homebrew installs op
// after PATH (a fake earlier on PATH still wins in tests). GADDI_OP_FALLBACK_DIRS replaces the two
// Homebrew places for tests that must prove a missing binary on a launchd-like PATH.
function opBinary(): string | undefined {
  const fallback = process.env.GADDI_OP_FALLBACK_DIRS !== undefined ? process.env.GADDI_OP_FALLBACK_DIRS.split(':') : ['/opt/homebrew/bin', '/usr/local/bin'];
  const dirs = [...(process.env.PATH || '').split(':'), ...fallback].filter(Boolean);
  for (const dir of dirs) {
    try { fs.accessSync(`${dir}/op`, fs.constants.X_OK); return `${dir}/op`; } catch { /* next */ }
  }
  return undefined;
}
export const PASSWORD_UNAVAILABLE = "1Password is unavailable to agents: the agent token file is missing or 1Password could not be reached. Logins must sit in a vault agents can read (Automation or Shared), never Personal.";
// op signs in only with the agents' service-account token, read from its file per call,
// and runs with a home of its own so it never finds the 1Password desktop app. Why: the
// desktop app answers an agent's op call with a Touch ID card, which blocks every sign-in
// whenever nobody is at the Mac (raised five times on 6 Nov 2026). No desktop fallback.
function opEnv(): Record<string, string> {
  const tokenFile = process.env.GADDI_OP_TOKEN_FILE || path.join(os.homedir(), '.config/op/agent-rw-token');
  let token: string;
  // The read error names the file and is dropped; only its code chooses the category.
  try { token = fs.readFileSync(tokenFile, 'utf8').trim(); }
  catch (error) { throw new OpFailure((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'token-missing' : 'token-unreadable'); }
  if (!token) throw new OpFailure('token-empty');
  const home = process.env.GADDI_OP_HOME || path.join(os.homedir(), '.config/op/isolated-home');
  try { fs.mkdirSync(home, { recursive: true, mode: 0o700 }); } catch { throw new OpFailure('home-unavailable'); }
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('OP_') && !key.startsWith('GADDI_OP_'))) as Record<string, string>;
  return { ...env, HOME: home, OP_SERVICE_ACCOUNT_TOKEN: token };
}
const OP_CHILD_MS = 5000;
function op(verb: 'list' | 'get' | 'otp' | 'create', args: string[], input?: string): Promise<string> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    let stdout = '', size = 0, done = false, timer: NodeJS.Timeout | undefined;
    const fail = (kind: OpFailureKind) => {
      if (timer) clearTimeout(timer);
      if (!done) { done = true; stdout = ''; reject(new OpFailure(kind, Date.now() - started)); }
    };
    const binary = opBinary();
    if (!binary) { fail('binary-missing'); return; }
    let env: Record<string, string>;
    try { env = opEnv(); } catch (error) { fail(failureKind(error, 'token-unreadable')); return; }
    let child;
    try { child = spawn(binary, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
      child.stdin.on('error', () => {});
      child.stdin.end(input); } catch { fail(`${verb}-spawn`); return; }
    const running = child;
    timer = setTimeout(() => { running.kill('SIGKILL'); fail(`${verb}-timeout`); }, OP_CHILD_MS);
    running.stdout.setEncoding('utf8');
    running.stdout.on('data', (chunk: string) => {
      size += Buffer.byteLength(chunk);
      if (size > 2 * 1024 * 1024) { running.kill('SIGKILL'); fail(`${verb}-oversize`); }
      else stdout += chunk;
    });
    running.stderr.on('data', () => {}); // Drain, never echo or propagate child output.
    running.on('error', () => fail(`${verb}-spawn`));
    running.on('close', code => {
      if (done) return;
      if (code !== 0) { fail(`${verb}-exit`); return; }
      clearTimeout(timer);
      done = true;
      resolve(stdout);
      stdout = '';
    });
  });
}
function parseOp(verb: 'list' | 'get', text: string): unknown {
  try { return JSON.parse(text); } catch { throw new OpFailure(`${verb}-malformed`); }
}
export async function listLogins(): Promise<LoginItem[]> {
  try {
    const value: unknown = parseOp('list', await op('list', ['item', 'list', '--categories', 'Login', '--format', 'json']));
    if (!Array.isArray(value)) throw new Error();
    return value.map(item => {
      if (!isRecord(item) || typeof item.id !== 'string' || typeof item.title !== 'string' || !Array.isArray(item.urls ?? [])) throw new Error();
      const urls = (item.urls ?? []) as unknown[];
      return { id: item.id, title: item.title, urls: urls.map(url => {
        if (typeof url === 'string') return url;
        if (isRecord(url) && typeof url.href === 'string') return url.href;
        throw new Error();
      }) };
    });
  } catch (error) { return rethrow(error, 'list-malformed', '1Password login list failed'); }
}
// 1Password marks a Login's built-in fields by purpose (USERNAME, PASSWORD), whatever their label says:
// the owner can rename "username" to "email", and a custom field elsewhere in the item can also be
// labelled "password". So pick each field by purpose; only a field without a purpose (an older export or
// a hand-made fixture) is matched by its exact label or ID. The parsed item stays in these functions and
// is never logged; only the two chosen values leave them.
export function pickCredentials(value: unknown, needUsername = true): { username: string; password: string } {
  const fields = Array.isArray(value) ? value : isRecord(value) && Array.isArray(value.fields) ? value.fields
    : isRecord(value) && 'value' in value ? [value] : undefined;
  if (!fields) throw new OpFailure('get-malformed');
  const records = fields.filter(isRecord);
  function field(kind: 'username' | 'password'): string {
    const byPurpose = records.filter(entry => entry.purpose === kind.toUpperCase());
    const matches = byPurpose.length ? byPurpose : records.filter(entry => entry.purpose === undefined && (entry.label === kind || entry.id === kind));
    if (matches.length > 1) throw new OpFailure(`schema-duplicate-${kind}`);
    const found = matches[0]?.value;
    if (found === undefined || found === null || found === '') return '';
    if (typeof found !== 'string') throw new OpFailure('get-malformed');
    return found;
  }
  const password = field('password');
  if (!password) throw new OpFailure('schema-missing-password');
  const username = field('username');
  if (!username && needUsername) throw new OpFailure('schema-missing-username');
  return { username, password };
}
// A password-only page (a "confirm your password" step) needs no username, so an item without one still fills it.
// The first read asks op for the two labelled fields only. When that answer cannot give a unique pair (a
// renamed or absent label, a second "password", or an op exit, which may be how op reports a missing
// label), one full read of the item picks by purpose instead; a timeout, oversize or environment failure
// does not retry, so it cannot spend the budget twice. The category reported is the last read's.
const REREAD = new Set<OpFailureKind>(['get-exit', 'get-malformed', 'schema-missing-username', 'schema-missing-password', 'schema-duplicate-username', 'schema-duplicate-password']);
export async function getCredentials(item: LoginItem, needUsername = true): Promise<{ username: string; password: string }> {
  const started = Date.now();
  try {
    try { return pickCredentials(parseOp('get', await op('get', ['item', 'get', item.id, '--fields', 'label=username,label=password', '--reveal', '--format', 'json'])), needUsername); }
    catch (error) { if (!REREAD.has(failureKind(error, 'get-malformed'))) throw error; }
    return pickCredentials(parseOp('get', await op('get', ['item', 'get', item.id, '--reveal', '--format', 'json'])), needUsername);
  } catch (error) { throw new OpFailure(failureKind(error, 'get-malformed'), Date.now() - started, '1Password credentials unavailable'); }
}
// SECRET-FILL: only the password field. An item an agent created with op often has no username, and a fill needs none.
export async function getPassword(item: LoginItem): Promise<string> {
  try {
    const value: unknown = JSON.parse(await op('get', ['item', 'get', item.id, '--fields', 'label=password', '--reveal', '--format', 'json']));
    const fields = Array.isArray(value) ? value : [value];
    if (fields.length !== 1 || !isRecord(fields[0]) || typeof fields[0].value !== 'string' || !fields[0].value) throw new Error();
    return fields[0].value;
  } catch { throw new Error('1Password credentials unavailable'); }
}
export async function getOTP(item: LoginItem): Promise<string | undefined> {
  try {
    const value = (await op('otp', ['item', 'get', item.id, '--otp'])).trim();
    return /^[0-9]{6,10}$/.test(value) ? value : undefined;
  } catch { return undefined; }
}

// A new item is always created in the caller-selected vault, never edited in place.
// Password generation happens inside op; neither argv nor agent-visible output contains it.
export async function createLogin(site: string, value: unknown): Promise<LoginItem> {
  site = signinSite(site);
  if (!isRecord(value) || typeof value.vault !== 'string' || !/^[a-z0-9]{26}$/.test(value.vault) || typeof value.title !== 'string' || !value.title.trim() || value.title.length > 160
    || typeof value.username !== 'string' || !value.username.trim() || value.username.length > 320
    || Object.keys(value).some(key=>!['title','username','vault'].includes(key))) throw new Error('Invalid new login');
  const template = JSON.stringify({ category: 'LOGIN', title: value.title, urls: [{ href: site, primary: true }],
    fields: [{ id: 'username', type: 'STRING', purpose: 'USERNAME', value: value.username }] });
  const saved: unknown = JSON.parse(await op('create', ['item', 'create', '-', '--vault', value.vault,
    '--generate-password=letters,digits,symbols,32', '--format', 'json'], template));
  if (!isRecord(saved) || typeof saved.id !== 'string' || saved.title !== value.title
    || !isRecord(saved.vault) || saved.vault.id !== value.vault) throw new Error('New login was not confirmed');
  return { id: saved.id, title: value.title, urls: [site] };
}

export async function runSignin({ site: requestedSite, item, request, remember, tab, signup = false, budgetMs = 15000 }: {
  site: string; item: LoginItem; tab?: number; signup?: boolean;
  request: (name: string, args: ChromeParams, deadline?: number) => Promise<unknown>;
  remember: (value: string) => void;
  budgetMs?: number; // The whole sign-in's budget; only tests shorten it.
}): Promise<SigninResult> {
  let site = '', username = '', password = '', otp = '', step = 'probe';
  const until = Date.now() + budgetMs;
  const result = (outcome: SigninResult['outcome'], reason?: string, diagnostic?: { category: string; elapsed_ms: number }): SigninResult =>
    ({ outcome, site, item_title: item.title, step, ...(reason ? { reason } : {}), ...diagnostic });
  async function bounded<T>(work: () => Promise<T>): Promise<T> {
    const remaining = until - Date.now();
    if (remaining <= 0) throw new OpFailure('budget');
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([work(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new OpFailure('budget')), remaining); })]);
    } finally { if (timer) clearTimeout(timer); }
  }
  function call(name: string, args: ChromeParams = {}): Promise<unknown> {
    const signin = args.signin ? { ...args.signin, ...(signup ? { signup: true } : {}) } : undefined;
    return bounded(() => request(name, { ...args, ...(signin ? { signin } : {}), ...(tab === undefined ? {} : { tab }) }, until));
  }
  async function probe(): Promise<SigninProbe> {
    const value = await call('signinProbe', { signin: { site } });
    if (!isRecord(value) || typeof value.url !== 'string' || typeof value.signature !== 'string'
      || ['username', 'usernameConfirmation', 'password', 'confirmation', 'otp', 'submit'].some(key => value[key] !== undefined && typeof value[key] !== 'string')
      || value.passwordPresent !== undefined && typeof value.passwordPresent !== 'boolean'
      || value.challenge !== undefined && typeof value.challenge !== 'boolean') throw new Error();
    if (signinSite(value.url) !== site) throw new Error();
    return value as unknown as SigninProbe;
  }
  async function type(kind: 'username' | 'usernameConfirmation' | 'password' | 'confirmation' | 'otp', text: string): Promise<string | undefined> {
    const current = await probe();
    if (current.challenge || !current[kind]) return undefined;
    await call('signinType', { selector: current[kind], text, signin: { site, kind } });
    return current[kind];
  }
  async function submit(kind: 'username' | 'password' | 'otp', selector: string) {
    const current = await probe();
    if (current.challenge || current[kind] !== selector) throw new Error();
    await call('signinSubmit', { selector, signin: { site, kind } });
    return current;
  }
  async function waitFor(test: (probe: SigninProbe) => boolean): Promise<SigninProbe> {
    let current = await probe();
    while (!test(current) && !current.challenge && Date.now() < until - 200) {
      await new Promise(resolve => setTimeout(resolve, 150));
      current = await probe();
    }
    return current;
  }
  async function settleSignin(before: SigninProbe, allowOTP = true) {
    let stableSince = 0, fingerprint = '', confirmed = false;
    const page = await waitFor(current => {
      if (allowOTP && current.otp) return true;
      const clean = !(current.passwordPresent ?? !!current.password) && !current.username && !current.otp && !current.challenge
        && (current.url !== before.url || current.signature !== before.signature);
      const next = JSON.stringify([current.url, current.signature]);
      if (!clean) { stableSince = 0; fingerprint = ''; return false; }
      if (!stableSince || next !== fingerprint) { stableSince = Date.now(); fingerprint = next; }
      // A transition page can lose its password field before rendering OTP or a challenge.
      confirmed = Date.now() - stableSince >= 1000;
      return confirmed;
    });
    return { page, confirmed };
  }
  try {
    site = signinSite(requestedSite);
    if (!matches(item, site)) return result('failed', 'Selected login does not match this site');
    let page = await probe();
    if (page.challenge || !page.username && !page.password) return result('needs_you', 'No supported login form');
    step = 'credentials';
    const started = Date.now();
    // The reply keeps PASSWORD_UNAVAILABLE for existing callers; category and elapsed_ms say which part
    // failed (OP-DIAGNOSTICS) and never carry op output or a value.
    try { ({ username, password } = await bounded(() => getCredentials(item, signup || !!page.username))); }
    catch (error) { return result('needs_you', PASSWORD_UNAVAILABLE, opDiagnostic(step, error, Date.now() - started, 'get-malformed')); }
    if (username) remember(username);
    remember(password);
    page = await probe(); // op may have taken seconds; recheck before using its values.
    if (page.challenge) return result('needs_you', 'Additional verification required');
    if (page.username && !username) return result('needs_you', PASSWORD_UNAVAILABLE, opDiagnostic(step, new OpFailure('schema-missing-username'), Date.now() - started, 'schema-missing-username'));
    if (page.username) {
      step = 'username';
      const selector = await type('username', username);
      if (!selector) return result('needs_you', 'Login form changed');
      page = await probe();
      // A sign-up's "Confirm email" box takes the same username.
      if (signup && page.usernameConfirmation) {
        if (!await type('usernameConfirmation', username)) return result('needs_you', 'Confirmation field changed');
        page = await probe();
      }
      if (!page.password && !signup) {
        await submit('username', selector);
        page = await waitFor(current => !!current.password || !!current.otp);
      }
    }
    if (page.challenge || !page.password) return result('needs_you', 'Password form unavailable');
    step = 'password';
    const selector = await type('password', password);
    if (!selector) return result('needs_you', 'Login form changed');
    if (signup) {
      page = await probe();
      if (page.confirmation && !await type('confirmation', password)) return result('needs_you', 'Confirmation field changed');
      step = 'complete';
      return result('filled', 'Saved login filled. Inspect the form, complete other fields, then click its submit through the ordinary gates (submit:true has Gaddi press it after the fill).');
    }
    const before = await submit('password', selector);
    let settled = await settleSignin(before);
    page = settled.page;
    if (page.challenge) return result('needs_you', 'Additional verification required');
    if (page.otp) {
      step = 'otp';
      otp = await bounded(() => getOTP(item)) || '';
      if (!otp) return result('needs_you', 'One-time code required');
      remember(otp);
      const otpSelector = await type('otp', otp);
      if (!otpSelector) return result('needs_you', 'Verification form changed');
      await submit('otp', otpSelector);
      settled = await settleSignin(before, false);
      page = settled.page;
    }
    step = 'complete';
    if (settled.confirmed && !(page.passwordPresent ?? !!page.password)) return result('signed_in');
    return result('needs_you', 'Sign-in not confirmed');
  } catch { return result('failed', 'Sign-in could not be completed'); }
  finally { username = ''; password = ''; otp = ''; }
}
