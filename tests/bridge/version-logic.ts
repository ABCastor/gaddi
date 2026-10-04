import assert from 'node:assert/strict';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { pageTask } from '../../extension/content.ts';
import type { ChromeParams, PageResult } from '../../shared/protocol.ts';

// These doubles check digest inputs and refusal before page side effects. The
// real fixture checks trusted events through the native bridge separately.
function fixture() {
  class Control {
    tagName: string; value = ''; disabled = false; isConnected = true;
    childNodes: object[] = []; labels: object[] = []; tabIndex = 0;
    attributes = new Map<string, string>();
    constructor(tag: string) { this.tagName = tag; }
    get type() { return this.attributes.get('type') || (this.tagName === 'INPUT' ? 'text' : ''); }
    get href() { return this.attributes.get('href') || ''; }
    getAttribute(key: string) { return this.attributes.get(key) ?? null; }
    hasAttribute(key: string) { return this.attributes.has(key); }
    getRootNode() { return document; }
    getClientRects() { return [{}]; }
    getBoundingClientRect() { return { left: 0, top: 0, right: 100, bottom: 30 }; }
    closest() { return null; }
    matches(selector: string) { return selector === ':disabled' ? this.disabled : selector === 'a[href]' && this.tagName === 'A' && this.hasAttribute('href'); }
    scrollIntoView() { effects++; }
    focus() { effects++; document.activeElement = this; }
    select() { effects++; }
  }
  let effects = 0, queries: string[] = [];
  const button = new Control('BUTTON'), link = new Control('A'), input = new Control('INPUT');
  link.attributes.set('href', 'https://fixture.test/next');
  const nodes = [button, link, input];
  const document = {
    title: 'Fixture', body: { innerText: 'Ticker 1', textContent: 'Ticker 1' },
    activeElement: null as Control | null,
    documentElement: { scrollHeight: 1000 },
    getElementsByTagName() { return nodes; },
    elementFromPoint() { return button; },
    querySelectorAll(selector: string) {
      queries.push(selector);
      if (selector === '*') return nodes;
      if (selector === '#button') return [button];
      if (selector === '#field') return [input];
      return nodes.filter(el => el.tagName === 'INPUT' ? selector.includes('input')
        : el.tagName === 'BUTTON' ? selector.split(',').some(s => s.trim() === 'button') : selector.includes('a[href]'));
    },
  };
  const world = vm.createContext({ document, crypto, location: { href: 'https://fixture.test/' }, performance: { timeOrigin: 100 },
    scrollX: 0, scrollY: 0, innerWidth: 800, innerHeight: 600,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }), Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 } });
  const call = (action: string, params: ChromeParams = {}): Promise<PageResult> => {
    world.args = [action, params];
    return vm.runInContext(`(${pageTask.toString()})(...args)`, world);
  };
  const look = async () => {
    const result = await call('read');
    assert.equal(result.__gaddiError, undefined);
    assert.match(result.version!, /^v1-\d+$/);
    return result.version!;
  };
  return { call, look, world, document, nodes, button, input, link, Control,
    effects: () => effects, queries: () => queries, resetQueries: () => { queries = []; } };
}

export async function versionLogic(pass: (name: string) => void) {
  const failures: string[] = [];
  async function check(name: string, test: (f: ReturnType<typeof fixture>) => Promise<void>) {
    try { await test(fixture()); pass(name); }
    catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error}`); }
  }
  await check('ASSERT_VERSION_ACCEPT', async f => {
    const version = await f.look(), result = await f.call('clickPoint', { selector: '#button', version });
    assert.equal(result.__gaddiError, undefined); assert.equal(result.x, 50); assert.equal(f.effects(), 1);
  });
  await check('ASSERT_VERSION_INSERT', async f => {
    const version = await f.look(); f.nodes.push(new f.Control('BUTTON'));
    const result = await f.call('clickPoint', { selector: '#button', version });
    assert.equal(result.__gaddiCode, 'stale'); assert.equal(result.__gaddiError, 'the page changed since you looked');
    assert.equal(f.effects(), 0);
  });
  await check('ASSERT_VERSION_REMOVE', async f => {
    const version = await f.look(); f.nodes.splice(f.nodes.indexOf(f.link), 1);
    assert.notEqual(await f.look(), version);
  });
  await check('ASSERT_VERSION_TYPING', async f => {
    const version = await f.look(); f.input.value = 'typed'; assert.equal(await f.look(), version);
  });
  await check('ASSERT_VERSION_SCROLL', async f => {
    const version = await f.look(); f.world.scrollY = 400; assert.equal(await f.look(), version);
  });
  await check('ASSERT_VERSION_FOCUS', async f => {
    const version = await f.look(); f.document.activeElement = f.input; assert.equal(await f.look(), version);
  });
  await check('ASSERT_VERSION_TEXT', async f => {
    const version = await f.look(); f.document.body.innerText = f.document.body.textContent = 'Ticker 2'; assert.equal(await f.look(), version);
  });
  await check('ASSERT_VERSION_RELOAD', async f => {
    // Keep the exact element-reference state: timeOrigin must do the work.
    const version = await f.look(); f.world.performance.timeOrigin++; assert.notEqual(await f.look(), version);
  });
  await check('ASSERT_VERSION_NAVIGATION', async f => {
    const version = await f.look(); f.world.location.href += '#next'; assert.notEqual(await f.look(), version);
  });
  await check('ASSERT_VERSION_OPTIONAL', async f => {
    await f.look(); f.nodes.push(new f.Control('BUTTON')); f.resetQueries();
    for (const version of [undefined, '']) {
      const result = await f.call('clickPoint', { selector: '#button', version });
      assert.equal(result.__gaddiError, undefined); assert.equal(result.x, 50);
    }
    assert.equal(f.effects(), 2);
    assert.ok(!f.queries().some(q => q.includes('a[href]')), 'unguarded action does not compute a version');
  });
  await check('ASSERT_VERSION_ORDER', async f => {
    const second = new f.Control('BUTTON'); f.nodes.push(second); const version = await f.look();
    f.nodes[0] = second; f.nodes[f.nodes.length - 1] = f.button; assert.notEqual(await f.look(), version);
  });
  await check('ASSERT_VERSION_DESCRIBE', async f => {
    const version = await f.look(), selector = (await f.call('describe', { selector: '#button' })).selector;
    f.button.isConnected = false; f.nodes.splice(f.nodes.indexOf(f.button), 1);
    const result = await f.call('describe', { selector, version });
    assert.equal(result.__gaddiCode, 'stale'); assert.equal(result.__gaddiError, 'the page changed since you looked');
  });
  await check('ASSERT_VERSION_ATTRIBUTES', async f => {
    for (const change of [() => { f.input.attributes.set('type', 'email'); },
      () => { f.link.attributes.set('href', 'https://fixture.test/other'); }, () => { f.button.disabled = true; },
      () => { f.input.tagName = 'TEXTAREA'; }]) {
      const version = await f.look(); change(); assert.notEqual(await f.look(), version);
    }
  });
  if (failures.length) throw new Error(`Version assertions failed: ${failures.join(', ')}`);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await versionLogic(name => console.log(`PASS ${name}`));
