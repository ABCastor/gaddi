import { execFile, spawn } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { isRecord } from '../shared/protocol.ts';

// Recovery when the Chrome bridge is down because the user's Chrome stopped (crash or quit), or its
// extension/native host died. It runs only when an agent asks for the browser, never on its own timer,
// so a Chrome the user quit stays closed until something needs it.
// Stalls are established by repeated bridge timeouts or a host that does not respawn. Recovery
// gracefully quits Chrome, never signals it, and proves the restored bridge with a tabs request.
// Restart attempts are reserved durably before quitting, so failures cannot create restart loops.
export type HealState = 'stalled' | 'connected' | 'disconnected' | 'waiting-extension' | 'relaunching' | 'needs-owner';
export interface HealLimits {
  stallCount: number; stallWindowMs: number; hostGraceMs: number; quitWaitMs: number; restartCooldownMs: number;
  extensionWaitMs: number; relaunchWaitMs: number; cooldownMs: number; windowMs: number;
  maxRelaunches: number; ownerRecheckMs: number; reportedWaitMs: number; pollMs: number; maxPollMs: number;
}
export const DEFAULT_HEAL_LIMITS: HealLimits = {
  stallCount: 3, stallWindowMs: 5 * 60 * 1000, hostGraceMs: 15000, quitWaitMs: 20000, restartCooldownMs: 30 * 60 * 1000,
  extensionWaitMs: 15000, relaunchWaitMs: 45000, cooldownMs: 10 * 60 * 1000, windowMs: 60 * 60 * 1000,
  maxRelaunches: 3, ownerRecheckMs: 2 * 60 * 1000, reportedWaitMs: 1000, pollMs: 250, maxPollMs: 2000,
};
export const OWNER_RELOAD = 'Open chrome://extensions in Chrome, find Gaddi, make sure its switch is on, and press Reload (the circular arrow).';

export interface HealStatus {
  state: HealState; message?: string; since?: string; lastRelaunch?: string;
  lastRecovery?: { at: string; action: 'reconnect' | 'relaunch'; message: string };
}
export interface HealDeps {
  /** Off: ensure() never probes or launches, callers keep the plain bridge error. */
  enabled?: boolean;
  connected(): boolean;
  chromeRunning(): Promise<boolean>;
  launch(): Promise<void>;
  quit?(): Promise<void>;
  reserveRestart?(at: number, cooldownMs: number): boolean;
  auditRestart?(at: number, reason: string): void;
  tabCount?(): Promise<number>;
  notify(text: string): void;
  log?(...args: unknown[]): void;
  now?(): number;
  limits?: Partial<HealLimits>;
}

