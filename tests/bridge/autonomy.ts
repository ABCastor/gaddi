// The production isolated-world function, with a bounded DOM double. Real
// trusted-input coverage also lives in native-input.ts for the browser runner.
import assert from 'node:assert/strict';
import { pageTask } from '../../extension/content.ts';

class FakeElement {
  attributes: Record<string, string> = {};
  children: FakeElement[] = [];
  parentElement: FakeElement | null = null;
  shadowRoot: FakeRoot | null = null;
  isConnected = true;
  isContentEditable = false;
  type = '';
  value = '';
  tabIndex = -1;
  disabled = false;
  readOnly = false;
  onclick: (() => void) | null = null;
  style = { display: 'block', visibility: 'visible', cursor: 'auto', position: 'static', zIndex: 'auto' };
  ownText = '';
  start = 0;
  end = 0;
  removed = false;
  tagName: string;
  constructor(tagName = 'DIV') { this.tagName = tagName; }
  get textContent(): string { return this.ownText + this.children.map(c => c.textContent).join(''); }
  get childNodes(): FakeElement[] { return [...(this.ownText ? [new FakeText(this.ownText)] : []), ...this.children]; }
  get lastChild(): FakeElement | null { return this.childNodes.at(-1) ?? null; }
  get previousSibling(): FakeElement | null { const siblings = this.parentElement?.children || []; return siblings[siblings.indexOf(this) - 1] ?? null; }
  get nodeType() { return 1; }
  getAttribute(key: string) { return this.attributes[key] ?? null; }
  hasAttribute(key: string) { return key in this.attributes; }
  removeAttribute(key: string) { delete this.attributes[key]; }
  getRootNode(): FakeRoot { return documentDouble; }
  append(child: FakeElement) { child.parentElement = this; this.children.push(child); return child; }
  insertBefore(child: FakeElement, before: FakeElement | null) {
    child.parentElement = this; this.children.splice(before ? this.children.indexOf(before) : this.children.length, 0, child); return child;
  }
  matches(selector: string): boolean {
    return selector.split(',').some(part => {
      const s = part.trim();
      if (s === '*') return true;
      if (s === ':disabled') return this.disabled;
      if (s.startsWith('#')) return this.attributes.id === s.slice(1);
      const match = s.match(/^([a-z]+)?(?:\[([^=\]]+)(?:="([^"]*)")?\])?$/i);
      return !!match && (!match[1] || match[1].toUpperCase() === this.tagName)
        && (!match[2] || this.hasAttribute(match[2]) && (match[3] === undefined || this.attributes[match[2]] === match[3]));
    });
  }
  closest(selector: string): FakeElement | null {
    for (let current: FakeElement | null = this; current; current = current.parentElement) if (current.matches(selector)) return current;
    return null;
  }
  getClientRects() { return this.style.display === 'none' ? [] : [this.getBoundingClientRect()]; }
  getBoundingClientRect() { return { x: 10, y: 10, left: 10, top: 10, right: 160, bottom: 40, width: 150, height: 30 }; }
  scrollIntoView() {}
  focus() { documentDouble.activeElement = this; }
  select() { this.start = 0; this.end = this.value.length; }
  setSelectionRange(start: number, end: number) {
    if (['email', 'number'].includes(this.type)) throw new Error('InvalidStateError');
    this.start = start; this.end = end;
  }
  contains(node: FakeElement): boolean { return this === node || this.children.some(child => child.contains(node)); }
  remove() {
    this.removed = true; this.isConnected = false;
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this);
  }
}
class FakeHTMLElement extends FakeElement {}
class FakeText extends FakeElement {
  constructor(text: string) { super('#text'); this.ownText = text; }
  get nodeType() { return 3; }
  get childNodes(): FakeElement[] { return []; }
}
class FakeRoot {
  elements: FakeElement[] = [];
  querySelectorAll(selector: string) { return this.elements.filter(el => el.isConnected && el.matches(selector)); }
}
const documentDouble = Object.assign(new FakeRoot(), {
  body: new FakeHTMLElement('BODY'), title: 'Autonomy fixture', activeElement: null as FakeElement | null,
  documentElement: { scrollHeight: 1000 }, elementFromPoint: () => documentDouble.activeElement,
  getElementsByTagName: (selector: string) => documentDouble.querySelectorAll(selector),
  getSelection: () => ({ removeAllRanges() { selectedRange = undefined; }, addRange(value: typeof range) { selectedRange = value; } }),
  createRange: () => range,
  createTextNode: (text: string) => new FakeText(text),
  createElement: (tag: string) => new FakeHTMLElement(tag.toUpperCase()),
});
let selectedRange: typeof range | undefined;
const range = { target: null as FakeElement | null, collapsed: false,
  selectNodeContents(el: FakeElement) { this.target = el; this.collapsed = (el.nodeType === 3 ? el.textContent.length : el.childNodes.length) === 0; },
  collapse(toStart: boolean) { assert.equal(toStart, false); this.collapsed = true; },
};
let shadowCalls = 0;
let styleCalls = 0;
Object.assign(globalThis, { document: documentDouble, HTMLElement: FakeHTMLElement, Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 },
  location: { href: 'https://fixture.test/setup' }, scrollX: 0, scrollY: 0, innerWidth: 800, innerHeight: 600,
  getComputedStyle: (el: FakeElement) => { styleCalls++; return el.style; },
  chrome: { runtime: { id: 'gaddi' }, dom: { openOrClosedShadowRoot(el: FakeElement) {
    shadowCalls++;
    if (!(el instanceof FakeHTMLElement)) throw new Error('Chrome requires HTMLElement');
    if (el.attributes.id === 'poison') throw new Error('One inaccessible host');
    return el.attributes.id === 'closed-host' ? closedRoot : el.shadowRoot;
  } } },
});
const closedRoot = new FakeRoot();
function setup(elements: FakeElement[]) {
  globalThis.__gaddiElements = undefined;
  documentDouble.elements = elements;
  documentDouble.activeElement = null;
  selectedRange = undefined;
}
const wantedCase = process.argv[2];
async function test(name: string, fn: () => Promise<void>) {
  if (wantedCase && name !== wantedCase) return;
  await fn(); console.log(`PASS ${name}`);
}

