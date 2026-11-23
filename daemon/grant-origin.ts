// daemon/grant-origin.ts — GRANT-ORIGIN: what a site-scoped permission covers, said exactly on its card.
//
// Invariants (checked by ASSERT_GRANT_ORIGIN_HINT and ASSERT_GRANT_NO_WIDENING in tests/fixtures/broker-checks.ts):
//  1. Display only. The covered scope is computed from the same exact origin and path prefix the broker enforces
//     (grants.ts covers, policy.ts zoneSite/uploadSite/sendRule, signin.ts signinSite); nothing here decides anything,
//     and nothing here is signed, so it can only explain a request, never widen what an approval allows.
//  2. Every site-scoped grant covers one exact origin (scheme, host, port): a sibling subdomain or the parent domain is
//     another site and gets its own card. The hint names the siblings the agent was plausibly working on, so the owner
//     is not surprised later; it never names a form value, a path query or anything but hosts.
import { registrable } from './signin.ts';

export interface CoverView { covers: string[]; hint?: string }

const parse = (text: string) => { try { return new URL(text); } catch { return undefined; } };
// `https://app.example.com` or `https://app.example.com/settings`: the exact scope, scheme and port included.
export function coverLabel(origin: string, path = '/') { return origin + (path === '/' ? '' : path); }

// The one plain line for the card: "Covers only app.example.com; www.example.com is not included." Only hosts that
// share the covered host's registrable domain (public suffix list) and differ from it count; at most two are named.
export function originHint(covered: readonly string[], nearby: readonly string[]): string | undefined {
  const origins = new Set(covered.map(text => parse(text)?.origin).filter((origin): origin is string => !!origin));
  const lines: string[] = [];
  for (const origin of origins) {
    const own = parse(origin)!;
    const domain = registrable(own.hostname);
    if (!domain) continue;
    const siblings = [...new Set(nearby.map(parse).filter((url): url is URL => !!url && /^https?:$/.test(url.protocol)
      && url.hostname !== own.hostname && !origins.has(url.origin) && registrable(url.hostname) === domain).map(url => url.host))];
    if (!siblings.length) continue;
    const named = siblings.length <= 2 ? siblings.join(' and ') : `${siblings.slice(0, 2).join(', ')} and ${siblings.length - 2} more`;
    lines.push(`Covers only ${own.host}; ${named} ${siblings.length === 1 ? 'is' : 'are'} not included.`);
  }
  return lines.length ? lines.join(' ') : undefined;
}

export function coverView(covers: readonly string[], nearby: readonly string[]): CoverView | undefined {
  const exact = [...new Set(covers)].filter(Boolean);
  if (!exact.length) return undefined;
  const hint = originHint(exact, nearby);
  return { covers: exact, ...(hint ? { hint } : {}) };
}
