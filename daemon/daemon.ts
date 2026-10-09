#!/usr/bin/env node
import { waitParams, wheelParams } from '../shared/protocol.ts';
// Thin user-level broker: the extension operates the user's Chrome; this process gates and audits calls.
import net from 'node:net';
import type { Socket } from 'node:net';
import { isRecord, parseJSON, errorMessage, hasErrorCode, versionParam } from '../shared/protocol.ts';
import type { IncomingParams, ChromeParams, WireError, BrokerResults, SigninResult } from '../shared/protocol.ts';
import type { PolicyCheck } from './policy.ts';
import type { ApprovalAction, StoredApprovalRef, StoredApproval, RemoteFacts } from './approvals.ts';
// `decision` and `remoteKey` exist only to be written to the audit: who answered from another device and what,
// never the signature or the nonce.
interface CallMeta { caller: string; tab: unknown; url: unknown; tabs?: { tab: unknown; url: string }[]; upload?: { name: string; bytes?: number }; signin?: SigninResult; grantId?: string;
  decision?: { approval: string; kind?: string; verb?: string }; remoteKey?: string }

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { loadPolicy, setSigninRemember, setSendRemember, sendRule, checkRememberedSend, checkNavigation, checkClick, checkPress, checkType, checkEval, checkUpload, checkSignin, hostOf } from './policy.ts';
import { signinSite, listLogins, chooseLogin, runSignin } from './signin.ts';
import { createSigninSecrets } from './signin-secrets.ts';
import { readUpload, UPLOAD_CHUNK } from './uploads.ts';
import type { UploadFile } from './uploads.ts';
import { createApprovals, GateError, approvalRef, cleanURL, cleanDetail } from './approvals.ts';
import { createProofVerifier, approvalMessage, signinRevokeMessage, sendRevokeMessage } from './proof.ts';
import { createGrants, checkGrant, parseGrantRequest, grantDetail, isGrantSpec, ruleString } from './grants.ts';
import type { GrantScope } from './grants.ts';
import { createRemote } from './remote.ts';
import { createBridge } from './bridge.ts';
import { extensionCall } from './extensions.ts';
import { wakeApprovalApp } from './approval-wake.ts';

