import { execFile, spawn } from 'node:child_process';
import { isRecord } from '../shared/protocol.ts';

// Recovery when the Chrome bridge is down because the owner's Chrome stopped (crash or quit), or its
// extension/native host died. It runs only when an agent asks for the browser, never on its own timer,
// so a Chrome the owner quit stays closed until something needs it.
// Invariants:
// - Chrome is only ever OPENED (LaunchServices `open -a`, his normal profile, last session restored).
//   Nothing here kills, quits or signals any Chrome, and nothing passes a profile directory.
// - A relaunch happens only when the probe says Chrome is not running; if Chrome is running, the extension's
//   own reconnect is awaited and the owner is told what to click. `open -a` on a running Chrome only focuses it.
// - Relaunches are rate-limited (cooldown + hourly cap) and recorded BEFORE launching, so no failure loops.
// - The owner is told once per incident (disconnect until the next attach).
export type HealState = 'connected' | 'disconnected' | 'waiting-extension' | 'relaunching' | 'needs-owner';
export interface HealLimits {
  extensionWaitMs: number; relaunchWaitMs: number; cooldownMs: number; windowMs: number;
  maxRelaunches: number; ownerRecheckMs: number; reportedWaitMs: number; pollMs: number; maxPollMs: number;
}
export const DEFAULT_HEAL_LIMITS: HealLimits = {
  extensionWaitMs: 15000, relaunchWaitMs: 45000, cooldownMs: 10 * 60 * 1000, windowMs: 60 * 60 * 1000,
  maxRelaunches: 3, ownerRecheckMs: 2 * 60 * 1000, reportedWaitMs: 1000, pollMs: 250, maxPollMs: 2000,
};
export const OWNER_RELOAD = 'Open chrome://extensions in Chrome, find Gaddi, make sure its switch is on, and press Reload (the circular arrow).';

export interface HealDeps {
  connected(): boolean;
  chromeRunning(): Promise<boolean>;
  launch(): Promise<void>;
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
    // A self-reconnected extension is routine; a reopened Chrome is news to the owner.
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
  async function recover(): Promise<string | undefined> {
    if (state === 'connected' || state === 'disconnected') { incident++; since = now(); }
    if (state === 'needs-owner' && now() < recheckAt) {
      // Already reported: answer fast instead of making every call wait out the full budget again.
      if (await wait(limits.reportedWaitMs)) return recovered('reconnect', 'The Gaddi extension reconnected to Chrome.');
      throw new Error(`chrome bridge not connected: ${message}`);
    }
    let running: boolean;
    try { running = await deps.chromeRunning(); }
    catch { return owner(`Gaddi cannot tell whether Chrome is running. Open Google Chrome; if it is already open, ${OWNER_RELOAD.charAt(0).toLowerCase()}${OWNER_RELOAD.slice(1)}`); }
    if (running) {
      set('waiting-extension', 'Chrome is open; waiting for the Gaddi extension to reconnect.');
      if (await wait(limits.extensionWaitMs)) return recovered('reconnect', 'The Gaddi extension reconnected to Chrome.');
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
      if (deps.connected()) {
        if (state !== 'connected') set('connected');
        return Promise.resolve(undefined);
      }
      inflight ??= recover().finally(() => { inflight = undefined; });
      return inflight;
    },
    /** The bridge attached: end the incident and release anyone waiting. */
    attached() {
      // Called inside bridge.attach, before its reply is written; the native host drops any request that
      // overtakes that reply. Wake waiters on the next macrotask so their first request follows it.
      const woken = [...waiters];
      setImmediate(() => { for (const wake of woken) wake(); });
      if (!inflight && state !== 'connected') {
        if (state === 'needs-owner') lastRecovery = { at: now(), action: 'reconnect', message: 'The Gaddi extension reconnected to Chrome.' };
        set('connected');
      }
    },
    status() {
      const live = deps.connected();
      const shown: HealState = live ? 'connected' : state === 'connected' ? 'disconnected' : state;
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
  return {
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
    async launch() {
      // -g: reopen in the background; --restore-last-session reopens the tabs he had. `open` passes
      // --args only to a NEW instance, so a Chrome that is somehow running is merely brought forward.
      const code = await run(launcher ?? ['/usr/bin/open', '-g', '-a', app, '--args', '--restore-last-session'], 20000);
      if (code !== 0) throw new Error(`chrome launcher exited ${code}`);
    },
  };
}
