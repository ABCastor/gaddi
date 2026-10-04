import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

// Reject a headful mutation BEFORE spawning it on the user's desktop.
export function requireHeadless(args: string[], headless = true) {
  assert.ok(headless === true && args.includes('--headless=new'),
    'ASSERT_BACKGROUND_BROWSER: refusing Chrome without new headless mode');
}

export function watchHeadless(executablePath: string, profiles: string[]) {
  let failure: unknown;
  const seen = new Set<string>();
  const check = () => {
    const rows = execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n');
    for (const row of rows) {
      const match = row.trim().match(/^(\d+)\s+(.*)$/);
      // Chrome helpers do not inherit --headless; inspect browser roots only.
      if (!match || !match[2].startsWith(executablePath + ' ')) continue;
      const profile = profiles.find(profile => (match[2] + ' ').includes(`--user-data-dir=${profile} `));
      if (!profile) continue;
      assert.match(match[2], /(?:^|\s)--headless=new(?:\s|$)/,
        `ASSERT_BACKGROUND_BROWSER: Chrome PID ${match[1]} lacks new headless mode`);
      seen.add(profile);
    }
  };
  check();
  const timer = setInterval(() => { try { check(); } catch (error) { failure ??= error; } }, 100);
  return {
    check() { if (failure) throw failure; check(); },
    stop() { clearInterval(timer); },
    verify() {
      this.check();
      assert.ok(seen.size === profiles.length, 'ASSERT_BACKGROUND_BROWSER: both browser launches must be observed');
    },
  };
}
