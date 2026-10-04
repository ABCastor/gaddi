import { spawn } from 'node:child_process';
import fs from 'node:fs';
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
function registrable(host: string): string | undefined {
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
  if (!candidates.length) return { outcome: requested === undefined ? 'no_login' : 'failed', site, reason: requested === undefined ? 'No matching login' : 'Selected login does not match this site' };
  if (candidates.length > 1) return { outcome: 'choose', site, reason: JSON.stringify(candidates.map(item => item.title)) };
  return { outcome: 'selected', item: candidates[0] };
}

// launchd starts the broker with PATH=/usr/bin:/bin:/usr/sbin:/sbin, so look where Homebrew installs op
// after PATH (a fake earlier on PATH still wins in tests).
function opBinary(): string {
  const dirs = [...(process.env.PATH || '').split(':').filter(Boolean), '/opt/homebrew/bin', '/usr/local/bin'];
  for (const dir of dirs) {
    try { fs.accessSync(`${dir}/op`, fs.constants.X_OK); return `${dir}/op`; } catch { /* next */ }
  }
  return 'op';
}
function op(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('OP_')));
    let stdout = '', size = 0, done = false;
    const fail = () => { if (!done) { done = true; reject(new Error('1Password lookup failed')); } };
    let child;
    try { child = spawn(opBinary(), args, { env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 }); } catch { fail(); return; }
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      size += Buffer.byteLength(chunk);
      if (size > 2 * 1024 * 1024) { child.kill(); stdout = ''; fail(); }
      else stdout += chunk;
    });
    child.stderr.on('data', () => {}); // Drain, never echo or propagate child output.
    child.on('error', fail);
    child.on('close', code => {
      if (done) return;
      if (code !== 0) { stdout = ''; fail(); return; }
      done = true;
      resolve(stdout);
      stdout = '';
    });
  });
}
export async function listLogins(): Promise<LoginItem[]> {
  try {
    const value: unknown = JSON.parse(await op(['item', 'list', '--categories', 'Login', '--format', 'json']));
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
  } catch { throw new Error('1Password login list failed'); }
}
export async function getCredentials(item: LoginItem): Promise<{ username: string; password: string }> {
  try {
    const fields: unknown = JSON.parse(await op(['item', 'get', item.id, '--fields', 'label=username,label=password', '--reveal', '--format', 'json']));
    if (!Array.isArray(fields)) throw new Error();
    function field(label: string) {
      const matches = (fields as unknown[]).filter(value => isRecord(value) && (value.label === label || value.id === label));
      if (matches.length !== 1 || !isRecord(matches[0]) || typeof matches[0].value !== 'string') throw new Error();
      return matches[0].value;
    }
    const username = field('username'), password = field('password');
    if (!password) throw new Error();
    return { username, password };
  } catch { throw new Error('1Password credentials unavailable'); }
}
export async function getOTP(item: LoginItem): Promise<string | undefined> {
  try {
    const value = (await op(['item', 'get', item.id, '--otp'])).trim();
    return /^[0-9]{6,10}$/.test(value) ? value : undefined;
  } catch { return undefined; }
}

export async function runSignin({ site: requestedSite, item, request, remember, tab }: {
  site: string; item: LoginItem; tab?: number;
  request: (name: string, args: ChromeParams, deadline?: number) => Promise<unknown>;
  remember: (value: string) => void;
}): Promise<SigninResult> {
  let site = '', username = '', password = '', otp = '', step = 'probe';
  const until = Date.now() + 15000;
  const result = (outcome: SigninResult['outcome'], reason?: string): SigninResult => ({ outcome, site, item_title: item.title, step, ...(reason ? { reason } : {}) });
  async function bounded<T>(work: () => Promise<T>): Promise<T> {
    const remaining = until - Date.now();
    if (remaining <= 0) throw new Error();
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([work(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error()), remaining); })]);
    } finally { if (timer) clearTimeout(timer); }
  }
  function call(name: string, args: ChromeParams = {}): Promise<unknown> {
    return bounded(() => request(name, { ...args, ...(tab === undefined ? {} : { tab }) }, until));
  }
  async function probe(): Promise<SigninProbe> {
    const value = await call('signinProbe', { signin: { site } });
    if (!isRecord(value) || typeof value.url !== 'string' || typeof value.signature !== 'string'
      || ['username', 'password', 'otp'].some(key => value[key] !== undefined && typeof value[key] !== 'string')
      || value.passwordPresent !== undefined && typeof value.passwordPresent !== 'boolean'
      || value.challenge !== undefined && typeof value.challenge !== 'boolean') throw new Error();
    if (signinSite(value.url) !== site) throw new Error();
    return value as unknown as SigninProbe;
  }
  async function type(kind: 'username' | 'password' | 'otp', text: string): Promise<string | undefined> {
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
    ({ username, password } = await bounded(() => getCredentials(item)));
    remember(username); remember(password);
    page = await probe(); // op may have waited for desktop approval; recheck before using its values.
    if (page.challenge) return result('needs_you', 'Additional verification required');
    if (page.username) {
      step = 'username';
      const selector = await type('username', username);
      if (!selector) return result('needs_you', 'Login form changed');
      page = await probe();
      if (!page.password) {
        await submit('username', selector);
        page = await waitFor(current => !!current.password || !!current.otp);
      }
    }
    if (page.challenge || !page.password) return result('needs_you', 'Password form unavailable');
    step = 'password';
    const selector = await type('password', password);
    if (!selector) return result('needs_you', 'Login form changed');
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