export function createChromeHeal(deps: HealDeps) {
  const limits = { ...DEFAULT_HEAL_LIMITS, ...deps.limits };
  const now = deps.now ?? Date.now, log = deps.log ?? (() => {});
  let state: HealState = 'connected', message: string | undefined, since: number | undefined;
  let stalled = false, stallReason = '', failures: number[] = [], detachedAt: number | undefined;
  let lastRestart: number | undefined;
  function detectStall() {
    if (detachedAt !== undefined && !deps.connected() && now() - detachedAt >= limits.hostGraceMs)
      markStalled('The Chrome native host disconnected and did not respawn.');
  }
  function markStalled(reason: string) {
    if (stalled) return;
    incident++; since = now();
    stalled = true; stallReason = reason;
    if (!inflight) set('stalled', reason);
  }
  let incident = 0, notified = 0, recheckAt = 0;
  let relaunches: number[] = [];
  let lastRecovery: { at: number; action: 'reconnect' | 'relaunch'; message: string } | undefined;
  let inflight: Promise<string | undefined> | undefined;
  const waiters = new Set<() => void>();
  const iso = (at: number) => new Date(at).toISOString();

  function set(next: HealState, text?: string) { state = next; message = text; }
  function notifyOnce(text: string) {
    if (notified === incident) return;
    notified = incident;
    try { deps.notify(text); } catch (error) { log('recovery notice failed:', isRecord(error) ? error.code : undefined); }
  }
  // Event-driven, with a bounded polling backoff as a backstop for a missed attach event.
  function wait(ms: number): Promise<boolean> {
    if (deps.connected()) return Promise.resolve(true);
    return new Promise(resolve => {
      const deadline = now() + ms;
      let delay = limits.pollMs, timer: NodeJS.Timeout | undefined;
      const done = (value: boolean) => { clearTimeout(timer); waiters.delete(wake); resolve(value); };
      const wake = () => done(true);
      const poll = () => {
        if (deps.connected()) return done(true);
        const left = deadline - now();
        if (left <= 0) return done(false);
        timer = setTimeout(poll, Math.min(delay, left));
        delay = Math.min(delay * 2, limits.maxPollMs);
      };
      waiters.add(wake);
      timer = setTimeout(poll, Math.min(delay, ms));
    });
  }
  function recovered(action: 'reconnect' | 'relaunch', text: string) {
    lastRecovery = { at: now(), action, message: text };
    set('connected');
    // A self-reconnected extension is routine; a reopened Chrome is news to the user.
    if (action === 'relaunch') notifyOnce(text);
    log('chrome recovery:', action);
    return text;
  }
  function owner(text: string): never {
    set('needs-owner', text);
    recheckAt = now() + limits.ownerRecheckMs;
    notifyOnce(text);
    log('chrome recovery needs the owner');
    throw new Error(`chrome bridge not connected: ${text}`);
  }
  async function restartStalled(): Promise<string> {
    const at = now();
    if (lastRestart !== undefined && at - lastRestart < limits.restartCooldownMs)
      return owner('Chrome is stalled. Gaddi already attempted a graceful restart within 30 minutes; no further restart will be attempted yet.');
    let reserved = true;
    try { reserved = deps.reserveRestart?.(at, limits.restartCooldownMs) ?? true; }
    catch { return owner('Gaddi could not safely record a Chrome restart; Chrome was left untouched.'); }
    if (!reserved)
      return owner('Chrome is stalled. A graceful restart was already attempted within 30 minutes; no further restart will be attempted yet.');
    lastRestart = at;
    try { deps.auditRestart?.(at, stallReason); }
    catch { return owner('Gaddi could not audit the Chrome restart; Chrome was left untouched.'); }
    set('relaunching', 'Chrome stopped answering Gaddi. Gaddi is gracefully restarting Chrome with your profile and last session.');
    try {
      if (await deps.chromeRunning()) {
        if (!deps.quit) throw new Error('graceful quit unavailable');
        await deps.quit();
      }
      const deadline = now() + limits.quitWaitMs;
      while (await deps.chromeRunning()) {
        if (now() >= deadline) return owner('Chrome did not quit within the time limit. Gaddi stopped recovery and will never force-kill Chrome. Please quit and reopen Chrome yourself.');
        await new Promise(resolve => setTimeout(resolve, limits.pollMs));
      }
      await deps.launch();
      if (!await wait(limits.relaunchWaitMs)) return owner(`Gaddi gracefully restarted Chrome but the extension did not reconnect. ${OWNER_RELOAD}`);
      if (!deps.tabCount) throw new Error('tabs probe unavailable');
      const tabs = await deps.tabCount();
      stalled = false; failures = []; detachedAt = undefined;
      return recovered('relaunch', `Chrome stopped answering Gaddi; Gaddi gracefully restarted it with your profile and last session. The tabs check answered (${tabs} tabs).`);
    } catch (error) {
      if (state === 'needs-owner') throw error;
      return owner('Chrome recovery could not complete the graceful restart and tabs check. Gaddi will never force-kill Chrome. Please check Chrome.');
    }
  }
  async function recover(): Promise<string | undefined> {
    if (state === 'connected' || state === 'disconnected') { incident++; since = now(); }
    if (state === 'needs-owner' && now() < recheckAt) {
      // Already reported: answer fast instead of making every call wait out the full budget again.
      if (!stalled && await wait(limits.reportedWaitMs)) return recovered('reconnect', 'The Gaddi extension reconnected to Chrome.');
      throw new Error(`chrome bridge not connected: ${message}`);
    }
    if (stalled) return restartStalled();
    let running: boolean;
    try { running = await deps.chromeRunning(); }
    catch { return owner(`Gaddi cannot tell whether Chrome is running. Open Google Chrome; if it is already open, ${OWNER_RELOAD.charAt(0).toLowerCase()}${OWNER_RELOAD.slice(1)}`); }
    if (running) {
      set('waiting-extension', 'Chrome is open; waiting for the Gaddi extension to reconnect.');
      if (await wait(limits.extensionWaitMs)) return recovered('reconnect', 'The Gaddi extension reconnected to Chrome.');
      detectStall();
      if (stalled) return restartStalled();
      return owner(`Chrome is open but the Gaddi extension is not connected. ${OWNER_RELOAD}`);
    }
    const at = now();
    relaunches = relaunches.filter(time => time > at - limits.windowMs);
    const last = relaunches.at(-1);
    if (last !== undefined && (at - last < limits.cooldownMs || relaunches.length >= limits.maxRelaunches))
      return owner(`Chrome is not running. Gaddi already reopened it at ${iso(last)} and will not reopen it again so soon. Open Google Chrome yourself.`);
    relaunches.push(at);
    set('relaunching', 'Chrome had stopped (crash or quit). Gaddi is reopening it with your profile and last session.');
    try { await deps.launch(); }
    catch { return owner('Chrome had stopped and Gaddi could not reopen it. Open Google Chrome yourself.'); }
    if (await wait(limits.relaunchWaitMs)) {
      let tabs: number | undefined;
      try { tabs = await deps.tabCount?.(); } catch (error) { tabs = undefined; log('tab count after relaunch unavailable:', error instanceof Error ? error.message.split('\n')[0] : 'error'); }
      const restored = typeof tabs === 'number' ? `; ${tabs} tab${tabs === 1 ? '' : 's'} open again` : '';
      return recovered('relaunch', `Chrome had stopped (crash or quit); Gaddi reopened it with your profile and last session${restored}.`);
    }
    let still: boolean | undefined;
    try { still = await deps.chromeRunning(); } catch { still = undefined; }
    return owner(still
      ? `Gaddi reopened Chrome but the Gaddi extension has not connected. ${OWNER_RELOAD}`
      : `Gaddi tried to reopen Chrome but it is not running. Open Google Chrome yourself; Gaddi will not reopen it again before ${iso(at + limits.cooldownMs)}.`);
  }
  return {
    /** Resolve when the bridge is usable. Returns a recovery note when it had to recover, throws a plain instruction when it cannot. */
    ensure(): Promise<string | undefined> {
      if (deps.enabled === false) return Promise.resolve(undefined);
      detectStall();
      if (deps.connected() && !stalled) {
        if (state !== 'connected') set('connected');
        return Promise.resolve(undefined);
      }
      inflight ??= recover().finally(() => { inflight = undefined; });
      return inflight;
    },
    outcome(ok: boolean) {
      if (deps.enabled === false) return;
      if (ok) { failures = []; return; }
      failures = failures.filter(at => now() - at <= limits.stallWindowMs);
      failures.push(now());
      if (failures.length >= limits.stallCount) markStalled(`${failures.length} consecutive Chrome bridge requests timed out within five minutes.`);
    },
    detached() { detachedAt ??= now(); },
    /** The bridge attached: end the incident and release anyone waiting. */
    attached() {
      detachedAt = undefined;
      // Called inside bridge.attach, before its reply is written; the native host drops any request that
      // overtakes that reply. Wake waiters on the next macrotask so their first request follows it.
      const woken = [...waiters];
      setImmediate(() => { for (const wake of woken) wake(); });
      if (!inflight && !stalled && state !== 'connected') {
        if (state === 'needs-owner') lastRecovery = { at: now(), action: 'reconnect', message: 'The Gaddi extension reconnected to Chrome.' };
        set('connected');
      }
    },
    status(): HealStatus {
      detectStall();
      const live = deps.connected() && !stalled;
      const shown: HealState = stalled && state !== 'relaunching' && state !== 'needs-owner' ? 'stalled' : live ? 'connected' : state === 'connected' ? 'disconnected' : state;
      if (deps.enabled === false) return { state: live ? 'connected' : 'disconnected', ...(live ? {} : { message: 'Chrome bridge not connected; Chrome recovery is off for this broker.' }) };
      const text = live ? undefined : state === 'connected' || state === 'disconnected'
        ? 'Chrome bridge not connected; the next browser call checks Chrome and reopens it if it has stopped.' : message;
      return {
        state: shown, ...(text ? { message: text } : {}),
        ...(!live && since !== undefined && state !== 'connected' ? { since: iso(since) } : {}),
        ...(relaunches.length ? { lastRelaunch: iso(relaunches.at(-1)!) } : {}),
        ...(lastRecovery ? { lastRecovery: { at: iso(lastRecovery.at), action: lastRecovery.action, message: lastRecovery.message } } : {}),
      };
    },
  };
}

