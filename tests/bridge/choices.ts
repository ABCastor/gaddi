import type { BrowserContext } from 'playwright-core';
import type { FakeDaemon } from './fake-daemon.ts';
import assert from 'node:assert/strict';
import { callsFor } from './extension-types.ts';
import { waitFor } from './fake-daemon.ts';

declare global { interface Window { acted?: number } }

// SELECT-CHOICE, COMMIT-CHOICES and KEY-CHOICE in a real page: the extension reports the option a value picks, the
// choices a button or Enter sends, and what a key on the focused element could pick or press. The broker judges these
// (tests/gates/choice-gates.test.sh); here the facts themselves are held to an independent reading of the page.
export async function choiceChecks({ context, daemon, url, pass }: {
  context: BrowserContext; daemon: FakeDaemon; url: string; pass: (label: string) => void;
}) {
  const call = callsFor(daemon);
  const tab = (await call('chrome.open', { url: `${url}choices.html`, group: '● Choices · tests' })).id;
  const page = await waitFor(() => context.pages().find(candidate => candidate.url().includes('choices.html')), 'choices fixture');
  await page.waitForLoadState('load');
  const describe = (selector: string, extra: Record<string, unknown> = {}) => call('chrome.describe', { tab, selector, ...extra });
  const focused = () => call('chrome.describe', { tab, selector: ':focus' });

  // The option a value picks, with its group's label, and the select's own name.
  const del = await describe('#action', { value: 'del' });
  assert.deepEqual(del.chosen, ['Delete all'], 'ASSERT_SELECT_FACTS: the option the value picks');
  assert.equal(del.name, 'Account action', 'ASSERT_SELECT_FACTS: the select is named by its label');
  assert.deepEqual((await describe('#action', { value: 'old' })).chosen, ['files older than a year', 'Delete'],
    'ASSERT_SELECT_FACTS: an option in a group carries the group label');
  assert.deepEqual((await describe('#action', { value: 'missing' })).chosen, [], 'ASSERT_SELECT_FACTS: no such option picks nothing');
  pass('select facts: the option a value picks, its group and the list name');

  // A Save button sends the choices that are on in its form, whoever turned them on; another form's stay out.
  assert.deepEqual((await describe('#save')).committed, ['Keep everything', 'Pay Monthly Mobile', 'Choose…'],
    'ASSERT_COMMIT_FACTS: the form default choices');
  await page.evaluate(() => { document.querySelector<HTMLInputElement>('#purge')!.checked = true; });
  assert.deepEqual((await describe('#save')).committed, ['Delete files older than a month', 'Pay Monthly Mobile', 'Choose…'],
    'ASSERT_COMMIT_FACTS: a choice turned on without a click is still sent');
  assert.deepEqual((await describe('#other-save')).committed, ['Remove my old backups'], 'ASSERT_COMMIT_FACTS: each form its own');
  assert.deepEqual((await describe('#menu')).committed, ['Remove watermark', 'Keep plan'],
    'ASSERT_COMMIT_FACTS: a button outside any form sends the page choices outside forms, ARIA ones included');
  assert.equal((await describe('#purge')).committed, null, 'ASSERT_COMMIT_FACTS: a radio is not a button');
  pass('commit facts: a button sends what is on in its form, or on the page outside forms');

  // What a key can reach from the focus: every enabled option of a select, a radio group, the item a list points at.
  await page.focus('#action');
  const onSelect = await focused();
  assert.deepEqual(onSelect.keyChoices, ['Choose…', 'Delete all', 'files older than a year', 'Delete', 'Account action'],
    'ASSERT_KEY_FACTS: a letter or arrow can pick any enabled option of a focused select');
  await page.focus('#keep');
  assert.deepEqual((await focused()).keyChoices, ['Keep everything', 'Delete files older than a month'],
    'ASSERT_KEY_FACTS: arrows move a radio through its group');
  await page.focus('#list');
  assert.deepEqual((await focused()).keyChoices, ['Archive', 'Elimina tutto'], 'ASSERT_KEY_FACTS: a list that keeps the focus');
  await page.focus('#save');
  const onSave = await focused();
  assert.equal(onSave.spaceName, 'Save', 'ASSERT_KEY_FACTS: Space presses the focused button');
  assert.deepEqual(onSave.spaceCommits, ['Delete files older than a month', 'Pay Monthly Mobile', 'Choose…'], 'ASSERT_KEY_FACTS: and sends its form');
  await page.focus('#note');
  const onNote = await focused();
  assert.equal(onNote.spaceName, '', 'ASSERT_KEY_FACTS: Space in a text field types a space');
  assert.deepEqual(onNote.enterCommits, ['Delete files older than a month', 'Pay Monthly Mobile', 'Choose…'],
    'ASSERT_KEY_FACTS: Enter in a field submits its form');
  pass('key facts: options, radio groups, active items and the buttons Space and Enter press');
  // KEY-SHORTCUT reads the focus's tag and role: with nothing focused it is the body, which is no field; a text input
  // and an editable region are textboxes.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const none = await focused();
  assert.deepEqual([none.tag, none.role], ['body', ''], 'ASSERT_SHORTCUT_FACTS: nothing focused is the body');
  for (const [selector, tag] of [['#note', 'input'], ['#editor', 'div']]) {
    await page.focus(selector);
    const field = await focused();
    assert.deepEqual([field.tag, field.role], [tag, 'textbox'], `ASSERT_SHORTCUT_FACTS: ${selector} is a text field`);
  }
  pass('shortcut facts: no focus is the body, a text input and an editable region are textboxes');

  // The select is set only while the page still shows the option the gate judged.
  const acting = await describe('#acting', { value: 'close' });
  assert.deepEqual(acting.chosen, ['Close account']);
  const refused = await daemon.request('chrome.select', { tab, selector: '#acting', value: 'close',
    checkedDescription: { name: 'Plan change', href: '', chosen: ['Keep plan'] } });
  assert.match(refused.error?.message || '', /changed since it was checked/, 'ASSERT_SELECT_BOUND: a different option is refused');
  assert.equal(await page.evaluate(() => window.acted ?? 0), 0, 'ASSERT_SELECT_BOUND: the page saw no change');
  await call('chrome.select', { tab, selector: '#acting', value: 'close', checkedDescription: { name: 'Plan change', href: '', chosen: ['Close account'] } });
  assert.equal(await page.evaluate(() => window.acted ?? 0), 1, 'ASSERT_SELECT_BOUND: the judged option is set once');
  pass('select binding: the judged option or nothing');
  await call('chrome.close', { tabs: [tab] });
}
