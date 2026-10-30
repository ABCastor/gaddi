import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Fake-only: no Chrome, no `open`, no ps. Every dependency of the recovery state machine is a stand-in.
// GADDI_HEAL_MUTATION=<name> runs the same assertions against a copy with one guard removed.
const repo = path.resolve(import.meta.dirname, '../..');
const MUTATIONS: Record<string, [string, string]> = {
  running: ['if (running) {', 'if (false) {'],
  ratelimit: ['if (last !== undefined && (at - last < limits.cooldownMs || relaunches.length >= limits.maxRelaunches))', 'if (false)'],
  once: ['if (notified === incident) return;', ''],
  probe: ['catch { return owner(`Gaddi cannot tell whether Chrome is running.', 'catch { running = false; } if (false) { return owner(`Gaddi cannot tell whether Chrome is running.'],
  singleflight: ['inflight ??= recover()', 'inflight = recover()'],
  profile: ['--(?:type|user-data-dir|headless)', '--(?:type|headless)'],
  bounded: ['if (await wait(limits.relaunchWaitMs)) {', 'while (!await wait(limits.relaunchWaitMs)); {'],
};
let source = path.join(repo, 'daemon/chrome-heal.ts');
const mutation = process.env.GADDI_HEAL_MUTATION;
if (mutation) {
  const [marker, replacement] = MUTATIONS[mutation] ?? assert.fail(`unknown mutation ${mutation}`);
  const dir = fs.mkdtempSync(path.join(repo, 'tests/.state/heal-mutant-'));
  for (const sub of ['daemon', 'shared']) fs.mkdirSync(path.join(dir, sub));
  fs.copyFileSync(path.join(repo, 'shared/protocol.ts'), path.join(dir, 'shared/protocol.ts'));
  const text = fs.readFileSync(source, 'utf8');
  assert.equal(text.split(marker).length, 2, `mutation point ${mutation}`);
  source = path.join(dir, 'daemon/chrome-heal.ts');
  fs.writeFileSync(source, text.replace(marker, replacement));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
}
const { createChromeHeal, mainChromeRunning } = await import(pathToFileURL(source).href) as typeof import('../../daemon/chrome-heal.ts');

let passed = 0;
const pass = (label: string) => { passed++; console.log(`PASS ${label}`); };
const limits = { extensionWaitMs: 150, relaunchWaitMs: 300, cooldownMs: 10 * 60 * 1000, windowMs: 60 * 60 * 1000,
  maxRelaunches: 3, ownerRecheckMs: 2 * 60 * 1000, reportedWaitMs: 20, pollMs: 10, maxPollMs: 40 };

function world(opts: { running?: boolean; probeFails?: boolean; attachAfterLaunchMs?: number | null; tabs?: number } = {}) {
  const w = {
    connected: false, running: opts.running ?? false, launches: 0, probes: 0, notices: [] as string[], skew: 0,
    heal: undefined as unknown as ReturnType<typeof createChromeHeal>,
  };
  w.heal = createChromeHeal({
    connected: () => w.connected,
    async chromeRunning() { w.probes++; if (opts.probeFails) throw new Error('ps unavailable'); return w.running; },
    async launch() {
      w.launches++; w.running = true;
      const after = opts.attachAfterLaunchMs === undefined ? 20 : opts.attachAfterLaunchMs;
      if (after !== null) setTimeout(() => { w.connected = true; w.heal.attached(); }, after);
    },
    tabCount: async () => opts.tabs ?? 4,
    notify: text => { w.notices.push(text); },
    now: () => Date.now() + w.skew,
    limits,
  });
  return w;
}
const crash = (w: ReturnType<typeof world>) => { w.connected = false; w.running = false; };

// 1. Chrome gone: one relaunch, bounded wait, a clear note for the agent, one banner for the owner.
{
  const w = world({ tabs: 7 });
  const note = await w.heal.ensure();
  assert.equal(w.launches, 1, 'ASSERT_HEAL_RELAUNCH one launch');
  assert.match(String(note), /reopened it with your profile and last session; 7 tabs open again/, 'ASSERT_HEAL_RELAUNCH note');
  assert.equal(w.notices.length, 1, 'ASSERT_HEAL_ONCE one banner for the relaunch');
  assert.equal(w.heal.status().state, 'connected');
  assert.equal(w.heal.status().lastRecovery?.action, 'relaunch');
  assert.equal(await w.heal.ensure(), undefined, 'connected bridge needs no recovery');
  pass('stopped Chrome is reopened once, agent gets the recovery note, owner one banner');
}

// 2. Chrome running, extension away: never launch; wait for its own reconnect.
{
  const w = world({ running: true });
  setTimeout(() => { w.connected = true; w.heal.attached(); }, 30);
  const note = await w.heal.ensure();
  assert.equal(w.launches, 0, 'ASSERT_HEAL_RUNNING never launches a running Chrome');
  assert.match(String(note), /extension reconnected/);
  assert.equal(w.notices.length, 0, 'routine extension reconnect is not news');
  pass('running Chrome: existing extension reconnect awaited, nothing launched');
}

