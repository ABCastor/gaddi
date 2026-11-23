import type { BrowserContext, Frame } from 'playwright-core';
import type { FakeDaemon } from './fake-daemon.ts';
import type { CheckedDescription } from '../../shared/protocol.ts';
import assert from 'node:assert/strict';
import { isRecord } from '../../shared/protocol.ts';
import { callsFor } from './extension-types.ts';
import { waitFor } from './fake-daemon.ts';

declare global { interface Window { acted?: number; sent?: number; paid?: number } }
type Facts = Record<string, unknown>;

// TX-BIND and FRAME-BIND in a real page. The broker binds what describe reports (tests/gates/approval-binding.test.sh);
// here the facts themselves, and the extension's last check before it presses, are held to the page. The fake daemon
// plays the broker: it hands back, as checkedDescription, exactly the facts describe gave when the user approved.
export async function bindingChecks({ context, daemon, url, frames, pass }: {
  context: BrowserContext; daemon: FakeDaemon; url: string; frames: { first: string; second: string }; pass: (label: string) => void;
}) {
  const call = callsFor(daemon);
  const tab = (await call('chrome.open', { url: `${url}binding.html?frame=${encodeURIComponent(frames.first)}`, group: '● Binding · tests' })).id;
  const page = await waitFor(() => context.pages().find(candidate => candidate.url().includes('binding.html')), 'binding fixture');
  await page.waitForLoadState('load');
  const frameAt = (base: string) => waitFor(() => page.frames().find(frame => frame.url() === base), `payment frame ${base}`);
  await (await frameAt(frames.first)).waitForLoadState('load');
  const describe = async (params: Record<string, unknown>) => {
    const info = await daemon.call('chrome.describe', { tab, ...params });
    assert.ok(isRecord(info), 'describe returns an object');
    return info as Facts;
  };
  // A point's facts, marked as a point so `bound` adds the document it landed in.
  const describePoint = async (at: { x: number; y: number }): Promise<Facts> => ({ ...await describe({ at }), at: true });
  const acted = () => page.evaluate(() => window.acted ?? 0);
  const set = (selector: string, value: string) => page.evaluate(([s, v]) => {
    const el = document.querySelector<HTMLInputElement>(s)!;
    if ('value' in el && el.tagName !== 'DIV') el.value = v; else el.textContent = v;
  }, [selector, value] as const);
  // What the broker binds for a click, taken from describe as it is: name and destination, the choices a button sends,
  // the transaction digest and, for a point, the document it landed in.
  const bound = (d: Facts): CheckedDescription => ({ name: String(d.name), href: String(d.href),
    ...(d.committed !== undefined ? { committed: d.committed as string[] | null } : {}),
    ...(d.transaction !== undefined ? { transaction: d.transaction } : {}),
    ...(d.at ? { frame: { id: d.frameId ?? 0, origin: d.origin, document: d.documentId } } : {}) } as CheckedDescription);
  const centre = async (frame: Pick<Frame, 'locator'>, selector: string) => {
    const box = await frame.locator(selector).boundingBox();
    assert.ok(box, `${selector} has a box`);
    return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
  };

  // The exploit first. The user approved "Pay" on 10 to Alice; the amount becomes 1000 before the approved click.
  const approved = await describe({ selector: '#pay' });
  await set('#amount', '1000');
  const changed = await daemon.request('chrome.click', { tab, selector: '#pay', checkedDescription: bound(approved) });
  assert.equal(await acted(), 0, `ASSERT_TX_FINAL_CHECK: Pay was pressed after the amount changed: ${JSON.stringify(changed)}`);
  assert.match(changed.error?.message || '', /changed since it was checked/, 'ASSERT_TX_FINAL_CHECK: and the refusal says so');
  // The same through a point, and through Enter in the form.
  await set('#amount', '10');
  const payAt = await centre(page, '#pay');
  const approvedAt = await describePoint(payAt);
  await set('#recipient', 'mallory@example.test');
  const changedAt = await daemon.request('chrome.click', { tab, at: payAt, checkedDescription: bound(approvedAt) });
  assert.equal(await acted(), 0, `ASSERT_TX_FINAL_CHECK: a point click went in after the recipient changed: ${JSON.stringify(changedAt)}`);
  await set('#recipient', 'alice@example.test');
  await page.focus('#amount');
  const focused = await describe({ selector: ':focus' });
  await set('#message', 'Rent for November and December');
  const pressed = await daemon.request('chrome.press', { tab, key: 'Enter',
    checkedDescription: { ...(focused.transaction !== undefined ? { transaction: focused.transaction } : {}) } as CheckedDescription });
  assert.match(pressed.error?.message || '', /changed since it was checked/, `ASSERT_TX_FINAL_CHECK: Enter went in after the message changed: ${JSON.stringify(pressed)}`);
  await set('#message', 'Rent for November');
  // The form as approved is pressed.
  await call('chrome.click', { tab, selector: '#pay', checkedDescription: bound(approved) });
  assert.equal(await acted(), 1, 'ASSERT_TX_FINAL_CHECK: the unchanged form is pressed once');
  await call('chrome.click', { tab, at: payAt, checkedDescription: bound(approvedAt) });
  assert.equal(await acted(), 2, 'ASSERT_TX_FINAL_CHECK: and by point too');
  pass('tx final check: a changed amount, recipient or message stops the press; the approved form is pressed');

  // The digest follows each transaction detail, values never leave the page, and it is stable for the same form.
  const digest = async (selector: string) => {
    const value = (await describe({ selector })).transaction;
    assert.ok(typeof value === 'string' && /^[0-9a-f]{64}$/.test(value), `ASSERT_TX_FACTS: ${selector} has a digest: ${String(value)}`);
    return value;
  };
  const ten = await digest('#pay');
  assert.equal(ten, approved.transaction, 'ASSERT_TX_FACTS: the same form gives the same digest');
  assert.ok(!JSON.stringify(approved).match(/alice|Rent for|€10/), 'ASSERT_TX_FACTS: no value or text leaves the page');
  for (const [selector, value, back] of [['#amount', '1000', '10'], ['#recipient', 'bob@example.test', 'alice@example.test'],
    ['#message', 'Rent', 'Rent for November'], ['#total', '€1000.00', '€10.00']]) {
    await set(selector, value);
    assert.notEqual(await digest('#pay'), ten, `ASSERT_TX_FACTS: ${selector} is a transaction detail`);
    await set(selector, back);
  }
  assert.equal(await digest('#pay'), ten, 'ASSERT_TX_FACTS: back as it was');
  // A composer that is no form: its recipient and body, around the Send button.
  const mail = await digest('#send');
  for (const [selector, value, back] of [['#to', 'eve@example.test', 'bob@example.test'], ['#mail-body', 'Hello Eve', 'Hello Bob']]) {
    await set(selector, value);
    assert.notEqual(await digest('#send'), mail, `ASSERT_TX_FACTS: ${selector} of a composer is a detail of its Send`);
    await set(selector, back);
  }
  pass('tx facts: amount, recipient, message and total each change the digest; a composer outside a form is covered');

  // What ticks by itself is not the transaction: a clock, "Draft saved", a live region, a hidden token, a password.
  for (const [selector, value] of [['#page-clock', '12:00:07'], ['#saved', 'Draft saved'], ['#live', 'Saving…'], ['#form-clock', '00:07']]) {
    await page.evaluate(([s, v]) => { document.querySelector(s)!.textContent = v; }, [selector, value] as const);
  }
  await page.evaluate(() => {
    document.querySelector<HTMLInputElement>('#nonce')!.value = 'n2';
    document.querySelector<HTMLInputElement>('#pin')!.value = '9999';
  });
  assert.equal(await digest('#pay'), ten, 'ASSERT_TX_CHURN: clocks, status lines, hidden fields and passwords leave the digest alone');
  await call('chrome.click', { tab, selector: '#pay', checkedDescription: bound(approved) });
  assert.equal(await acted(), 3, 'ASSERT_TX_CHURN: so an approval is still usable on a ticking page');
  pass('tx churn: a ticking clock and "Draft saved" do not make an approval impossible');

  // FRAME-BIND. A point inside the payment frame is approved; then another site's frame takes its place, with the
  // same button at the same spot.
  const first = await frameAt(frames.first);
  const slot = await page.locator('#pay-frame').boundingBox();
  assert.ok(slot, 'the payment frame has a box');
  const frameButton = await centre(first, '#frame-pay');
  const point = { x: frameButton.x, y: frameButton.y };
  const inFirst = await describePoint(point);
  assert.equal(inFirst.name, 'Pay now', 'ASSERT_FRAME_FACTS: the point lands on the frame button');
  assert.ok(typeof inFirst.frameId === 'number' && inFirst.frameId > 0, 'ASSERT_FRAME_FACTS: inside a frame');
  assert.equal(inFirst.origin, new URL(frames.first).origin, 'ASSERT_FRAME_FACTS: the frame names its own origin');
  assert.ok(typeof inFirst.documentId === 'string' && inFirst.documentId.length > 0, 'ASSERT_FRAME_FACTS: and its document');
  await page.evaluate(src => { document.querySelector<HTMLIFrameElement>('#pay-frame')!.src = src; }, frames.second);
  const second = await frameAt(frames.second);
  await second.waitForLoadState('load');
  await waitFor(async () => (await describe({ at: point })).name === 'Pay now' || undefined, 'the other frame shows its button');
  const swapped = await daemon.request('chrome.click', { tab, at: point, checkedDescription: bound(inFirst) });
  assert.equal(await second.evaluate(() => window.paid ?? 0), 0,
    `ASSERT_FRAME_FINAL_CHECK: another site's frame at the approved point took the click: ${JSON.stringify(swapped)}`);
  assert.match(swapped.error?.message || '', /different document/, 'ASSERT_FRAME_FINAL_CHECK: and the refusal says so');
  // The same frame reloaded is a new document: still not the one approved.
  const inSecond = await describePoint(point);
  assert.equal(inSecond.origin, new URL(frames.second).origin, 'ASSERT_FRAME_FACTS: the new frame names its own origin');
  assert.notEqual(inSecond.documentId, inFirst.documentId, 'ASSERT_FRAME_FACTS: and another document');
  await second.evaluate(() => location.reload());
  const reloaded = await frameAt(frames.second);
  await reloaded.waitForLoadState('load');
  await waitFor(async () => (await describe({ at: point })).documentId !== inSecond.documentId || undefined, 'the reloaded frame');
  const stale = await daemon.request('chrome.click', { tab, at: point, checkedDescription: bound(inSecond) });
  assert.match(stale.error?.message || '', /different document/, `ASSERT_FRAME_FINAL_CHECK: a reloaded frame is refused: ${JSON.stringify(stale)}`);
  // The document as checked is clicked.
  const current = await describePoint(point);
  await call('chrome.click', { tab, at: point, checkedDescription: bound(current) });
  assert.equal(await reloaded.evaluate(() => window.paid ?? 0), 1, 'ASSERT_FRAME_FINAL_CHECK: the checked document takes the click once');
  pass('frame final check: another site\'s or a reloaded frame at the approved point gets no click; the checked one does');
  await call('chrome.close', { tabs: [tab] });
}