const home = process.env.GADDI_HOME || path.join(os.homedir(), 'Library/Application Support/Gaddi');
const socket = process.env.GADDI_SOCKET || path.join(home, 'gaddi.sock');
const auditPath = process.env.GADDI_AUDIT || path.join(home, 'audit.jsonl');
const statePath = process.env.GADDI_STATE || path.join(home, 'state.json');
const TEXT_LIMIT = 20000, HTML_LIMIT = 5 * 1024 * 1024;
const AGENT_GROUP_PREFIX = '● ';
const AUDIT_MAX_BYTES = 10 * 1024 * 1024;
const log = (...args: unknown[]) => console.error(new Date().toISOString(), '[gaddi]', ...args);
fs.mkdirSync(home, { recursive: true, mode: 0o700 });
const startedAt = Date.now();
const policyPath = path.join(home, 'policy.json');
let policy = loadPolicy({ overlay: policyPath, log });
const signinSecrets = createSigninSecrets();
const subscribers = new Set<Socket>(), connections = new Set<Socket>();
const nonAuditedMethods = new Set(['status', 'approvals.list', 'signin.remembered', 'sends.remembered', 'bridge.status', 'bridge.health', 'events.subscribe', 'session.begin', 'remote.status']);
interface Session { caller: string; owned: Set<number>; lastActivity: number; endedAt?: number }
const sessions = new Map<string, Session>();
// A tab put in front of the user is his from then on, whichever agent brought it forward.
const shown = new Set<number>();
const sessionConnections = new WeakMap<Socket, string>();
const SESSION_LIMIT = 256, SESSION_TAB_LIMIT = 512;
function positiveMillis(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
const SESSION_IDLE_MS = positiveMillis(process.env.GADDI_SESSION_IDLE_MS, 900000);
const SESSION_END_MS = positiveMillis(process.env.GADDI_SESSION_END_MS, 120000);
const SESSION_SWEEP_MS = positiveMillis(process.env.GADDI_SESSION_SWEEP_MS, 30000);
// Test-only: shortens the grant "minute" so expiry can be watched. It can never lengthen a grant
// past what the owner saw on the card (60 s per minute is the ceiling).
const GRANT_MINUTE_MS = Math.min(60000, positiveMillis(process.env.GADDI_GRANT_MINUTE_MS, 60000));
function validSession(value: unknown): string | undefined {
  return typeof value === 'string' && value.length >= 1 && value.length <= 64
    && !/[^A-Za-z0-9:_-]/.test(value) ? value : undefined;
}
// The key a session grant is bound to. A CLI call or a malformed ID has none, so it can hold no grant;
// explicit IDs stay disjoint from the `cli:` fallbacks touchSession uses for ordinary bookkeeping.
function grantSession(params: IncomingParams): string | undefined {
  const identity = validSession(params.session);
  return identity === undefined ? undefined : 'session:' + identity;
}
// Chats whose lifetime socket (session.begin) is open right now, with how many sockets that is.
// A grant is only ever requested by, approved for, and served to a chat in this map.
const liveSessions = new Map<string, number>();
// Only a socket that was counted may be counted down: one that was already closing when it registered never was.
const countedLifetimes = new WeakSet<Socket>();
function touchSession(params: IncomingParams, caller: string) {
  const identity = validSession(params.session);
  // Keep explicit IDs disjoint from CLI fallbacks, even if an ID itself starts with cli:.
  const key = identity === undefined ? 'cli:' + caller : 'session:' + identity;
  let session = sessions.get(key);
  if (!session) {
    if (sessions.size >= SESSION_LIMIT) {
      const oldest = [...sessions].reduce((a, b) => a[1].lastActivity <= b[1].lastActivity ? a : b);
      sessions.delete(oldest[0]); // Forgetting ownership is the safe direction.
    }
    session = { caller, owned: new Set(), lastActivity: Date.now() };
    sessions.set(key, session);
  }
  session.lastActivity = Date.now();
  return session;
}
function rememberShown(tab: number) {
  if (!shown.has(tab) && shown.size >= SESSION_TAB_LIMIT) {
    const oldest = shown.values().next().value!;
    shown.delete(oldest);
    // Never turn a forgotten handoff into a cleanup candidate.
    for (const session of sessions.values()) session.owned.delete(oldest);
  }
  shown.add(tab);
}
function forgetClosed(tabs: unknown[]) {
  for (const id of tabs) if (typeof id === 'number') {
    signinSecrets.clear(id);
    shown.delete(id);
    for (const session of sessions.values()) session.owned.delete(id);
    for (const [key, entry] of noEffects) if (entry.tab === id) noEffects.delete(key);
  }
}
function emit(event: string, data: unknown) {
  if (event === 'bridge.attach') {
    // Chrome hands out tab ids per browser run, so a restart can reuse an id we still hold.
    // A reattach is the only moment that can follow such a restart: forget which tabs are ours
    // rather than risk closing a stranger's tab that inherited the number.
    for (const session of sessions.values()) session.owned.clear();
    shown.clear();
  }
  if (event === 'approval.pending') {
    if (isRecord(data)) wakeApprovalApp([data.approval], { log });
  }
  const line = JSON.stringify(signinSecrets.redact({ event, ts: new Date().toISOString(), data }, undefined, false)) + '\n';
  for (const conn of subscribers) {
    if (conn.destroyed || conn.writableLength > 1024 * 1024) { subscribers.delete(conn); conn.destroy(); }
    else conn.write(line);
  }
}
const bridge = createBridge({ emit });
const proofs = createProofVerifier({ publicKeyPath: process.env.GADDI_APPROVER_PUB || path.join(os.homedir(), 'Library/Application Support/Gaddi/approver.pub'),
  usedPath: path.join(home, 'used-proofs.log') });
// Approving some holds from another device (remote.ts). Off until the owner turns it on with Touch ID; the saved
// choice is read back here. The drop-in file is only a candidate key: it authorizes nothing by itself.
const remote = createRemote({ statePath: path.join(home, 'remote.json'),
  keyPath: process.env.GADDI_REMOTE_KEY || path.join(home, 'remote-approver.pub'), proofs, emit, log });
const approvals = createApprovals({ imageRoot: path.join(home, 'approvals'), log, ttlMinutes: Number(policy.approvals.ttl_minutes) > 0 ? Number(policy.approvals.ttl_minutes) : 10,
  onChange: () => {
    fs.writeFileSync(statePath + '.tmp', JSON.stringify({ approvals: approvals.persistable() }), { mode: 0o600 });
    fs.renameSync(statePath + '.tmp', statePath);
  },
  // Whether the owner's other device may answer this record right now, judged from the live policy and state.
  remote: (a, facts) => remote.eligible(a, facts, policy), emit });
try {
  const state = parseJSON(fs.readFileSync(statePath, 'utf8'));
  if (state === null) throw new TypeError("Cannot read properties of null (reading 'approvals')");
  approvals.restore(isRecord(state) ? state.approvals : undefined);
}
catch (e) { if (!hasErrorCode(e, 'ENOENT')) throw e; }
approvals.pruneImages();
// Invariant: grants exist only in this process. Nothing is loaded at startup, so a restart ends every one.
const grants = createGrants({ minuteMs: GRANT_MINUTE_MS, emit, audit, log });

async function gate({ kind, meta, detail, action, check, approval, capture, targetSelector, remoteScope }: { kind: string; meta: CallMeta; detail: string; action: ApprovalAction; check: PolicyCheck; approval: unknown; capture?: () => Promise<unknown>; targetSelector?: string;
  // The page and the raw name and destination the grant scan reads, kept beside the hold for remote approval.
  remoteScope?: Omit<RemoteFacts, 'reason'> }) {
  // Only isolated-world references are retained; raw selectors may contain page data.
  const targetRef = typeof targetSelector === 'string' && /^@[A-Za-z0-9_-]{6}:[0-9a-z]+$/.test(targetSelector) ? targetSelector : undefined;
  if (check.outcome === 'deny') throw new GateError('denied', `denied: ${check.reason} (no approval path)`);
  // A supplied retry ID is always checked, even if the current policy would now allow the action.
  if (approval) return approvals.consume(approval, action, targetRef);
  if (check.outcome === 'allow') return;
  const existing = approvals.pendingFor(action, targetRef);
  let picture: unknown;
  if (!existing && capture) {
    try { picture = await capture(); }
    catch (error) { log('approval capture unavailable:', /deadline|timeout|within 25 seconds/.test(errorMessage(error)) ? 'deadline exceeded' : 'bridge failed'); }
  }
  const remoteFacts = remoteScope ? { ...remoteScope, reason: check.reason } : undefined;
  const a = existing || approvals.hold({ kind, ...meta, detail, action, reason: check.reason, rememberable: check.rememberable, picture, targetSelector: targetRef, remoteFacts });
  if (existing) approvals.attach(existing, remoteFacts);
  throw new GateError('held', `held: ${check.reason}; approve ${a.id} in Gaddi, then retry with its id`, approvalRef(a));
}
const browserMethods = new Set(['tabs', 'bookmarks', 'look', 'wait', 'html', 'screenshot', 'open', 'goto', 'back', 'click', 'type', 'press', 'hover', 'scroll', 'select', 'upload', 'eval', 'emulate', 'close', 'show', 'group', 'signin']);
const requiredString = (value: unknown, name: string) => { if (typeof value !== 'string' || !value) throw new Error(`${name} required`); return value; };
function groupTitle(task: unknown, caller: string) {
  if (task !== undefined && typeof task !== 'string') throw new Error('group must be a string');
  const normalize = (value: string) => value.trim().replace(/\s+/gu, ' ');
  const name = normalize(normalize(task ?? '').replace(/^●\s*/u, ''));
  const label = normalize(caller) || 'unknown';
  if ([...name].length > 40) throw new Error('group must be at most 40 characters');
  if (/[\x00-\x1f\x7f]/u.test(name + label)) throw new Error('group and caller must not contain control characters');
  return AGENT_GROUP_PREFIX + (name ? `${name} · ` : '') + label;
}
function navigationURL(value: unknown) {
  const url = new URL(requiredString(value, 'url'));
  // Invariant: navigation cannot smuggle executable javascript/data URLs past eval gates.
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new GateError('denied', 'navigation requires http or https');
  }
  return url.href;
}
type IncomingTab = { id?: unknown; tabId?: unknown; tab?: unknown; url?: unknown; title?: unknown; group?: unknown };
const tabFields = (value: unknown): IncomingTab | undefined => isRecord(value) ? value : undefined;
const tabObject = (value: unknown) => { const fields = tabFields(value); return tabFields(fields?.tab && typeof fields.tab === 'object' ? fields.tab : value); };
const tabId = (value: unknown) => { const tab = tabFields(value); return tab?.id ?? tab?.tabId ?? tab?.tab; };
const tabList = (value: unknown): unknown[] => { const list: unknown = Array.isArray(value) ? value : isRecord(value) ? value.tabs : undefined; if (!Array.isArray(list)) throw new Error('bridge returned invalid tabs'); return list; };
function tabURL(value: unknown): unknown {
  if (value === null || value === undefined) throw new TypeError('Cannot read properties of null or undefined');
  return tabFields(value)?.url;
}
function htmlResult(url: string, full: unknown) {
  if (typeof full !== 'string') throw new Error('bridge returned invalid HTML');
  const bytes = Buffer.from(full);
  let end = Math.min(bytes.length, HTML_LIMIT);
  while (end < bytes.length && end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return { url, html: bytes.subarray(0, end).toString('utf8'), untrusted: true, length: end, truncated: bytes.length > end };
}
const wrap = (url: string, text: string) => `[untrusted page content from ${url}]\n${text}\n[end of page content]`;

const noEffects = new Map<string, { tab: number; url: string; count: number }>();
function observeEffect(method: string, meta: CallMeta, result: unknown) {
  if (typeof meta.tab !== 'number') return;
  const key = JSON.stringify([meta.caller, meta.tab]), previous = noEffects.get(key);
  if (previous && previous.url !== meta.url || method === 'look' || method === 'screenshot') noEffects.delete(key);
  if (!['click', 'hover', 'type', 'press', 'select', 'scroll'].includes(method) || !isRecord(result) || typeof result.changed !== 'boolean') return;
  if (result.changed) { noEffects.delete(key); return; }
  const count = Math.min(3, (noEffects.get(key)?.count || 0) + 1);
  noEffects.delete(key); noEffects.set(key, { tab: meta.tab, url: String(meta.url), count });
  if (noEffects.size > 1024) noEffects.delete(noEffects.keys().next().value!);
  if (count >= 3) result.warning = '3 actions in a row changed nothing on this tab; look or take a screenshot before trying again.';
}
async function browserCall(method: string, params: IncomingParams, meta: CallMeta) {
  const session = touchSession(params, meta.caller);
  // Only chrome.describe can supply the description checked before dispatch.
  delete params.checkedDescription;
  // Invariant: resolve the active tab once, then describe and act on that exact tab through
  // the same bridge connection. Replacing/disconnecting the bridge invalidates the operation.
  const connection = bridge.connection();
  const deadline = Date.now() + 25000;
  const request = async (name: string, args: ChromeParams) => {
    try { return await bridge.request('chrome.' + name, args, connection); }
    catch (error) {
      if (errorMessage(error) === "Chrome's own pages cannot be driven") throw new GateError('denied', errorMessage(error));
      throw error;
    }
  };
  if (method === 'tabs') {
    const tabs = tabList(await request('tabs', {}));
    meta.tabs = tabs.map(t => ({ tab: tabId(t), url: cleanURL(tabURL(t)) }));
    for (const [key, entry] of noEffects) if (!tabs.some(t => tabId(t) === entry.tab)) noEffects.delete(key);
    return { tabs };
  }
  if (method === 'bookmarks') {
    if (params.query !== undefined && typeof params.query !== 'string') throw new Error('query must be a string');
    return request('bookmarks', params.query === undefined ? {} : { query: params.query });
  }
  if (['close', 'show', 'group'].includes(method)) {
    // Invariant: nothing closes the tab the user is looking at by omission. All tab
    // management requires explicit IDs and never resolves the active tab.
    const ids = method === 'show' ? [params.tab] : params.tabs;
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 100
      || ids.some(id => typeof id !== 'number' || !Number.isSafeInteger(id) || id < 0)) throw new Error(method === 'show'
        ? 'tab must be a nonnegative integer' : 'tabs must contain 1 to 100 Chrome tab ids');
    const selected = [...new Set(ids.filter((id): id is number => typeof id === 'number'))];
    const args: ChromeParams = method === 'show' ? { tab: selected[0] } : { tabs: selected };
    if (method === 'group') args.group = groupTitle(requiredString(params.group, 'group'), meta.caller);
    const tabs = tabList(await request('tabs', {}));
    meta.tabs = selected.map(id => ({ tab: id, url: cleanURL(tabFields(tabs.find(t => tabId(t) === id))?.url) }));
    if (method === 'show') { meta.tab = selected[0]; meta.url = meta.tabs[0].url; }
    const result = await request(method, args);
    if (method === 'show') rememberShown(selected[0]);
    // Grouping existing tabs never grants ownership: these may be the user's tabs.
    if (method === 'close' && isRecord(result) && Array.isArray(result.closed)) {
      forgetClosed(result.closed);
    }
    return result;
  }
  if (method === 'open') {
    const url = navigationURL(params.url);
    const group = groupTitle(params.group, meta.caller);
    if (params.foreground !== undefined && typeof params.foreground !== 'boolean') throw new Error('foreground must be boolean');
    meta.url = url;
    await gate({ kind: method, meta, detail: url, action: { method, caller: meta.caller, url, group, foreground: params.foreground ?? false },
      check: checkNavigation(policy, url), approval: params.approval });
    const result = await request('open', { url, group, foreground: params.foreground ?? false });
    meta.tab = tabId(tabObject(result)); meta.url = tabObject(result)?.url || url;
    if (typeof meta.tab === 'number' && Number.isSafeInteger(meta.tab) && meta.tab >= 0) {
      if (session.owned.size < SESSION_TAB_LIMIT) session.owned.add(meta.tab);
      if (params.foreground === true) rememberShown(meta.tab);
    }
    return result;
  }
  // A refused upload never reaches Chrome; an allowed one is read once, now. The audit
  // names the file even when it is refused.
  if (method === 'upload' && typeof params.path === 'string') meta.upload = { name: path.basename(params.path) };
  const upload: UploadFile | undefined = method === 'upload' ? readUpload(params.path) : undefined;
  let tab;
  if (params.tab == null) tab = tabObject(await request('active', {}));
  else {
    if (typeof params.tab !== 'number' || !Number.isSafeInteger(params.tab) || params.tab < 0) throw new Error('tab must be a nonnegative integer');
    tab = tabFields(tabList(await request('tabs', {})).find(t => tabId(t) === params.tab));
  }
  const resolvedTab = tabId(tab);
  if (typeof resolvedTab !== 'number' || !Number.isSafeInteger(resolvedTab) || typeof tab?.url !== 'string') throw new Error('chrome tab not found or missing URL');
  let pageURL = tab.url;
  meta.tab = resolvedTab; meta.url = pageURL;
  // Invariant: a hold becomes an allow here only through the calling chat's own unexpired session
  // grant (grants.ts). A CLI call has no session, so grantSession is undefined and it gets none.
  let grantId: string | undefined;
  // What remote approval will judge again if this call becomes a hold: the page as it is now, with its query
  // (a query can make a page protected), and the same raw name and destination the grant scan reads.
  let remoteScope: Omit<RemoteFacts, 'reason'> | undefined;
  const grantCheck = (held: PolicyCheck, scope: GrantScope) => {
    const decision = checkGrant(grants.active(grantSession(params)), policy, pageURL, held, scope);
    grantId = decision.grant;
    remoteScope = { pageURL, scope };
    return decision;
  };
  const args: ChromeParams = { tab: resolvedTab };
  if (method === 'signin') {
    let site = '';
    const finish = (result: SigninResult) => { meta.signin = result; return result; };
    try {
      site = signinSite(pageURL);
      let logins;
      try { logins = await listLogins(); }
      catch { return finish({ outcome: 'needs_you', site, step: '1password', reason: '1Password is locked or did not answer: unlock it with Touch ID, then retry' }); }
      const selection = chooseLogin(logins, site, params.item);
      if (selection.outcome !== 'selected') return finish(selection);
      const item = selection.item;
      const title = cleanDetail(item.title);
      try {
        await gate({ kind: 'signin', meta, detail: title, check: checkSignin(policy, site), approval: params.approval,
          action: { method: 'signin', caller: meta.caller, url: pageURL, tab: resolvedTab, item: item.id, title, site } });
      } catch (error) {
        if (error instanceof GateError && error.code === 'held' && error.approval) return finish({ outcome: 'needs_you', site,
          item_title: title, step: 'approval', reason: `held: approve ${String(error.approval.id)} in Gaddi, then retry with approval=${String(error.approval.id)}` });
        return finish({ outcome: 'failed', site, item_title: title, step: 'approval', reason: 'Sign-in approval refused or invalid' });
      }
      // The bridge connection and tab remain pinned while op and the page advance.
      return finish(await runSignin({ site, item, request: (name, values, deadline) => bridge.request('chrome.' + name, { ...values, tab: resolvedTab }, connection, deadline),
        remember: value => signinSecrets.remember(resolvedTab, [value]) }));
    } catch {
      return finish({ outcome: 'failed', site, step: 'signin', reason: 'Sign-in unavailable or site refused' });
    }
  }
  if (['click', 'type', 'press', 'select', 'scroll', 'hover', 'upload'].includes(method)) args.version = versionParam(params.version);
  if (method === 'look' && params.visible !== undefined) {
    if (typeof params.visible !== 'boolean') throw new Error('visible must be boolean');
    args.visible = params.visible;
  }
  if (method === 'wait') {
    const result = await request('wait', { ...args, ...waitParams(params) });
    if (isRecord(result) && typeof result.url === 'string') meta.url = result.url;
    return result;
  }
  let targetSelector: string | undefined;
  let check: PolicyCheck = { outcome: 'allow' }, detail = method;
  if (['click', 'type', 'hover', 'select', 'upload'].includes(method)) args.selector = requiredString(params.selector, 'selector');
  if (method === 'click' || method === 'type') {
    const info = await request('describe', { ...args, ...(method === 'type' ? { denySelectors: policy.deny.type_into || [] } : {}) });
    if (!isRecord(info) || typeof info.name !== 'string' || typeof info.tag !== 'string') throw new Error('bridge returned invalid element description');
    if (method === 'click') {
      if (typeof info.href !== 'string') throw new Error('chrome.describe must return href');
      targetSelector = typeof info.selector === 'string' ? info.selector : args.selector;
      check = checkClick(policy, hostOf(pageURL), info.name);
      if (check.outcome === 'allow' && info.href) check = checkNavigation(policy, navigationURL(new URL(info.href, pageURL).href));
      const destination = info.href ? new URL(info.href, pageURL).href : '';
      check = checkRememberedSend(policy, pageURL, method, check, info.name, destination);
      check = grantCheck(check, { kind: 'click', name: info.name, destination });
      detail = `${cleanDetail(info.name)}${info.href ? ' -> ' + cleanURL(new URL(info.href, pageURL).href) : ''}`;
      // Bind the resolved accessible name and destination too, so a changed button requires new approval.
      args._description = { name: info.name, href: info.href };
    } else {
      if (typeof params.text !== 'string') throw new Error('text must be a string');
      if (typeof info.type !== 'string' || typeof info.autocomplete !== 'string') throw new Error('chrome.describe must return type and autocomplete');
      const simple = /^(?:[a-z]+|[a-z]*\[(?:type|autocomplete)=["']?[^"'\]]+["']?\])$/i;
      if ((policy.deny.type_into || []).some(sel => !simple.test(sel.trim())) && !Array.isArray(info.matched)) throw new Error('chrome.describe must return matched denySelectors');
      if (params.mode !== undefined) {
        if (params.mode !== 'replace' && params.mode !== 'append') throw new Error('mode must be replace or append');
        args.mode = params.mode;
      }
      check = checkType(policy, info); args.text = params.text; detail = args.selector!;
    }
  } else if (method === 'press') {
    args.key = requiredString(params.key, 'key');
    let submitName = '';
    if (/^(enter|return)$/i.test(args.key)) {
      const info = await request('describe', { ...args, selector: ':focus' });
      if (!isRecord(info) || typeof info.submitName !== 'string') throw new Error('chrome.describe must return submitName');
      submitName = info.submitName;
      targetSelector = typeof info.selector === 'string' ? info.selector : ':focus';
      const denied = checkClick(policy, hostOf(pageURL), submitName);
      if (denied.outcome === 'deny') check = denied;
    }
    if (check.outcome === 'allow') check = checkPress(policy, hostOf(pageURL), args.key, submitName);
    check = checkRememberedSend(policy, pageURL, method, check, submitName);
    check = grantCheck(check, { kind: 'press', name: submitName });
    detail = args.key; args._description = { submitName };
  } else if (method === 'goto') {
    args.url = navigationURL(params.url); detail = args.url; check = checkNavigation(policy, args.url);
  } else if (method === 'eval') {
    args.expression = requiredString(params.expression, 'expression'); check = checkEval(policy, args.expression);
  } else if (method === 'scroll') {
    if (params.selector !== undefined) args.selector = requiredString(params.selector, 'selector');
    Object.assign(args, wheelParams(params));
    if (args.selector === undefined && args.dx === undefined && args.dy === undefined) throw new Error('scroll requires dx, dy or selector');
  } else if (method === 'screenshot') {
    if (params.fullPage !== undefined && typeof params.fullPage !== 'boolean') throw new Error('fullPage must be boolean');
    args.fullPage = params.fullPage ?? false;
  } else if (upload) {
    const info = await request('describe', args);
    if (!isRecord(info) || typeof info.name !== 'string') throw new Error('bridge returned invalid element description');
    targetSelector = typeof info.selector === 'string' ? info.selector : args.selector;
    meta.upload = { name: upload.name, bytes: upload.bytes.length };
    check = checkUpload(policy);
    // readUpload already refused secret stores above, so a grant never reaches a refused file.
    check = grantCheck(check, { kind: 'upload' });
    const size = upload.bytes.length < 1024 * 1024 ? `${Math.ceil(upload.bytes.length / 1024)} KB` : `${(upload.bytes.length / 1024 / 1024).toFixed(1)} MB`;
    // The approval app reads this as: <agent> wants to upload “<file> (<size>)” on <site>.
    detail = `${cleanDetail(upload.name)} (${size})`;
  } else if (method === 'emulate') {
    for (const key of ['width', 'height'] as const) if (params[key] !== undefined) {
      if (typeof params[key] !== 'number' || !Number.isSafeInteger(params[key]) || params[key] < 1) throw new Error(`${key} must be a positive integer`);
      args[key] = params[key];
    }
    for (const key of ['mobile', 'reset'] as const) if (params[key] !== undefined) {
      if (typeof params[key] !== 'boolean') throw new Error(`${key} must be boolean`); args[key] = params[key];
    }
    if (params.colorScheme !== undefined) {
      if (params.colorScheme !== 'light' && params.colorScheme !== 'dark' && params.colorScheme !== 'no-preference') throw new Error('invalid colorScheme');
      args.colorScheme = params.colorScheme;
    }
    if (params.animationSpeed !== undefined) {
      if (typeof params.animationSpeed !== 'number' || !Number.isFinite(params.animationSpeed) || params.animationSpeed <= 0 || params.animationSpeed > 1) throw new Error('animationSpeed must be greater than 0 and at most 1');
      args.animationSpeed = params.animationSpeed;
    }
  }
  if (method === 'select') {
    if (typeof params.value !== 'string') throw new Error('value must be a string'); args.value = params.value;
  }
  await gate({ kind: method, meta, detail, check, approval: params.approval, targetSelector, remoteScope,
    capture: targetSelector ? () => bridge.request('chrome.approvalCapture', { tab: resolvedTab,
      selector: targetSelector, checkedDescription: args._description, ...(method === 'press' ? { key: args.key } : {}) },
      connection, Math.min(deadline, Date.now() + 3000)) : undefined,
    // An approval covers this exact file: its name, size and content digest.
    action: { method, caller: meta.caller, url: pageURL, ...args,
      ...(upload ? { file: { name: upload.name, bytes: upload.bytes.length, sha256: upload.sha256 } } : {}) } });
  // A supplied approval went through consume, so only an action the grant itself waived is credited to it.
  if (grantId && !params.approval) meta.grantId = grantId;
  // Add the wire field only after gating so existing approval action hashes stay valid.
  if (method === 'click' || method === 'press' && /^(enter|return)$/i.test(args.key!)) args.checkedDescription = args._description;
  if (targetSelector && targetSelector !== ':focus') args.selector = targetSelector;
  delete args._description;
  if (upload) {
    const id = crypto.randomUUID(), chunks = Math.max(1, Math.ceil(upload.bytes.length / UPLOAD_CHUNK));
    for (let index = 0; index < chunks; index++) await request('uploadChunk', { upload: { id, index,
      data: upload.bytes.subarray(index * UPLOAD_CHUNK, (index + 1) * UPLOAD_CHUNK).toString('base64') } });
    args.upload = { id, chunks, name: upload.name, type: upload.type, lastModified: upload.lastModified, size: upload.bytes.length, sha256: upload.sha256 };
  }
  const rawResult = await request(method === 'look' ? 'read' : method, args);
  const result = isRecord(rawResult) ? rawResult : undefined;
  if (typeof result?.url === 'string') { pageURL = result.url; meta.url = pageURL; }
  if (method === 'look') {
    if (result?.note === "Chrome's own page: not readable; pick another tab" && result.text === '' && result.outline === '') {
      return { tab: resolvedTab, url: pageURL, title: result.title ?? tab.title, text: '', outline: '', note: result.note } satisfies BrokerResults['look'];
    }
    if (typeof result?.text !== 'string') throw new Error('bridge returned invalid text');
    const text = result.text.slice(0, TEXT_LIMIT), outline = String(result.outline || '').slice(0, TEXT_LIMIT);
    return { tab: resolvedTab, url: pageURL, title: result.title ?? tab.title, untrusted: true,
      ...(typeof result.version === 'string' ? { version: result.version } : {}),
      ...(isRecord(result.scroll) && typeof result.scroll.y === 'number' && Number.isFinite(result.scroll.y)
        && typeof result.scroll.height === 'number' && Number.isFinite(result.scroll.height)
        ? { scroll: { y: result.scroll.y, height: result.scroll.height } } : {}),
      ...(isRecord(result.offscreen) && typeof result.offscreen.above === 'number' && Number.isSafeInteger(result.offscreen.above) && result.offscreen.above >= 0
        && typeof result.offscreen.below === 'number' && Number.isSafeInteger(result.offscreen.below) && result.offscreen.below >= 0
        ? { offscreen: { above: result.offscreen.above, below: result.offscreen.below } } : {}),
      text: wrap(pageURL, text), outline: wrap(pageURL, outline), length: text.length,
      truncated: result.truncated === true || result.text.length > TEXT_LIMIT || String(result.outline || '').length > TEXT_LIMIT } satisfies BrokerResults['look'];
  }
  if (method === 'html') {
    const html = htmlResult(pageURL, result?.html);
    return { tab: resolvedTab, ...html, truncated: html.truncated || result?.truncated === true } satisfies BrokerResults['html'];
  }
  if (method === 'screenshot') {
    const encoded = result?.data;
    if (typeof encoded !== 'string') throw new Error('bridge screenshot must return base64 PNG or JPEG');
    const bytes = Buffer.from(encoded, 'base64');
    const format = bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ? 'png'
      : bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex')) ? 'jpeg' : null;
    if (!format) throw new Error('bridge returned invalid PNG or JPEG');
    const dir = path.join(home, 'shots'); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const shot = path.join(dir, `${resolvedTab}-${crypto.randomUUID()}.${format === 'jpeg' ? 'jpg' : 'png'}`);
    fs.writeFileSync(shot, bytes, { mode: 0o600 });
    return { tab: resolvedTab, url: pageURL, path: shot, mimeType: `image/${format}` } satisfies BrokerResults['screenshot'];
  }
  // Eval's arbitrary page object keys are data. Broker contract keys stay intact.
  if (method === 'eval' && isRecord(rawResult)) return { ...rawResult, value: signinSecrets.redact(rawResult.value) };
  return rawResult;
}

