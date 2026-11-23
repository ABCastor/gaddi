#!/usr/bin/env bash
# OWNER-NEEDED with a fake op and a fake bridge: no browser, no real login, no real 1Password.
# The pristine run must pass; then each mutation breaks ONE rule in a disposable copy of the broker, and the check
# that guards that rule must turn red BY NAME.
set -euo pipefail
cd "$(dirname "$0")/../.."
node tests/signin/owner-needed.test.ts
mkdir -p tests/.state/logs
COPY=$(mktemp -d tests/.state/owner-needed-XXXXXX)
trap 'rm -rf "$COPY"' EXIT # Disposable mutation sources only.
cp -R daemon shared policy "$COPY/"
for mutation in NOTICE RATE SIGNED_IN CLOSE GONE SESSION EXPIRY REATTACH LEAK QUIET SHOW_ENDED; do
  for source in daemon/*.ts; do cp "$source" "$COPY/$source"; done
  node --input-type=module - "$COPY" "$mutation" >"$COPY/expect.txt" <<'NODE'
import fs from 'node:fs';
import assert from 'node:assert/strict';
const [root, name] = process.argv.slice(2);
// [assertion that must go red, [file, text that must occur exactly once, replacement]...]
const table = {
  NOTICE: ['ASSERT_OWNER_NEEDED_EMITTED', ['daemon/daemon.ts', ' ownerNotices.signin(resolvedTab, result, grantSession(params));', '']],
  RATE: ['ASSERT_OWNER_RATE_LIMIT', ['daemon/owner-needed.ts', 'if (notice.tab === tab && notice.step === step) return undefined;', 'void notice;']],
  SIGNED_IN: ['ASSERT_OWNER_WITHDRAW_SIGNED_IN', ['daemon/owner-needed.ts', "if (notice.tab === tab) end(id, 'signed_in');", 'void id;']],
  CLOSE: ['ASSERT_OWNER_WITHDRAW_CLOSED', ['daemon/daemon.ts', '  ownerNotices.closed(tabs);\n', '']],
  GONE: ['ASSERT_OWNER_WITHDRAW_GONE', ['daemon/daemon.ts', "try { ownerNotices.present(tabList(await bridge.request('chrome.tabs', { browser: policy.browser })).map(tabId)); }", 'try { void 0; }']],
  SESSION: ['ASSERT_OWNER_WITHDRAW_SESSION', ['daemon/daemon.ts', '  ownerNotices.sessionEnded(key);\n', '']],
  EXPIRY: ['ASSERT_OWNER_EXPIRES', ['daemon/owner-needed.ts', "const timer = setTimeout(() => end(notice.id, 'expired'), ttlMs);", 'const timer = setTimeout(() => {}, ttlMs);'],
    ['daemon/owner-needed.ts', "function sweep() { for (const [id, notice] of live) if (notice.expires <= now()) end(id, 'expired'); }", 'function sweep() {}']],
  REATTACH: ['ASSERT_OWNER_WITHDRAW_REATTACH', ['daemon/daemon.ts', '    ownerNotices.reattached();\n', '']],
  LEAK: ['ASSERT_OWNER_NO_LEAK', ['daemon/owner-needed.ts', "emit('owner.needed', publicNotice(notice));", "emit('owner.needed', { ...publicNotice(notice), detail: result });"]],
  QUIET: ['ASSERT_OWNER_QUIET', ['daemon/owner-needed.ts', "if (result.outcome !== 'needs_you' || result.step === 'approval' || result.step === 'submit') return undefined;", "if (result.outcome === 'signed_in') return undefined;"],
    ['daemon/owner-needed.ts', ': reason.startsWith(PASSWORD_UNAVAILABLE) ? REASONS[PASSWORD_UNAVAILABLE] : undefined;', ": 'needs you';"]],
  SHOW_ENDED: ['ASSERT_OWNER_SHOW_ENDED', ['daemon/owner-needed.ts', "get(id: unknown) { sweep(); return typeof id === 'string' ? live.get(id) : undefined; },",
    "get(id: unknown) { sweep(); return typeof id === 'string' ? live.get(id) ?? { tab: 7 } as Live : undefined; },"]],
};
const [assertion, ...edits] = table[name] ?? assert.fail(`unknown mutation ${name}`);
for (const [file, from, to] of edits) {
  const target = `${root}/${file}`, source = fs.readFileSync(target, 'utf8');
  assert.equal(source.split(from).length, 2, `${name}: mutation point must occur once in ${file}`);
  fs.writeFileSync(target, source.replace(from, to));
}
console.log(assertion);
NODE
  assertion=$(cat "$COPY/expect.txt")
  LOG="tests/.state/logs/owner-needed-${mutation}-falsified.log"
  if GADDI_OWNER_ROOT="$COPY" node tests/signin/owner-needed.test.ts >"$LOG" 2>&1; then
    echo "FAIL owner-needed $mutation: mutant passed"; exit 1
  fi
  if ! rg -q "AssertionError.*${assertion}" "$LOG"; then
    cat "$LOG"; echo "FAIL owner-needed $mutation: failed for an unrelated reason"; exit 1
  fi
  echo "FALSIFIED owner-needed $mutation: $assertion failed"
done
