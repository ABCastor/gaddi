import { isRecord } from '../shared/protocol.ts';
import type { SelfHeal } from '../shared/protocol.ts';

export type RecoveryReason = 'native-disconnect' | 'broker-unresponsive' | 'broker-requested';
export type { SelfHeal } from '../shared/protocol.ts';
interface RecoveryState { failures: number; reloadTimes: number[]; lastSelfHeal?: SelfHeal }
export const RECOVERY_KEY = 'gaddiBridgeRecovery';
export const RELOAD_COOLDOWN_MS = 10 * 60 * 1000;
const RELOAD_WINDOW_MS = 60 * 60 * 1000;
const MAX_RELOADS = 3, FAILURES_BEFORE_RELOAD = 5;

function readState(value: unknown): RecoveryState {
  if (!isRecord(value)) return { failures: 0, reloadTimes: [] };
  const last = value.lastSelfHeal;
  return {
    failures: typeof value.failures === 'number' && Number.isSafeInteger(value.failures) ? Math.max(0, Math.min(value.failures, FAILURES_BEFORE_RELOAD)) : 0,
    reloadTimes: Array.isArray(value.reloadTimes) ? value.reloadTimes.filter((at): at is number => typeof at === 'number' && Number.isFinite(at) && at > 0).slice(-MAX_RELOADS) : [],
    ...(isRecord(last) && typeof last.at === 'number' && Number.isFinite(last.at)
      && ['native-disconnect', 'broker-unresponsive', 'broker-requested'].includes(String(last.reason))
      && ['reconnect', 'reload'].includes(String(last.action))
      ? { lastSelfHeal: { at: last.at, reason: last.reason as RecoveryReason, action: last.action as SelfHeal['action'] } } : {}),
  };
}

// Reload history is persisted BEFORE runtime.reload, so worker replacement cannot
// reset its allowance. A storage failure closes only the reload path; reconnects continue.
export function createRecovery({ load, save, reload, now = Date.now, later = (fn: () => void) => setTimeout(fn, 250) }: {
  load(): Promise<unknown>; save(value: RecoveryState): Promise<void>; reload(): void;
  now?: () => number; later?: (fn: () => void) => unknown;
}) {
  let state: RecoveryState = { failures: 0, reloadTimes: [] }, readable = false, scheduled = false;
  let failedReason: RecoveryReason | undefined;
  const ready = load().then(value => { state = readState(value); readable = true; }).catch(() => {});
  let queue: Promise<unknown> = ready;
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const result = queue.then(work);
    queue = result.catch(() => {});
    return result;
  }
  async function ensureReadable() {
    if (readable) return true;
    try {
      const previous = readState(await load());
      const lastSelfHeal = !state.lastSelfHeal || (previous.lastSelfHeal?.at ?? 0) > state.lastSelfHeal.at
        ? previous.lastSelfHeal : state.lastSelfHeal;
      // Live health/failure transitions are authoritative. Reload history alone
      // needs merging after a storage failure; stale persisted failures must not
      // resurrect a counter already reset by a successful broker roundtrip.
      state = { failures: state.failures,
        reloadTimes: [...new Set([...previous.reloadTimes, ...state.reloadTimes])].sort((a, b) => a - b).slice(-MAX_RELOADS),
        ...(lastSelfHeal ? { lastSelfHeal } : {}) };
      readable = true;
      return true;
    } catch { return false; }
  }
  async function persist() {
    // A readable=false default is UNKNOWN history, never an empty allowance.
    // Chrome can reject get while set succeeds; do not erase the prior budget.
    if (!await ensureReadable()) return false;
    try { await save(structuredClone(state)); return true; }
    catch { readable = false; return false; }
  }
  async function selfReload(reason: RecoveryReason, check: () => void = () => {}) {
    if (scheduled) return { scheduled: false, reason: 'reload already scheduled' };
    if (!await ensureReadable()) return { scheduled: false, reason: 'recovery storage unavailable' };
    check();
    const at = now();
    state.reloadTimes = state.reloadTimes.filter(time => time > at - RELOAD_WINDOW_MS);
    if (state.reloadTimes.some(time => at - time < RELOAD_COOLDOWN_MS) || state.reloadTimes.length >= MAX_RELOADS)
      return { scheduled: false, reason: 'self-reload rate limit' };
    state.reloadTimes.push(at);
    state.lastSelfHeal = { at, reason, action: 'reload' };
    if (!await persist()) return { scheduled: false, reason: 'recovery storage unavailable' };
    check();
    scheduled = true;
    // Leave time for the native reply to reach the broker. No action is replayed.
    later(() => {
      try { check(); reload(); }
      catch { scheduled = false; /* The requesting transport or deadline has expired. */ }
    });
    return { scheduled: true };
  }
  return {
    ready,
    lastSelfHeal: () => state.lastSelfHeal,
    requestSelfReload: (reason: RecoveryReason = 'broker-requested', check: () => void = () => {}) => serial(() => selfReload(reason, check)),
    failed: (reason: RecoveryReason) => serial(async () => {
      failedReason = reason;
      state.failures = Math.min(FAILURES_BEFORE_RELOAD, state.failures + 1);
      await persist();
      if (state.failures >= FAILURES_BEFORE_RELOAD) await selfReload(reason);
    }),
    healthy: () => serial(async () => {
      if (!state.failures && !failedReason) return;
      // Keep the reload marker across worker replacement; otherwise record the
      // successful automatic reconnect, with fixed codes rather than page data.
      if (failedReason && !scheduled) state.lastSelfHeal = { at: now(), reason: failedReason, action: 'reconnect' };
      state.failures = 0; failedReason = undefined;
      await persist();
    }),
  };
}