// ---------------------------------------------------------------- session grants
// A chat asks once. The owner answers in Gaddi with Touch ID. The broker acts on his signed answer
// itself, so the agent never retries and never holds a token that could be replayed.
function pendingGrantsOf(session: string) {
  return approvals.pendingMatching(a => a.kind === 'grant' && isRecord(a.grant) && a.grant.session === session);
}
function requestGrant(params: IncomingParams): never {
  const caller = typeof params.caller === 'string' ? params.caller : 'unknown';
  const session = grantSession(params);
  if (session === undefined || !liveSessions.has(session)) {
    throw new Error('a session grant needs a live agent chat (its MCP connection); a CLI call or an ended chat cannot ask for one');
  }
  const parsed = parseGrantRequest(params, policy);
  const { rules, minutes } = parsed;
  // The label is stored exactly as the card will show it (addresses lose their queries), so what the
  // owner signs and what the grant later lists are the same words.
  const label = parsed.label === undefined ? undefined : cleanDetail(parsed.label).trim() || undefined;
  const action = { method: 'grant.request', caller, url: '', session, rules: rules.map(ruleString), minutes, label: label ?? null };
  let request = approvals.pendingFor(action);
  if (!request) {
    // One open request per chat: a changed one replaces the old, so an agent cannot stack cards in front of the owner.
    for (const older of pendingGrantsOf(session)) approvals.cancel(older.id);
    request = approvals.hold({ kind: 'grant', tab: null, caller, url: '', detail: grantDetail(rules, minutes, label),
      reason: 'session grant', action, grant: { session, rules, minutes, ...(label ? { label } : {}) } });
  }
  throw new GateError('held', `held: session grant; approve ${String(request.id)} in Gaddi. It takes effect as soon as the owner approves: do not retry`, approvalRef(request));
}
function activateGrant(id: unknown, proof: unknown, remember: unknown) {
  // Refused before the proof is looked at, so a refused choice never uses a signature up.
  if (remember === true) throw new GateError('approval-invalid', 'a session grant cannot be remembered');
  // Invariant: a grant exists only after a valid, fresh, single-use Touch ID signature over this
  // record's id, kind and a digest of its detail text. The record is immutable while pending, so the
  // owner signed exactly the rules, duration and label the grant is made from.
  const record = approvals.get(id);
  approvals.signed(id, 'grant', proof, proofs, approvalMessage, { remember });
  return startGrant(id, record);
}
// The record is "granted" now, by a Touch ID signature or by the owner's remote approver (remote.ts, which may
// approve only a request of two hours or less). Everything below is synchronous: nothing can slip in between.
function startGrant(id: unknown, record: StoredApproval, approver?: 'remote') {
  const spec = record.grant;
  if (!isGrantSpec(spec) || !liveSessions.has(spec.session)) {
    approvals.cancel(id);
    throw new GateError('approval-invalid', 'the chat that asked has ended, so nothing was granted');
  }
  // If the grant cannot start (for instance its audit line cannot be written), the signed answer is
  // spent and the request closed: nothing runs unrecorded. A remote grant says so in its list and its audit line.
  try { grants.activate({ ...spec, caller: String(record.caller), ...(approver ? { approver } : {}) }); }
  catch (error) { approvals.cancel(id); throw error; }
  return approvals.complete(id);
}
// The chat's last lifetime socket closed: its grants end, and what it asked for can no longer be approved.
function releaseSession(key: string) {
  const open = (liveSessions.get(key) ?? 0) - 1;
  if (open > 0) { liveSessions.set(key, open); return; }
  liveSessions.delete(key);
  grants.endSession(key);
  for (const request of pendingGrantsOf(key)) approvals.cancel(request.id);
}