await test('ASSERT_SHADOW_ISOLATION', async () => {
  const svg = new FakeElement('svg'), math = new FakeElement('math');
  const poison = new FakeHTMLElement(); poison.attributes.id = 'poison';
  const host = new FakeHTMLElement(); host.attributes.id = 'closed-host';
  const frame = new FakeHTMLElement('IFRAME'); Object.assign(frame, { src: 'chrome-extension://password-manager/menu.html' });
  const own = new FakeHTMLElement('IFRAME'); Object.assign(own, { src: 'chrome-extension://gaddi/page.html' });
  const page = new FakeHTMLElement('IFRAME'); Object.assign(page, { src: 'https://fixture.test/embed' });
  const nested = new FakeHTMLElement('IFRAME'); Object.assign(nested, { src: 'chrome-extension://password-manager/nested.html' });
  closedRoot.elements = [nested];
  setup([svg, math, poison, host, frame, own, page]); shadowCalls = 0;
  const result = await pageTask('closeForeignFrames');
  assert.equal(result.__gaddiError, undefined, 'ASSERT_SHADOW_ISOLATION');
  assert.equal(result.closed, 2, 'ASSERT_SHADOW_ISOLATION');
  assert.equal(shadowCalls, 4, 'ASSERT_SHADOW_ISOLATION: SVG/MathML never reach chrome.dom');
  assert.ok(frame.removed && nested.removed && !host.removed && !own.removed && !page.removed, 'ASSERT_SHADOW_ISOLATION');
  assert.equal((await pageTask('closeForeignFrames')).closed, 0, 'ASSERT_SHADOW_ISOLATION: repeated actions stay usable');
});