// 3. Chrome running, extension never returns: exact owner instruction, still no launch, one banner.
{
  const w = world({ running: true });
  const started = Date.now();
  await assert.rejects(w.heal.ensure(), /chrome bridge not connected: Chrome is open but the Gaddi extension is not connected\. Open chrome:\/\/extensions.*press Reload/);
  assert.ok(Date.now() - started < limits.extensionWaitMs + 500, 'extension wait is bounded');
  assert.equal(w.launches, 0, 'ASSERT_HEAL_RUNNING no launch when extension is the problem');
  const fast = Date.now();
  await assert.rejects(w.heal.ensure(), /press Reload/);
  assert.ok(Date.now() - fast < limits.extensionWaitMs, 'a reported incident answers fast, not a full wait per call');
  w.skew += limits.ownerRecheckMs + 1000;
  await assert.rejects(w.heal.ensure(), /press Reload/, 'rechecked after the quiet period');
  assert.equal(w.launches, 0);
  assert.equal(w.notices.length, 1, 'ASSERT_HEAL_ONCE one banner per incident, even after a recheck');
  assert.equal(w.heal.status().state, 'needs-owner');
  assert.match(String(w.heal.status().message), /press Reload/);
  w.connected = true; w.heal.attached();
  assert.equal(w.heal.status().state, 'connected', 'owner fix ends the incident');
  pass('running Chrome with dead extension: exact click instruction, one banner, no launch');
}

// 4. Rate limit: a second stop within the cooldown is NOT relaunched; the hourly cap holds after cooldowns.
{
  const w = world();
  await w.heal.ensure();
  crash(w);
  await assert.rejects(w.heal.ensure(), /already reopened it at .* will not reopen it again so soon/, 'ASSERT_HEAL_RATELIMIT second stop inside the cooldown is refused');
  assert.equal(w.launches, 1, 'ASSERT_HEAL_RATELIMIT no relaunch inside the cooldown');
  assert.equal(w.notices.length, 2, 'new incident, one new banner');
  for (let n = 0; n < 3; n++) { w.skew += limits.cooldownMs + 1000; crash(w); try { await w.heal.ensure(); } catch { /* counted below */ } }
  assert.ok(w.launches <= 3, 'ASSERT_HEAL_RATELIMIT at most three relaunches an hour');
  pass('relaunch rate limit: cooldown and hourly cap hold, never a loop');
}

// 5. Launch that never brings the extension back: bounded, then exact instruction; no second launch.
{
  const w = world({ attachAfterLaunchMs: null });
  const started = Date.now();
  const outcome = await Promise.race([
    w.heal.ensure().then(() => 'resolved', error => String(error)),
    new Promise(resolve => setTimeout(() => resolve('unbounded'), limits.relaunchWaitMs * 4)),
  ]);
  assert.notEqual(outcome, 'unbounded', 'ASSERT_HEAL_BOUNDED relaunch wait is bounded');
  assert.match(String(outcome), /Gaddi reopened Chrome but the Gaddi extension has not connected\. Open chrome:\/\/extensions/);
  assert.ok(Date.now() - started < limits.relaunchWaitMs + 500);
  await assert.rejects(w.heal.ensure());
  assert.equal(w.launches, 1, 'ASSERT_HEAL_RATELIMIT failed relaunch is not retried');
  assert.equal(w.notices.length, 1, 'ASSERT_HEAL_ONCE');
  pass('relaunch without extension: bounded wait, exact instruction, no retry loop');
}

// 6. Unknown Chrome state: never launch blind.
{
  const w = world({ probeFails: true });
  await assert.rejects(w.heal.ensure(), /cannot tell whether Chrome is running/, 'ASSERT_HEAL_PROBE unknown state is reported, not acted on');
  assert.equal(w.launches, 0, 'ASSERT_HEAL_PROBE no launch when the probe fails');
  pass('probe failure: no blind launch, owner told');
}

// 7. Concurrent calls share one recovery.
{
  const w = world();
  const notes = await Promise.allSettled([w.heal.ensure(), w.heal.ensure(), w.heal.ensure()]);
  assert.equal(w.launches, 1, 'ASSERT_HEAL_SINGLEFLIGHT concurrent calls launch Chrome once');
  assert.ok(notes.every(note => note.status === 'fulfilled' && /reopened/.test(String(note.value))),
    'ASSERT_HEAL_SINGLEFLIGHT every waiting call gets the shared recovery, none a rate-limit error');
  pass('concurrent agent calls: one shared recovery');
}

// 8. Status while disconnected and nobody has asked yet.
{
  const w = world();
  assert.equal(w.heal.status().state, 'disconnected');
  assert.match(String(w.heal.status().message), /next browser call checks Chrome/);
  assert.equal(w.launches, 0, 'status never launches');
  pass('status reports a waiting disconnect without acting');
}

// 9. The production probe sees only his everyday Chrome, never agents' disposable ones or helpers.
{
  const exe = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const disposable = `  101 ${exe} --remote-debugging-pipe --user-data-dir=/var/folders/x/T/playwright_chromiumdev_profile-1 about:blank`;
  const helper = `  102 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Helpers/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper --type=renderer`;
  const headless = `  103 ${exe} --headless=new about:blank`;
  assert.equal(mainChromeRunning([disposable, helper, headless].join('\n'), exe), false, 'ASSERT_HEAL_PROFILE disposable Chromes are not his Chrome');
  assert.equal(mainChromeRunning(`  100 ${exe}\n${disposable}`, exe), true);
  assert.equal(mainChromeRunning(`  100 ${exe} --restore-last-session`, exe), true);
  assert.equal(mainChromeRunning('  100 /Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary', exe), false);
  pass('probe: his Chrome found; disposable, headless and helper processes ignored');
}

console.log(`== chrome heal: ${passed} passed, 0 failed`);