// ---------------------------------------------------------------- approving from another device
// The owner's phone approver (remote.ts) answers a request this broker says it may answer: an upload, post or delete
// on a page a session grant could cover, or a session-grant request of two hours or less. Everything from the first
// check to the decision runs without an await, so nothing can change in between.
function remoteDecision(params: IncomingParams, meta: CallMeta) {
  const verb = params.verb === 'grant' || params.verb === 'deny' ? params.verb : undefined;
  const id = typeof params.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(params.id) ? params.id : undefined;
  if (id !== undefined) meta.decision = { approval: id, ...(verb ? { verb } : {}) };
  if (!remote.enabled()) throw new GateError('denied', 'approving from another device is turned off');
  // One answer for a request that is unknown, already answered, expired, or not one a remote device may answer,
  // so a caller learns nothing about records it may not decide.
  const refuse = () => new GateError('approval-invalid', 'that request is not waiting, or cannot be answered from another device');
  const record = id === undefined ? undefined : pendingRecord(id);
  if (id === undefined || !record || !approvals.remotable(record)) throw refuse();
  meta.tab = record.tab; meta.url = record.url;
  meta.decision = { approval: id, kind: String(record.kind), ...(verb ? { verb } : {}) };
  // Signature, freshness and single use. After this line the decision is spent, whatever happens next.
  const decided = remote.verify(record, params);
  if (decided === 'deny') return approvals.resolveRemote(id, 'deny');
  if (record.kind !== 'grant') return approvals.resolveRemote(id, 'grant');
  approvals.resolveRemote(id, 'grant');
  return startGrant(id, record, 'remote');
}
function pendingRecord(id: string): StoredApproval | undefined {
  try { return approvals.get(id); } catch { return undefined; }
}