await test('ASSERT_APPEND_PRESERVES_CHIP', async () => {
  const editable = new FakeHTMLElement(); editable.isContentEditable = true; editable.attributes.id = 'composer';
  const chip = editable.append(new FakeHTMLElement('SPAN')); chip.ownText = '@plugin'; chip.attributes.contenteditable = 'false';
  setup([editable, chip]);
  const focused = await pageTask('typeFocus', { selector: '#composer', text: ' wake up', mode: 'append' });
  assert.equal(focused.__gaddiError, undefined, 'ASSERT_APPEND_PRESERVES_CHIP');
  assert.equal(selectedRange?.collapsed, true, 'ASSERT_APPEND_PRESERVES_CHIP');
  const anchor = editable.lastChild;
  assert.equal(anchor?.nodeType, 3, 'ASSERT_APPEND_PRESERVES_CHIP: caret is in editable text after the chip');
  assert.equal(selectedRange?.target, anchor, 'ASSERT_APPEND_PRESERVES_CHIP: chip contents are outside the caret');
  assert.equal(focused.expectedText, '@plugin wake up', 'ASSERT_APPEND_PRESERVES_CHIP');
  documentDouble.getSelection().removeAllRanges(); // Native focus emulation can reset the prepared selection.
  assert.equal((await pageTask('typeCheck', { selector: focused.selector, mode: 'append' })).__gaddiError, undefined, 'ASSERT_APPEND_PRESERVES_CHIP');
  assert.equal(selectedRange?.target, anchor, 'ASSERT_APPEND_PRESERVES_CHIP: recheck restores the same text anchor');
  assert.equal(selectedRange?.collapsed, true, 'ASSERT_APPEND_PRESERVES_CHIP: recheck does not select the chip');
  // Trusted insertion replaces a range or appends at a collapsed text caret.
  const inserted = anchor!; inserted.ownText = (selectedRange?.collapsed ? inserted.ownText : '') + ' wake up';
  assert.ok(editable.children.includes(chip), 'ASSERT_APPEND_PRESERVES_CHIP');
  assert.equal(editable.textContent, '@plugin wake up', 'ASSERT_APPEND_PRESERVES_CHIP');
  assert.equal((await pageTask('typeLanded', { selector: focused.selector, text: focused.expectedText })).landed, true, 'ASSERT_APPEND_PRESERVES_CHIP');
  await pageTask('typeFocus', { selector: focused.selector, mode: 'append', text: ' again' });
  assert.equal(selectedRange?.target, anchor, 'ASSERT_APPEND_PRESERVES_CHIP: repeated append reuses the text node');
  inserted.ownText = (selectedRange?.collapsed ? inserted.ownText : '') + ' again';
  assert.equal(editable.textContent, '@plugin wake up again', 'ASSERT_APPEND_PRESERVES_CHIP');
  documentDouble.activeElement = chip;
  documentDouble.getSelection().removeAllRanges();
  assert.match((await pageTask('typeCheck', { selector: focused.selector, mode: 'append' })).__gaddiError!, /focus moved/, 'ASSERT_APPEND_PRESERVES_CHIP');
  assert.equal(Boolean(selectedRange), false, 'ASSERT_APPEND_PRESERVES_CHIP: moved focus refuses before selecting');
  for (const trailingBreak of [false, true]) {
    const editor = new FakeHTMLElement(); editor.isContentEditable = true; editor.attributes.id = 'nested';
    const paragraph = editor.append(new FakeHTMLElement('P')); paragraph.isContentEditable = true;
    const mention = paragraph.append(new FakeHTMLElement('SPAN')); mention.ownText = '@plugin';
    const br = trailingBreak ? paragraph.append(new FakeHTMLElement('BR')) : null;
    if (br) br.isContentEditable = true;
    setup([editor, paragraph, mention, ...(br ? [br] : [])]);
    await pageTask('typeFocus', { selector: '#nested', mode: 'append', text: '' });
    const text: FakeElement | undefined = selectedRange?.target;
    assert.equal(text?.nodeType, 3, 'ASSERT_APPEND_PRESERVES_CHIP: nested caret uses text');
    assert.equal(text?.parentElement, paragraph, 'ASSERT_APPEND_PRESERVES_CHIP: stays in the final editable block');
    assert.deepEqual(paragraph.children, [mention, text, ...(br ? [br] : [])], 'ASSERT_APPEND_PRESERVES_CHIP: text follows chip and precedes trailing break');
    await pageTask('typeCheck', { selector: '#nested', mode: 'append' });
    assert.equal(selectedRange?.target, text, 'ASSERT_APPEND_PRESERVES_CHIP: recheck creates no duplicate text node');
    assert.equal(editor.textContent, '@plugin', 'ASSERT_APPEND_PRESERVES_CHIP: empty append adds no text');
  }
  for (const tag of ['INPUT', 'TEXTAREA']) {
    const field = new FakeHTMLElement(tag); field.type = 'text'; field.value = 'existing'; field.attributes.id = 'field';
    setup([field]);
    assert.equal((await pageTask('typeFocus', { selector: '#field', mode: 'append', text: ' extra' })).__gaddiError, undefined, 'ASSERT_APPEND_PRESERVES_CHIP');
    field.value = field.value.slice(0, field.start) + ' extra' + field.value.slice(field.end);
    assert.equal(field.value, 'existing extra', 'ASSERT_APPEND_PRESERVES_CHIP');
    await pageTask('typeFocus', { selector: '#field', text: 'replacement' });
    assert.deepEqual([field.start, field.end], [0, field.value.length], 'ASSERT_APPEND_PRESERVES_CHIP: replace remains default');
  }
  for (const type of ['email', 'number']) {
    const field = new FakeHTMLElement('INPUT'); field.type = type; field.value = type === 'number' ? '12' : 'user'; field.attributes.id = 'field';
    setup([field]);
    const result = await pageTask('typeFocus', { selector: '#field', mode: 'append', text: '3' });
    assert.equal(result.__gaddiError, undefined, 'ASSERT_APPEND_NATIVE_END');
    assert.equal(result.appendNeedsEnd, true, 'ASSERT_APPEND_NATIVE_END');
  }
  setup([editable, chip, inserted]);
  await pageTask('typeFocus', { selector: '#composer', text: '' });
  assert.equal(selectedRange?.collapsed, false, 'ASSERT_APPEND_PRESERVES_CHIP: rich replacement remains default');
  assert.match((await pageTask('typeFocus', { selector: '#composer', mode: 'invalid' as 'append' })).__gaddiError!, /mode/, 'ASSERT_APPEND_PRESERVES_CHIP');
});

