import crypto from 'node:crypto';
import type { SigninResult } from '../shared/protocol.ts';
import { PASSWORD_UNAVAILABLE } from './signin.ts';

// OWNER-NEEDED: a sign-in that hands back `needs_you` because only the owner can act (a security key, a passkey, a
// phone prompt, a code, a challenge the helper does not answer, a locked 1Password) tells the owner directly instead of
// only telling the agent. Invariants:
// - The event carries the tab, the site's origin, a step from a closed list and a reason from a fixed table. Never a
//   URL path or query, a username, an item title, page text or any secret: nothing the agent or the page wrote.
// - One notice per tab and step while it is live, so an agent polling signin cannot repeat the banner.
// - A notice is never consent or success. Clicking it only shows the tab (the same path as browser_show); dismissing
//   it does nothing at all. The agent's next signin or look judges the real page.
// - A notice ends when its tab closes, its agent's session ends, the same tab later reports signed_in, Chrome
//   reattaches (tab numbers may be reused), or after its lifetime. Ordinary background work never makes one.
export interface OwnerNotice { id: string; tab: number; origin: string; step: string; reason: string; expiresAt: string }
type Live = OwnerNotice & { session?: string; expires: number };

// The only reasons a notice can carry, keyed by the sign-in result's own reason. Anything else (an approval card that
// already asks, a form Gaddi could not fill, a changed page) is the agent's to handle and makes no notice.
const REASONS: Record<string, string> = {
  [PASSWORD_UNAVAILABLE]: '1Password is locked or unreachable',
  'Additional verification required': 'a verification step needs you (security key, passkey, code or puzzle)',
  'Sign-in not confirmed': 'finish signing in (security key, passkey or phone)',
  'Password form unavailable': 'finish signing in (security key, passkey or phone)',
  'One-time code required': 'a one-time code is needed',
  'No supported login form': 'sign in yourself on this page',
};
const STEPS = new Set(['probe', 'credentials', 'username', 'password', 'complete', 'otp', '1password']);

/** The fixed reason a sign-in result asks the owner for, or undefined when it needs nothing from them. */
export function ownerReason(result: SigninResult): string | undefined {
  if (result.outcome !== 'needs_you' || result.step === 'approval' || result.step === 'submit') return undefined;
  const reason = result.reason ?? '';
  // A creation that 1Password could not save adds advice after the fixed sentence; it is still a 1Password step.
  return Object.hasOwn(REASONS, reason) ? REASONS[reason] : reason.startsWith(PASSWORD_UNAVAILABLE) ? REASONS[PASSWORD_UNAVAILABLE] : undefined;
}

export function createOwnerNotices({ emit, ttlMs = 10 * 60_000, limit = 20, now = Date.now }: {
  emit: (event: string, data: unknown) => void; ttlMs?: number; limit?: number; now?: () => number;
}) {
  const live = new Map<string, Live>();
  const timers = new Map<string, NodeJS.Timeout>();
  const publicNotice = ({ id, tab, origin, step, reason, expiresAt }: Live): OwnerNotice => ({ id, tab, origin, step, reason, expiresAt });
  function end(id: string, why: string) {
    const notice = live.get(id);
    if (!notice) return;
    live.delete(id);
    clearTimeout(timers.get(id)); timers.delete(id);
    emit('owner.withdrawn', { id, tab: notice.tab, why });
  }
  function sweep() { for (const [id, notice] of live) if (notice.expires <= now()) end(id, 'expired'); }
  /** After a sign-in call: notice the owner, withdraw on signed_in, or do nothing. Returns the notice emitted, if any. */
  function signin(tab: number, result: SigninResult, session?: string): OwnerNotice | undefined {
    sweep();
    if (result.outcome === 'signed_in') { for (const [id, notice] of live) if (notice.tab === tab) end(id, 'signed_in'); return undefined; }
    const reason = ownerReason(result);
    let origin: string | undefined;
    try { origin = new URL(result.site).origin; } catch { origin = undefined; }
    // Only an origin the card would show: http(s), no path, query or credentials.
    if (!reason || !origin || origin !== result.site || !/^https?:\/\//.test(origin) || !Number.isSafeInteger(tab) || tab < 0) return undefined;
    const step = result.step && STEPS.has(result.step) ? result.step : 'signin';
    // Rate limit: a live notice for this tab and step already asks; repeating it would only spam the owner.
    for (const notice of live.values()) if (notice.tab === tab && notice.step === step) return undefined;
    if (live.size >= limit) end(live.keys().next().value!, 'replaced');
    const expires = now() + ttlMs;
    const notice: Live = { id: `own-${crypto.randomUUID()}`, tab, origin, step, reason, expiresAt: new Date(expires).toISOString(), expires,
      ...(session ? { session } : {}) };
    live.set(notice.id, notice);
    const timer = setTimeout(() => end(notice.id, 'expired'), ttlMs);
    timer.unref();
    timers.set(notice.id, timer);
    emit('owner.needed', publicNotice(notice));
    return publicNotice(notice);
  }
  return {
    signin,
    /** The notice the owner clicked, while it is still live. */
    get(id: unknown) { sweep(); return typeof id === 'string' ? live.get(id) : undefined; },
    list() { sweep(); return [...live.values()].map(publicNotice); },
    closed(tabs: Iterable<unknown>) { const gone = new Set(tabs); for (const [id, notice] of live) if (gone.has(notice.tab)) end(id, 'closed'); },
    /** Every tab still open in Chrome; any notice for another tab is withdrawn. */
    present(tabs: Iterable<unknown>) { const open = new Set(tabs); for (const [id, notice] of live) if (!open.has(notice.tab)) end(id, 'gone'); },
    sessionEnded(session: string) { for (const [id, notice] of live) if (notice.session === session) end(id, 'session-ended'); },
    reattached() { for (const id of [...live.keys()]) end(id, 'reattached'); },
    size() { return live.size; },
    stop() { for (const timer of timers.values()) clearTimeout(timer); timers.clear(); },
  };
}