const methods: Record<string, (params: IncomingParams, conn: Socket, meta: CallMeta) => unknown> = {
  'session.begin': (params, conn) => serial(async () => {
    const key = validSession(params.session);
    if (key && !sessionConnections.has(conn)) {
      const session = touchSession(params, typeof params.caller === 'string' ? params.caller : 'unknown');
      if (conn.destroyed) session.endedAt = Date.now();
      else delete session.endedAt;
      sessionConnections.set(conn, 'session:' + key);
      // Counted only while open, so a socket that closed before this ran can never keep a chat "live".
      if (!conn.destroyed) {
        countedLifetimes.add(conn);
        liveSessions.set('session:' + key, (liveSessions.get('session:' + key) ?? 0) + 1);
      }
    }
    return {};
  }),
  status: () => ({ version: 3, pid: process.pid, uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    socket, audit: auditPath, bridge: bridge.status(), pendingApprovals: approvals.list().pending.length,
    policy: { off: policy.off, sources: policy.sources } }),
  'bridge.attach': ({ kind }, conn) => bridge.attach(conn, kind),
  'bridge.status': () => bridge.status(),
  'bridge.health': ({ lastSelfHeal }, conn) => bridge.health(conn, { lastSelfHeal }),
  extensions: params => serial(async () => {
    const operation = params.operation ?? 'list';
    const connection = operation === 'install' ? undefined : bridge.connection();
    return extensionCall(params, typeof params.caller === 'string' ? params.caller : 'unknown', policy,
      args => bridge.request('chrome.extensions', args, connection), gate);
  }),
  // `mine` marks the grants of the asking chat; the session key itself is never sent.
  'approvals.list': params => ({ ...approvals.list(), grants: grants.list(grantSession(params)) }),
  'grant.request': params => requestGrant(params),
  // Ending a grant only removes authority, so it needs no proof and any client may do it.
  'grants.revoke': ({ id }) => {
    if (typeof id !== 'string' || !grants.revoke(id)) throw new Error('no such active session grant');
    return { revoked: id, grants: grants.list() };
  },
  'approval.grant': ({ id, proof, remember }) => {
    if (approvals.get(id).kind === 'grant') return activateGrant(id, proof, remember);
    return approvals.signed(id, 'grant', proof, proofs, approvalMessage, {
      remember, onRemember: (site, send) => {
        if (send) {
          policy = setSendRemember(policyPath, send, true, policy.off);
          emit('sends.remembered', { rules: policy.sends?.remember ?? [] });
        } else {
          policy = setSigninRemember(policyPath, site, true, policy.off);
          emit('signin.remembered', { sites: policy.signin?.remember ?? [] });
        }
      },
    });
  },
  'approval.deny': ({ id, proof, remember }) => approvals.signed(id, 'deny', proof, proofs, approvalMessage, { remember }),
  // Approving from another device. Status is read-only; turning ON needs the owner's Touch ID signature over the
  // key's fingerprint; turning OFF only removes authority, so it needs no proof and any client may do it.
  'remote.status': () => remote.status(),
  'remote.enable': ({ fingerprint, proof }, _conn, meta) => {
    if (typeof fingerprint === 'string' && /^[a-f0-9]{64}$/.test(fingerprint)) meta.remoteKey = fingerprint.slice(0, 16);
    return remote.enable(fingerprint, proof);
  },
  'remote.disable': () => remote.disable(),
  'approval.remote': (params, _conn, meta) => remoteDecision(params, meta),
  'signin.remembered': () => ({ sites: policy.signin?.remember ?? [] }),
  'signin.revoke': ({ site, proof }) => {
    if (typeof site !== 'string' || signinSite(site) !== site) throw new GateError('approval-invalid', 'exact sign-in origin required');
    proofs.verify(proof, signinRevokeMessage(site, isRecord(proof) ? proof.ts : undefined));
    policy = setSigninRemember(policyPath, site, false, policy.off);
    emit('signin.remembered', { sites: policy.signin?.remember ?? [] });
    return { sites: policy.signin?.remember ?? [] };
  },
  'sends.remembered': () => ({ rules: policy.sends?.remember ?? [] }),
  'sends.revoke': ({ site, kind, reason, proof }) => {
    const rule = sendRule(site, kind, reason);
    if (!rule || rule.site !== site) throw new GateError('approval-invalid', 'exact send scope required');
    proofs.verify(proof, sendRevokeMessage(rule, isRecord(proof) ? proof.ts : undefined));
    policy = setSendRemember(policyPath, rule, false, policy.off);
    emit('sends.remembered', { rules: policy.sends?.remember ?? [] });
    return { rules: policy.sends?.remember ?? [] };
  },
  'approval.cancel': ({ id }) => ({ cancelled: approvals.cancel(id) }),
  // Article extraction can decode entities after HTML leaves the broker. Sanitize its final text too.
  'output.redact': ({ text }) => {
    if (typeof text !== 'string') throw new Error('text required');
    return signinSecrets.redact(text);
  },
  'audit.tail': ({ n = 20 }) => {
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 1 || n > 1000) throw new Error('n must be an integer from 1 to 1000');
    try { return { entries: fs.readFileSync(auditPath, 'utf8').trim().split('\n').filter(Boolean).slice(-n).map(parseJSON) }; }
    catch (e) { if (hasErrorCode(e, 'ENOENT')) return { entries: [] }; throw e; }
  },
  'events.subscribe': (_params, conn) => { subscribers.add(conn); return { subscribed: true }; },
};
function rotateAudit() {
  try {
    if (fs.statSync(auditPath).size <= AUDIT_MAX_BYTES) return;
  } catch (e) { if (hasErrorCode(e, 'ENOENT')) return; throw e; }
  fs.renameSync(auditPath, `${auditPath}.1`);
}
function audit(entry: unknown) {
  rotateAudit();
  fs.appendFileSync(auditPath, JSON.stringify(signinSecrets.redact(entry, undefined, false)) + '\n', { mode: 0o600 });
}
// Serialize broker actions to keep tab resolution, metadata and forwarding together. Approval
// and event calls remain independent, so a slow browser operation cannot block the approval app.
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> { const next = chain.catch(() => {}).then(fn); chain = next; return next; }
async function sweepSessions() {
  if (!bridge.status().connected) return;
  const connection = bridge.connection();
  for (const [key, session] of sessions) {
    const start = Date.now();
    const ended = session.endedAt !== undefined && start - session.endedAt >= SESSION_END_MS;
    const idle = start - session.lastActivity >= SESSION_IDLE_MS;
    if (!ended && !idle) continue;
    try {
      const tabs = tabList(await bridge.request('chrome.tabs', {}, connection));
      const agentTabs = tabs.filter(t => {
        const group = tabFields(t)?.group;
        return typeof group === 'string' && group.startsWith(AGENT_GROUP_PREFIX);
      });
      const liveAgentIds = new Set(agentTabs.map(tabId));
      for (const id of session.owned) if (!liveAgentIds.has(id)) session.owned.delete(id);
      const candidates = agentTabs.filter(t => {
        const id = tabId(t);
        return typeof id === 'number' && session.owned.has(id) && !shown.has(id);
      }).map(t => ({ tab: tabId(t) as number, url: cleanURL(tabURL(t)) }));
      const closed: typeof candidates = [];
      try {
        // The extension accepts at most 100 IDs per close, even for broker cleanup.
        for (let offset = 0; offset < candidates.length; offset += 100) {
          const batch = candidates.slice(offset, offset + 100);
          const result = await bridge.request('chrome.close', { tabs: batch.map(t => t.tab) }, connection);
          if (!isRecord(result) || !Array.isArray(result.closed)) throw new Error('invalid session close result');
          const ids: unknown[] = result.closed;
          closed.push(...batch.filter(t => ids.includes(t.tab)));
          // A tab Chrome refuses to close is one we stop claiming, rather than one we ask
          // about every thirty seconds for as long as it stays open.
          forgetClosed(batch.map(t => t.tab));
        }
      } finally {
        if (closed.length) audit({ ts: new Date().toISOString(), caller: session.caller, method: 'session.sweep',
          tab: null, url: '', tabs: closed, outcome: 'allow', ms: Date.now() - start });
      }
      sessions.delete(key);
    } catch { log('session sweep failed; will retry'); }
  }
}
let sweepPending = false;
const sessionTimer = setInterval(() => {
  if (sweepPending) return;
  sweepPending = true;
  // Queue once alongside browser calls, never recursively inside an existing serial action.
  void serial(sweepSessions).catch(() => log('session sweep failed; will retry'))
    .finally(() => { sweepPending = false; });
}, SESSION_SWEEP_MS);
sessionTimer.unref();
async function handle(input: unknown, conn: Socket) {
  const req = isRecord(input) ? input : undefined;
  const start = Date.now(), id = req?.id ?? null, method = req?.method;
  const params: IncomingParams = isRecord(req?.params) ? req.params : {};
  const meta: CallMeta = { caller: typeof params.caller === 'string' ? params.caller : 'unknown', tab: null, url: null };
  let result: unknown, error: (Omit<WireError, 'approval'> & { approval?: StoredApprovalRef }) | undefined;
  try {
    const methodName = typeof method === 'string' ? method : String(method);
    if (typeof method === 'string' && browserMethods.has(method)) result = await serial(async () => {
      const value = await browserCall(methodName, params, meta);
      observeEffect(methodName, meta, value);
      return value;
    });
    else if (Object.hasOwn(methods, methodName)) {
      if (typeof method === 'string' && ['approval.grant', 'approval.deny', 'approval.cancel'].includes(method)) {
        const record = approvals.get(params.id); meta.tab = record.tab; meta.url = record.url;
      }
      result = await methods[methodName](params, conn, meta);
    }
    else throw new Error(`unknown method: ${method}`);
  } catch (e) {
    error = { code: e instanceof GateError ? e.code : hasErrorCode(e, 'stale') ? 'stale' : 'error', message: errorMessage(e).split('\n')[0],
      ...(e instanceof GateError && e.approval ? { approval: e.approval } : {}) };
  }
  // Invariant: audit never stores page content, typed text, eval source, selectors or URL queries.
  // An upload records the file's name and size, never its folder or content.
  if (!(typeof method === 'string' && nonAuditedMethods.has(method))) {
    if (method === 'signin') audit({ ts: new Date().toISOString(), site: meta.signin?.site ?? '',
      item_title: meta.signin?.item_title ?? '', outcome: meta.signin?.outcome ?? 'failed' });
    else audit({ ts: new Date().toISOString(), caller: meta.caller,
      ...(typeof params.harness === 'string' ? { harness: params.harness } : {}), method, tab: meta.tab,
      url: cleanURL(meta.url), ...(meta.tabs ? { tabs: meta.tabs } : {}), ...(meta.upload ? { upload: meta.upload } : {}),
      ...(meta.grantId ? { grant: meta.grantId } : {}),
      // A decision from another device names who, which request and what was decided: never its signature or nonce.
      ...(meta.decision ? { approver: 'remote', kind: meta.decision.kind, verb: meta.decision.verb } : {}),
      ...(meta.remoteKey ? { fingerprint: meta.remoteKey } : {}),
      ...(typeof method === 'string' && ['click', 'hover', 'type', 'press', 'select', 'scroll', 'upload'].includes(method)
        && isRecord(result) && typeof result.changed === 'boolean' ? { changed: result.changed } : {}),
      outcome: error ? error.code === 'held' ? 'hold' : error.code === 'denied' ? 'deny' : 'error' : 'allow',
      approval: error?.approval?.id ?? meta.decision?.approval ?? params.approval, error: error?.code, ms: Date.now() - start });
  }
  // The caller's correlation ID and wire keys are protocol, never page-derived credentials.
  if (!conn.destroyed) conn.write(JSON.stringify(error ? { id, error: signinSecrets.redact(error, undefined, false) }
    : { id, result: signinSecrets.redact(result, undefined, false) }) + '\n');
}