await test('ASSERT_APPEND_LAYOUT_CLEANUP', async () => {
  for (const initial of ['', 'nowrap']) {
    const editor = new FakeHTMLElement(); editor.isContentEditable = true; editor.attributes.id = 'composer';
    const chip = editor.append(new FakeHTMLElement('SPAN')); chip.ownText = '@plugin';
    let whitespace = initial, priority = initial ? 'important' : '';
    if (initial) editor.attributes.style = `white-space: ${initial} !important`;
    const style = Object.assign(editor.style, {
      whiteSpace: initial || 'normal',
      getPropertyValue: () => whitespace, getPropertyPriority: () => priority,
      setProperty(_key: string, value: string, nextPriority: string) { whitespace = value; priority = nextPriority; this.whiteSpace = value; },
      removeProperty() { whitespace = ''; priority = ''; this.whiteSpace = 'normal'; },
    });
    Object.defineProperty(style, 'length', { get: () => whitespace ? 1 : 0 });
    setup([editor, chip]);
    const focused = await pageTask('typeFocus', { selector: '#composer', mode: 'append' });
    const anchor = selectedRange?.target;
    await pageTask('typeCheck', { selector: '#composer', mode: 'append', appendCleanup: focused.appendCleanup });
    assert.deepEqual(editor.children.map(child => child.tagName), ['SPAN', 'BR', '#text'], 'ASSERT_APPEND_LAYOUT_CLEANUP: native caret gets a temporary break');
    assert.deepEqual([whitespace, priority], ['pre-wrap', 'important'], 'ASSERT_APPEND_LAYOUT_CLEANUP: preserve literal spaces');
    assert.equal(selectedRange?.target, anchor, 'ASSERT_APPEND_LAYOUT_CLEANUP: chip stays outside the caret');
    await pageTask('typeCleanup', { appendCleanup: 'expired-owner' });
    assert.equal(whitespace, 'pre-wrap', 'ASSERT_APPEND_LAYOUT_CLEANUP: an expired owner cannot restore a successor');
    await pageTask('typeCleanup', { appendCleanup: focused.appendCleanup }); // Also used when trusted insertion fails.
    assert.deepEqual(editor.children, [chip, anchor], 'ASSERT_APPEND_LAYOUT_CLEANUP: remove only our break');
    assert.deepEqual([whitespace, priority], [initial, initial ? 'important' : ''], 'ASSERT_APPEND_LAYOUT_CLEANUP: restore original CSS');
    assert.equal(editor.hasAttribute('style'), !!initial, 'ASSERT_APPEND_LAYOUT_CLEANUP: restore absent style attribute');
    await pageTask('typeCleanup');
    assert.equal(editor.textContent, '@plugin', 'ASSERT_APPEND_LAYOUT_CLEANUP: cleanup is idempotent and inserts no text');
  }
});

