import assert from 'node:assert/strict';
import vm from 'node:vm';
import { pageTask } from '../../extension/content.ts';

async function deadline(source: string, completion: 'timer' | 'frame', arrives: boolean) {
  let clock = 0, sequence = 0, notify!: () => void, disconnected = false;
  let result: { met: boolean } | undefined;
  let text = 'waiting', reads = 0;
  const body = { get innerText() { reads++; return text; }, set innerText(value: string) { text = value; } };
  const timers = new Map<number, { at: number; callback: () => void }>();
  const intervals = new Map<number, () => void>(), frames = new Map<number, () => void>();
  const globals = {
    crypto, document: { body }, performance: { now: () => clock },
    MutationObserver: class {
      constructor(callback: () => void) { notify = callback; }
      observe() {}
      disconnect() { disconnected = true; }
    },
    setTimeout(callback: () => void, delay: number) { const id = ++sequence; timers.set(id, { at: clock + delay, callback }); return id; },
    clearTimeout(id: number) { timers.delete(id); },
    setInterval(callback: () => void) { const id = ++sequence; intervals.set(id, callback); return id; },
    clearInterval(id: number) { intervals.delete(id); },
    requestAnimationFrame(callback: () => void) { const id = ++sequence; frames.set(id, callback); return id; },
    cancelAnimationFrame(id: number) { frames.delete(id); },
  };
  const pending = vm.runInNewContext(`(${source})('wait', { text: 'late arrival', timeout: 200 })`, globals) as Promise<{ met: boolean }>;
  void pending.then(value => { result = value; });
  if (completion === 'frame') {
    clock = 160;
    const initialReads = reads;
    for (const [id, callback] of [...frames]) { frames.delete(id); callback(); }
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(result, undefined, 'wait never finishes before its deadline');
    assert.equal(reads, initialReads, 'frame polling does not scan page text');
    assert.equal(frames.size, 1, 'one deadline frame remains scheduled');
  }
  // Populate the cache, then notify at180. The debounce is due220, after expiry.
  clock = 180;
  if (arrives) { body.innerText = 'late arrival'; notify(); }
  clock = 200;
  if (completion === 'timer') {
    const expiry = [...timers.values()].find(timer => timer.at === 200)!;
    expiry.callback();
  } else {
    // Chrome can defer every timer while frames continue under focus emulation.
    for (const [id, callback] of [...frames]) { frames.delete(id); callback(); }
  }
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(result?.met, arrives, arrives ? 'ASSERT_WAIT_FINAL_CHECK' : 'ASSERT_WAIT_BACKGROUND_DEADLINE');
  assert.equal(disconnected, true, 'wait observer cleaned');
  assert.equal(timers.size + intervals.size + frames.size, 0, 'wait callbacks cleaned');
}

const source = pageTask.toString();
await deadline(source, 'timer', true);
await deadline(source, 'frame', true);
await deadline(source, 'frame', false);
console.log('PASS wait final checks survive delayed timers and clean every callback');
const final = 'textCache = undefined; check(); finish(false);';
assert.ok(source.includes(final), 'final check mutation site');
await assert.rejects(() => deadline(source.replace(final, 'textCache = undefined; finish(false);'), 'frame', true), /ASSERT_WAIT_FINAL_CHECK/);
console.log('FALSIFIED wait final check: removing the predicate check misses a before-deadline arrival');
console.log('== wait clock: 3 passed, 0 failed; 1 mutant killed');