// Production probe: his everyday Chrome is the browser root running the app's own executable without a
// separate --user-data-dir (agents' disposable Chromes always pass one) and without a helper --type.
export function mainChromeRunning(psOutput: string, executable: string) {
  return psOutput.split('\n').some(row => {
    const command = row.trim().replace(/^\d+\s+/, '');
    return (command === executable || command.startsWith(executable + ' '))
      && !/(?:^|\s)--(?:type|user-data-dir|headless)(?:=|\s|$)/.test(command);
  });
}

function ownHome() {
  const home = process.env.GADDI_HOME;
  return !home || path.resolve(home) === path.join(os.homedir(), 'Library/Application Support/Gaddi');
}
function argv(name: string): string[] | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value) || !value.length || !value.every(part => typeof part === 'string')) throw new Error(`${name} must be a JSON array of strings`);
  return value;
}
function run(command: string[], timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), { stdio: 'ignore', timeout: timeoutMs });
    child.once('error', reject);
    child.once('exit', code => resolve(code ?? -1));
  });
}

/** Wiring for the daemon. Tests replace the probe/launcher with GADDI_CHROME_PROBE / GADDI_CHROME_LAUNCH (JSON argv). */
export function chromeControls() {
  const app = process.env.GADDI_CHROME_APP || '/Applications/Google Chrome.app';
  const executable = `${app}/Contents/MacOS/${app.split('/').at(-1)!.replace(/\.app$/, '')}`;
  const probe = argv('GADDI_CHROME_PROBE'), launcher = argv('GADDI_CHROME_LAUNCH');
  const restartPath = path.join(process.env.GADDI_HOME || path.join(os.homedir(), 'Library/Application Support/Gaddi'), 'chrome-restart.json');
  return {
    // Invariant: only the user's own broker (the default Gaddi home, which the installed service names
    // explicitly) may probe or open his Chrome. A broker with any other GADDI_HOME (every test) recovers
    // only through an explicitly supplied probe AND launcher.
    enabled: process.env.GADDI_CHROME_HEAL !== '0' && (probe && launcher ? true : !probe && !launcher && ownHome()),
    async chromeRunning() {
      if (probe) {
        const code = await run(probe, 5000);
        if (code === 0) return true;
        if (code === 1) return false;
        throw new Error('chrome probe failed');
      }
      const output = await new Promise<string>((resolve, reject) =>
        execFile('/bin/ps', ['-axww', '-o', 'pid=,command='], { timeout: 5000, maxBuffer: 16 * 1024 * 1024 },
          (error, stdout) => error ? reject(error) : resolve(stdout)));
      return mainChromeRunning(output, executable);
    },
    reserveRestart(at: number, cooldownMs: number) {
      try {
        const saved = JSON.parse(fs.readFileSync(restartPath, 'utf8'));
        if (!Number.isFinite(saved.at) || at - saved.at < cooldownMs) return false;
      } catch (error) { if (!isRecord(error) || error.code !== 'ENOENT') return false; }
      fs.writeFileSync(restartPath + '.tmp', JSON.stringify({ at }), { mode: 0o600 });
      fs.renameSync(restartPath + '.tmp', restartPath);
      return true;
    },
    async quit() {
      // Test brokers must never quit the normal Chrome profile, even with a fake launcher.
      if (probe || launcher || !ownHome()) throw new Error('graceful quit requires the owner broker');
      const code = await run(['/usr/bin/osascript', '-e', 'quit app "Google Chrome"'], 20000);
      if (code !== 0) throw new Error('Chrome refused graceful quit');
    },
    async launch() {
      // -g: reopen in the background; --restore-last-session reopens the tabs he had. `open` passes
      // --args only to a NEW instance, so a Chrome that is somehow running is merely brought forward.
      const code = await run(launcher ?? ['/usr/bin/open', '-g', '-a', app, '--args', '--restore-last-session'], 20000);
      if (code !== 0) throw new Error(`chrome launcher exited ${code}`);
    },
  };
}