const server = net.createServer(conn => {
  connections.add(conn); let buffer = ''; conn.setEncoding('utf8');
  conn.on('close', () => {
    connections.delete(conn); subscribers.delete(conn);
    const key = sessionConnections.get(conn), session = key === undefined ? undefined : sessions.get(key);
    if (session) session.endedAt = Date.now();
    if (key !== undefined && countedLifetimes.delete(conn)) releaseSession(key);
  });
  conn.on('error', e => log('connection error:', isRecord(e) ? e.code : undefined));
  conn.on('data', data => {
    buffer += data;
    if (buffer.length > 32 * 1024 * 1024) { conn.destroy(); return; }
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      let req: unknown;
      try { req = parseJSON(line); }
      catch { conn.write(JSON.stringify({ id: null, error: { code: 'error', message: 'invalid JSON' } }) + '\n'); continue; }
      if (bridge.receive(conn, req)) continue;
      handle(req, conn).catch(e => { log('request failed:', cleanDetail(errorMessage(e))); conn.destroy(); });
    }
  });
});
server.on('error', e => { log('server error:', e.message); process.exit(1); });
async function main() {
  if (fs.existsSync(socket)) {
    const live = await new Promise(resolve => {
      const conn = net.connect(socket);
      conn.once('connect', () => { conn.destroy(); resolve(true); });
      conn.once('error', error => {
        if (hasErrorCode(error, 'ECONNREFUSED') || hasErrorCode(error, 'ENOENT')) resolve(false);
        else { log('cannot probe existing socket:', error.message); process.exit(1); }
      });
    });
    if (live) { log('another daemon is live on', socket); process.exit(2); }
    fs.unlinkSync(socket);
  }
  server.listen(socket, () => {
    fs.chmodSync(socket, 0o600); log(`listening on ${socket}, pid ${process.pid}`);
    wakeApprovalApp(approvals.list().pending, { log });
  });
}
function shutdown() {
  clearInterval(sessionTimer);
  signinSecrets.stop();
  approvals.stop();
  grants.stop();
  for (const conn of connections) conn.destroy();
  server.close(() => process.exit(0));
}
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
main().catch(e => { log('fatal:', e.message); process.exit(1); });