await test('ASSERT_FLOATING_MENU_REFS', async () => {
  const popper = new FakeHTMLElement(); popper.attributes['data-radix-popper-content-wrapper'] = '';
  const item = popper.append(new FakeHTMLElement()); item.style.cursor = 'pointer';
  const label = item.append(new FakeHTMLElement('SPAN')); label.ownText = 'ChatGPT plugin'; label.style.cursor = 'pointer';
  const hidden = popper.append(new FakeHTMLElement()); hidden.ownText = 'Hidden suggestion'; hidden.style.cursor = 'pointer'; hidden.style.display = 'none';
  const noise = new FakeHTMLElement(); noise.ownText = 'Outside floating layer'; noise.style.cursor = 'pointer';
  const floating = new FakeHTMLElement(); floating.style.position = 'absolute'; floating.style.zIndex = '50';
  const suggestion = floating.append(new FakeHTMLElement()); suggestion.ownText = 'Add connector'; suggestion.onclick = () => {};
  const listbox = new FakeHTMLElement(); listbox.attributes.role = 'listbox';
  const option = listbox.append(new FakeHTMLElement()); option.ownText = 'Second plugin'; option.style.cursor = 'pointer';
  setup([popper, item, label, hidden, noise, floating, suggestion, listbox, option]);
  const result = await pageTask('read');
  assert.equal(result.__gaddiError, undefined, 'ASSERT_FLOATING_MENU_REFS');
  const rows = result.outline!.split('\n');
  const pluginRow = rows.filter(line => line.includes('ChatGPT plugin'));
  assert.equal(pluginRow.length, 1, 'ASSERT_FLOATING_MENU_REFS');
  assert.ok(rows.some(line => line.startsWith('button "Add connector"')), 'ASSERT_FLOATING_MENU_REFS');
  assert.ok(rows.some(line => line.startsWith('option "Second plugin"')), 'ASSERT_FLOATING_MENU_REFS');
  assert.ok(!result.outline!.includes('Hidden suggestion') && !result.outline!.includes('Outside floating layer'), 'ASSERT_FLOATING_MENU_REFS');
  assert.ok(rows.length <= 4 && result.outline!.length < 500, 'ASSERT_FLOATING_MENU_REFS: outline stays bounded');
  const ref = pluginRow[0].split(' ').at(-1)!;
  assert.match(ref, /^@/, 'ASSERT_FLOATING_MENU_REFS');
  documentDouble.elementFromPoint = () => label;
  assert.equal((await pageTask('describe', { selector: ref })).name, 'ChatGPT plugin', 'ASSERT_FLOATING_MENU_REFS');
  assert.equal((await pageTask('clickPoint', { selector: ref })).__gaddiError, undefined, 'ASSERT_FLOATING_MENU_REFS');
  item.remove();
  assert.match((await pageTask('describe', { selector: ref })).__gaddiError!, /Stale selector/, 'ASSERT_FLOATING_MENU_REFS');
  const wrapper = new FakeHTMLElement(); wrapper.style.cursor = 'pointer'; popper.children = []; popper.append(wrapper);
  const first = wrapper.append(new FakeHTMLElement()); first.ownText = 'First plugin'; first.style.cursor = 'pointer';
  const second = wrapper.append(new FakeHTMLElement()); second.ownText = 'Second plugin'; second.style.cursor = 'pointer';
  setup([popper, wrapper, first, second]);
  const nested = (await pageTask('read')).outline!;
  assert.match(nested, /button "First plugin" @/, 'ASSERT_MENU_NESTED_WRAPPER');
  assert.match(nested, /button "Second plugin" @/, 'ASSERT_MENU_NESTED_WRAPPER');
  assert.equal(nested.split('\n').length, 2, 'ASSERT_MENU_NESTED_WRAPPER');
  const outer = new FakeHTMLElement(); outer.style.cursor = 'pointer'; popper.children = []; popper.append(outer); outer.append(wrapper);
  setup([popper, outer, wrapper, first, second]);
  const deep = (await pageTask('read')).outline!;
  assert.match(deep, /button "First plugin" @/, 'ASSERT_MENU_DEEP_WRAPPER');
  assert.match(deep, /button "Second plugin" @/, 'ASSERT_MENU_DEEP_WRAPPER');
  assert.equal(deep.split('\n').length, 2, 'ASSERT_MENU_DEEP_WRAPPER');
  const rich = new FakeHTMLElement(); rich.style.cursor = 'pointer'; rich.onclick = () => {}; popper.children = []; popper.append(rich);
  const title = rich.append(new FakeHTMLElement()); title.ownText = 'Title'; title.style.cursor = 'pointer';
  const description = rich.append(new FakeHTMLElement()); description.ownText = 'Description'; description.style.cursor = 'pointer';
  setup([popper, rich, title, description]);
  const composite = (await pageTask('read')).outline!;
  assert.equal(composite.split('\n').length, 1, 'ASSERT_MENU_COMPOSITE_ITEM');
  assert.match(composite, /button "Title Description" @/, 'ASSERT_MENU_COMPOSITE_ITEM');
  const large = new FakeHTMLElement(); large.style.cursor = 'pointer'; popper.children = []; popper.append(large);
  const items = Array.from({ length: 200 }, (_, i) => { const child = large.append(new FakeHTMLElement()); child.ownText = `Choice ${i}`; child.style.cursor = 'pointer'; return child; });
  setup([popper, large, ...items]); styleCalls = 0;
  const many = (await pageTask('read')).outline!;
  assert.equal(many.split('\n').length, items.length, 'ASSERT_MENU_LINEAR_WORK');
  assert.ok(styleCalls < 10000, `ASSERT_MENU_LINEAR_WORK: ${styleCalls} style reads for 200 items`);
});
console.log('== autonomy DOM regressions: 0 failures');
