import type { BrowserContext, Page, Worker } from 'playwright-core';
import type { Protocol } from '../../node_modules/playwright-core/types/protocol.d.ts';
import type { FakeDaemon } from './fake-daemon.ts';
import assert from 'node:assert/strict';
import { waitFor } from './fake-daemon.ts';

declare global {
  var __gaddiRestartProbe: {
    started: { api: string; at: number }[];
    release(): void;
  };
}

// Only prepended to the disposable test extension. Real Chrome APIs run once;
// their results are withheld to reproduce slow startup without blocking timers.
export const restartInstrumentation = `
globalThis.__gaddiRestartProbe = { started: [], release() {} };
{
  const releases = [], restores = [];
  for (const [namespace, method] of [['tabGroups','query'], ['tabs','get'], ['bookmarks','getTree']]) {
    const original = chrome[namespace][method].bind(chrome[namespace]);
    restores.push(() => { chrome[namespace][method] = original; });
    chrome[namespace][method] = (...args) => {
      globalThis.__gaddiRestartProbe.started.push({api: namespace + '.' + method, at: Date.now()});
      const result = original(...args);
      return new Promise((resolve, reject) => {
        releases.push(() => result.then(resolve, reject));
        result.catch(() => {});
      });
    };
  }
  globalThis.__gaddiRestartProbe.release = () => {
    restores.forEach(restore => restore());
    releases.splice(0).forEach(release => release());
  };
}
`;

export async function restartDeadline({ context, worker, daemon, page, url, id, pass }: {
  context: BrowserContext; worker: Worker; daemon: FakeDaemon; page: Page;
  url: string; id: string; pass: (label: string) => void;
}) {
  const tab = await worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)!.id!, url);
  const before = await worker.evaluate(async () => (await chrome.tabs.query({})).map(tab => tab.id));
  const control = await context.newCDPSession(page);
  const versions = new Map<string, Protocol.ServiceWorker.ServiceWorkerVersion>();
  control.on('ServiceWorker.workerVersionUpdated', ({ versions: updates }) => {
    for (const version of updates) versions.set(version.versionId, version);
  });
  await control.send('ServiceWorker.enable');
  const version = await waitFor(() => [...versions.values()].find(v => v.scriptURL === worker.url()), 'worker version');
  await control.send('ServiceWorker.stopWorker', { versionId: version.versionId });
  await waitFor(() => versions.get(version.versionId)?.runningStatus === 'stopped' && !daemon.peer, 'worker and host stopped');
  await assert.rejects(daemon.request('chrome.click', { tab, selector: '#pay' }), /Bridge not attached/);
  pass('command during worker downtime is rejected without replay');

  const commands = [
    ['chrome.tabs', {}], ['chrome.bookmarks', {}], ['chrome.describe', { tab, selector: '#pay' }],
    ['chrome.goto', { tab, url: url + 'next.html' }],
    ['chrome.click', { tab, selector: '#pay' }], ['chrome.open', { url, group: '● Deadline · tests' }],
    ['chrome.group', { tabs: [tab], group: '● Queued deadline · tests' }],
  ] as const;
  let started = 0;
  let results: Promise<{ method: string; elapsed: number; reply: Awaited<ReturnType<FakeDaemon['request']>> }[]> | undefined;
  const trace = daemon.trace.bind(daemon);
  // Send in the very turn that accepts bridge.attach, before waiting for a worker
  // debugger target. No readiness sleep can hide the first-command path.
  daemon.trace = (event, peer, detail) => {
    trace(event, peer, detail);
    if (event === 'attach') queueMicrotask(() => {
      started = Date.now();
      results = Promise.all(commands.map(async ([method, params]) => {
        const reply = await daemon.request(method, params, 29000);
        return { method, elapsed: Date.now() - started, reply };
      }));
      results.catch(() => {});
    });
  };
  try {
    await control.send('ServiceWorker.startWorker', { scopeURL: `chrome-extension://${id}/` });
    await waitFor(() => !!results, 'requests sent at reattach');
    worker = await waitFor(() => context.serviceWorkers().find(w => w.url().startsWith(`chrome-extension://${id}/`)), 'new worker');
    await waitFor(async () => (await worker.evaluate(() => globalThis.__gaddiRestartProbe.started)).length >= 6, 'startup APIs entered');
    const checkpoints = await worker.evaluate(() => globalThis.__gaddiRestartProbe.started);
    const replies = await results!;
    for (const { method, elapsed, reply } of replies) {
      console.log(`MEASURE restart ${method}: first API +${checkpoints[0].at - started}ms, reply ${elapsed}ms`);
      assert.match(reply.error?.message || '', /within 25 seconds/, 'ASSERT_RESTART_REQUEST_DEADLINE');
      assert.ok(elapsed >= 24000 && elapsed < 27000, `ASSERT_RESTART_REPLY_BEFORE_HOST: ${method} ${elapsed}ms`);
    }
    pass('first commands after worker restart share a 25-second deadline across lookup and group queues');

    await worker.evaluate(() => globalThis.__gaddiRestartProbe.release());
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.deepEqual(await worker.evaluate(async () => (await chrome.tabs.query({})).map(tab => tab.id)), before);
    assert.equal(page.url(), url, 'expired goto never navigates after lookup returns');
    assert.equal(await page.evaluate(() => window.events.filter(event => event.type === 'click').length), 0, 'expired click never runs');
    assert.equal(await worker.evaluate(async id => (await chrome.tabs.get(id)).groupId, tab), -1, 'expired group never runs');
    for (const { reply } of replies) assert.equal(daemon.responses.filter(r => r.id === reply.id).length, 1, 'one reply per request');
    assert.ok((await daemon.request('chrome.tabs')).result, 'fresh request succeeds after late API results');
    pass('late results cause no click, navigation, tab creation, grouping or duplicate reply; fresh work succeeds');
  } finally {
    daemon.trace = trace;
    await control.detach();
  }
}
