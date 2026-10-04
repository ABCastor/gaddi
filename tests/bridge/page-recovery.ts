import type { BrowserContext, Worker } from 'playwright-core';
import type { FakeDaemon } from './fake-daemon.ts';
import { callsFor } from './extension-types.ts';
import assert from 'node:assert/strict';
import { waitFor } from './fake-daemon.ts';

export async function pageRecovery({ context, worker, daemon, url, blockedCount, pass }: { context: BrowserContext; worker: Worker; daemon: FakeDaemon; url: string; blockedCount: () => number; pass: (label: string) => void }) {
  const call = callsFor(daemon);
  const active = (await call('chrome.active')).id;
  const fixtureURL = url.replace('127.0.0.1', 'localhost') + 'busy.html';
  const busy = await call('chrome.open', { url: fixtureURL, group: '● Recovery · tests' });
  const page = await waitFor(() => context.pages().find(page => page.url() === fixtureURL), 'recovery fixture page');
  const control = await context.newCDPSession(page);
  const before = blockedCount();
  const blocking = control.send('Runtime.evaluate', { expression: 'blockMainThread(120000)' }).catch(() => {});
  await waitFor(() => blockedCount() > before, 'renderer entered synchronous loop');

  const start = Date.now();
  const stalled = daemon.request('chrome.read', { tab: busy.id }, 29000)
    .catch(error => ({ error: { message: error.message } }));
  // These tab APIs must be usable while page work is still blocked, before its deadline.
  const groupStart = Date.now();
  await call('chrome.group', { tabs: [busy.id], group: '● Busy regroup · tests' });
  assert.ok(Date.now() - groupStart < 5000, 'group bypasses blocked page work');
  const showStart = Date.now();
  assert.equal((await call('chrome.show', { tab: busy.id })).active, true);
  assert.ok(Date.now() - showStart < 5000, 'show bypasses blocked page work');
  await call('chrome.show', { tab: active });
  const reply = await stalled;
  assert.match(reply.error?.message || '', /Chrome did not respond within 25 seconds; inspect the tab before retrying/,
    'ASSERT_BLOCKED_PAGE_DEADLINE');
  assert.ok(Date.now() - start >= 24000 && Date.now() - start < 29000, 'extension replies before the 30-second host timeout');
  pass('blocked main thread returns the 25-second page deadline; show and group bypass it');

  const again = daemon.request('chrome.read', { tab: busy.id }, 29000).catch(error => ({ error: { message: error.message } }));
  await call('chrome.tabs');
  const closeStart = Date.now();
  assert.deepEqual(await call('chrome.close', { tabs: [busy.id] }), { closed: [busy.id], failed: [] });
  assert.ok(Date.now() - closeStart < 5000, 'ASSERT_BLOCKED_PAGE_CLOSE: close bypasses a second blocked page request');
  assert.ok((await again).error);
  await blocking;
  assert.equal(daemon.responses.filter(message => message.id === ('id' in reply ? reply.id : undefined)).length, 1, 'late page completion never replies twice');
  pass('close removes the blocked tab within 5 seconds while another page request is pending');

  const frozen = await call('chrome.open', { url: fixtureURL, group: '● Recovery · tests' });
  const frozenPage = await waitFor(() => context.pages().find(page => page.url() === fixtureURL), 'frozen fixture page');
  const freezer = await context.newCDPSession(frozenPage);
  await call('chrome.eval', { tab: frozen.id, expression: 'window.recoveryMarker = "same document"' });
  for (const action of ['read', 'eval'] as const) {
    await freezer.send('Page.setWebLifecycleState', { state: 'frozen' });
    await waitFor(async () => (await worker.evaluate(id => chrome.tabs.get(id), frozen.id)).frozen === true,
      'Chrome reports the test-frozen tab');
    assert.equal((await call('chrome.tabs')).tabs.find(tab => tab.id === frozen.id)!.frozen, true);
    const response = await call(`chrome.${action}`, { tab: frozen.id, expression: 'window.recoveryMarker' });
    if (action === 'read') assert.match(('text' in response ? response.text : ''), /Recoverable page/);
    else assert.equal(('value' in response ? response.value : undefined), 'same document');
    assert.equal((await call('chrome.active')).id, active, 'wake never activates the background tab');
    assert.ok(!Object.hasOwn((await call('chrome.tabs')).tabs.find(tab => tab.id === frozen.id)!, 'frozen'));
  }
  pass('look/read and eval each wake a CDP-frozen background tab without activation or reload');
  await freezer.detach();
  await call('chrome.close', { tabs: [frozen.id] });

  const discarded = await call('chrome.open', { url: fixtureURL, group: '● Recovery · tests' });
  await worker.evaluate(id => chrome.tabs.discard(id), discarded.id);
  assert.equal((await call('chrome.tabs')).tabs.find(tab => tab.id === discarded.id)!.discarded, true);
  for (const action of ['read', 'eval'] as const) {
    const response = await daemon.request(`chrome.${action}`, { tab: discarded.id, expression: '1' });
    assert.match(response.error?.message || '', new RegExp(`Tab ${discarded.id} is discarded; reload it explicitly`));
    assert.equal((await worker.evaluate(id => chrome.tabs.get(id), discarded.id)).discarded, true);
  }
  await call('chrome.close', { tabs: [discarded.id] });
  pass('discarded tab is reported and refused by look/read and eval without silently reloading');
}
