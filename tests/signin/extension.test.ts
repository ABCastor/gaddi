import assert from 'node:assert/strict';
import { pageTask } from '../../extension/content.ts';
import type { ChromeParams, ChromeRequest, Reply, SigninProbe } from '../../shared/protocol.ts';

// Execute the production isolated-world function and native-port dispatcher.
// All DOM and Chrome objects here are fakes, with no browser or 1Password access.
const site = 'https://example.test';
const secret = 'fake-secret-for-extension-tests';
class FakeElement {
  tagName: string;
  attributes: Record<string, string>;
  type = 'text'; value = ''; disabled = false; readOnly = false; isConnected = true;
  hidden = false; form: FakeForm | null = null; selected = false;
  childNodes: { nodeType: number; textContent: string }[] = [];
  onFocus?: () => void; onSelect?: () => void;
  constructor(tag = 'INPUT', attributes: Record<string, string> = {}) {
    this.tagName = tag; this.attributes = attributes; this.type = attributes.type || 'text';
  }
  getAttribute(name: string) { return this.attributes[name] ?? null; }
  hasAttribute(name: string) { return name in this.attributes; }
  matches(selector: string) { return selector === ':disabled' && this.disabled; }
  closest(_selector: string) { return this.hidden ? this : null; }
  getClientRects() { return this.hidden ? [] : [{}]; }
  scrollIntoView() {}
  focus() { doc.activeElement = this; this.onFocus?.(); }
  select() { this.selected = true; this.onSelect?.(); }
}
class FakeForm extends FakeElement {
  elements: FakeElement[] = [];
  constructor(action = '/login') { super('FORM', { action }); }
}
let elements: FakeElement[] = [];
let doc: { activeElement: FakeElement; body: { innerText: string }; title: string; baseURI: string; querySelectorAll(selector: string): FakeElement[] };
function setup(fields: FakeElement[], text = '') {
  elements = fields;
  doc = {
    activeElement: new FakeElement('BODY'), body: { innerText: text }, title: 'Login', baseURI: `${site}/login`,
    querySelectorAll(selector: string) {
      const connected = elements.filter(el => el.isConnected);
      if (selector === '*') return connected;
      if (selector.startsWith('#')) return connected.filter(el => el.getAttribute('id') === selector.slice(1));
      if (selector === 'iframe, [id], [class]') return connected.filter(el => el.tagName === 'IFRAME' || el.hasAttribute('id') || el.hasAttribute('class'));
      return connected;
    },
  };
  Object.assign(globalThis, {
    document: doc, location: { href: `${site}/login` }, Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 },
    getComputedStyle: () => ({ visibility: 'visible', display: 'block' }),
  });
  delete globalThis.__gaddiElements;
}
function input(type: string, autocomplete?: string, name?: string) {
  return new FakeElement('INPUT', { type, ...(autocomplete ? { autocomplete } : {}), ...(name ? { name } : {}) });
}
function inForm(fields: FakeElement[], action?: string) {
  const form = new FakeForm(action);
  form.elements = fields;
  fields.forEach(field => { field.form = form; });
  setup([form, ...fields]);
  return form;
}
async function probe(): Promise<SigninProbe> {
  const result = await pageTask('signinProbe', { signin: { site } });
  assert.equal(result.__gaddiError, undefined);
  assert.equal(typeof result.url, 'string'); assert.equal(typeof result.signature, 'string');
  for (const kind of ['username', 'password', 'otp'] as const) assert.ok(result[kind] === undefined || typeof result[kind] === 'string');
  return result as SigninProbe;
}
const params = (selector: string, kind: 'username' | 'password' | 'otp'): ChromeParams => ({ selector, signin: { site, kind } });
async function refused(action: string, options: ChromeParams) {
  assert.equal((await pageTask(action, options)).__gaddiError, 'Sign-in refused');
}
let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  await fn(); passed++; console.log(`PASS ${name}`);
}

await test('probe uses hints first, ignores hidden/disabled/readonly controls and returns no values', async () => {
  const user = input('text', 'section-login username'), password = input('password', 'current-password');
  user.value = secret; password.value = secret;
  const fallback = input('email'), hidden = input('password'); hidden.hidden = true;
  const disabled = input('password'); disabled.disabled = true;
  const readonly = input('password'); readonly.readOnly = true;
  inForm([user, password, fallback, hidden, disabled, readonly]);
  const result = await probe();
  assert.ok(result.username?.startsWith('@')); assert.ok(result.password?.startsWith('@')); assert.equal(result.challenge, undefined);
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.equal(globalThis.__gaddiElements?.nodes.get(result.username!), user);
  assert.equal(globalThis.__gaddiElements?.nodes.get(result.password!), password);
});
await test('fingerprint excludes input values and changes with page shape/text', async () => {
  const password = input('password'); inForm([password]);
  const first = await probe(); password.value = secret;
  assert.equal((await probe()).signature, first.signature);
  elements[0].childNodes.push({ nodeType: 3, textContent: 'Signed in' });
  assert.notEqual((await probe()).signature, first.signature);
});
await test('generated text controls use accessible email/username names, preserving hint precedence and ambiguity', async () => {
  for (const [attribute, label] of [['placeholder', 'Email-Adresse'], ['aria-label', 'E-Mail-Adresse'], ['title', 'Email address'], ['placeholder', 'User name']]) {
    const user = new FakeElement('INPUT', { type: 'text', id: '23:0', [attribute]: label });
    const password = input('password'); inForm([user, password]);
    const result = await probe();
    assert.equal(globalThis.__gaddiElements?.nodes.get(result.username!), user);
    assert.equal(globalThis.__gaddiElements?.nodes.get(result.password!), password);
  }
  const hinted = input('text', 'username'), labelled = new FakeElement('INPUT', { placeholder: 'Email-Adresse' });
  inForm([hinted, labelled, input('password')]);
  const result = await probe();
  assert.equal(globalThis.__gaddiElements?.nodes.get(result.username!), hinted);
  inForm([labelled, new FakeElement('INPUT', { 'aria-label': 'Email' }), input('password')]);
  assert.equal((await probe()).challenge, true);
  inForm([new FakeElement('INPUT', { placeholder: 'Search' }), input('password')]);
  assert.equal((await probe()).username, undefined);
});
await test('password presence survives disabled/readonly state and clears only when hidden or removed', async () => {
  for (const field of [input('password'), input('text', 'section-login current-password')]) {
    inForm([field]);
    assert.equal((await probe()).passwordPresent, true);
    field.disabled = true;
    const disabled = await probe();
    assert.equal(disabled.password, undefined); assert.equal(disabled.passwordPresent, true);
    field.disabled = false; field.readOnly = true;
    const readonly = await probe();
    assert.equal(readonly.password, undefined); assert.equal(readonly.passwordPresent, true);
    field.hidden = true;
    assert.equal((await probe()).passwordPresent, false);
    field.hidden = false; field.isConnected = false;
    assert.equal((await probe()).passwordPresent, false);
  }
});
await test('multiple fields/forms and new-password return challenge with no refs', async () => {
  for (const fields of [[input('password'), input('password')], [input('email'), input('password', 'new-password')]]) {
    inForm(fields); const result = await probe();
    assert.equal(result.challenge, true); assert.equal(result.username, undefined); assert.equal(result.password, undefined);
  }
  const user = input('email'), password = input('password');
  user.form = new FakeForm(); password.form = new FakeForm(); setup([user, password]);
  assert.equal((await probe()).challenge, true);
});
await test('TOTP hints/heuristics work; visible SMS/passkey/captcha require the owner', async () => {
  for (const otp of [input('tel', 'one-time-code'), input('text', undefined, 'verification_code')]) {
    inForm([otp]); assert.ok((await probe()).otp);
  }
  inForm([input('number', 'one-time-code')]);
  assert.equal((await probe()).challenge, true);
  for (const unavailable of ['disabled', 'readOnly'] as const) {
    const otp = input('tel', 'one-time-code'); otp[unavailable] = true;
    inForm([otp]); assert.equal((await probe()).challenge, true);
    assert.equal((await probe()).otp, undefined);
  }
  for (const text of ['The code was sent to your phone', 'Sign in with a passkey', 'Verify you are human', 'Approve this sign-in']) {
    inForm([input('tel', 'one-time-code')]); doc.body.innerText = text;
    const result = await probe(); assert.equal(result.challenge, true); assert.equal(result.otp, undefined);
  }
  setup([new FakeElement('IFRAME', { src: 'https://captcha.test/recaptcha' })]);
  assert.equal((await probe()).challenge, true);
});
await test('site is an exact HTTPS/local origin on every content action', async () => {
  for (const origin of ['https://other.test', `${site}/path`, 'http://example.test', 'https://user:pass@example.test']) {
    inForm([input('password')]); await refused('signinProbe', { signin: { site: origin } });
  }
  for (const origin of ['http://localhost:4321', 'http://127.0.0.1:4321']) {
    inForm([input('password')]); Object.assign(globalThis, { location: { href: `${origin}/login` } });
    assert.ok((await pageTask('signinProbe', { signin: { site: origin } })).password);
  }
  inForm([input('password')]); const result = await probe();
  Object.assign(globalThis, { location: { href: 'https://evil.test/login' } });
  await refused('signinFocus', params(result.password!, 'password'));
});
await test('opaque probe refs enforce identity, role and writable visibility', async () => {
  const password = input('password'); inForm([password]); const result = await probe();
  await refused('signinFocus', params('#password', 'password'));
  await refused('signinFocus', params(result.password!, 'username'));
  password.hidden = true; await refused('signinFocus', params(result.password!, 'password'));
  password.hidden = false; password.isConnected = false;
  await refused('signinFocus', params(result.password!, 'password'));
});
await test('interrupted insert confirmation returns only a boolean and preserves origin/role/form/identity guards', async () => {
  const password = input('password'); const form = inForm([password]); const found = await probe();
  const options = { ...params(found.password!, 'password'), text: secret };
  password.value = secret;
  assert.deepEqual(await pageTask('signinLanded', options), { landed: true });
  assert.deepEqual(await pageTask('signinLanded', { ...options, text: 'different' }), { landed: false });
  assert.deepEqual(await pageTask('signinLanded', params(found.password!, 'password')), { landed: false });
  await refused('signinLanded', { ...options, selector: '#password' });
  await refused('signinLanded', { ...options, signin: { site, kind: 'username' } });
  for (const property of ['readOnly', 'hidden', 'disabled'] as const) {
    password[property] = true; await refused('signinLanded', options); password[property] = false;
  }
  password.form = new FakeForm(); await refused('signinLanded', options); password.form = form;
  password.isConnected = false; await refused('signinLanded', options); password.isConnected = true;
  password.type = 'text'; await refused('signinLanded', options); password.type = 'password';
  Object.assign(globalThis, { location: { href: 'https://evil.test/login' } });
  await refused('signinLanded', options);
});
await test('focus/selection handlers cannot change site, role, target or form destination', async () => {
  for (const mutate of [
    (field: FakeElement) => { field.type = 'text'; },
    (_field: FakeElement) => { Object.assign(globalThis, { location: { href: 'https://evil.test' } }); },
    (_field: FakeElement) => { doc.activeElement = new FakeElement(); },
    (field: FakeElement) => { field.form = new FakeForm(); },
  ]) {
    const password = input('password'); inForm([password]); const result = await probe();
    password.onFocus = () => mutate(password);
    await refused('signinFocus', params(result.password!, 'password'));
  }
  const password = input('password'); inForm([password]); const result = await probe();
  password.onSelect = () => { password.readOnly = true; };
  await refused('signinFocus', params(result.password!, 'password'));
  const field = input('password'), form = inForm([field]), found = await probe();
  field.onFocus = () => { form.attributes.action = 'https://evil.test/collect'; };
  await refused('signinSubmitFocus', params(found.password!, 'password'));
});
await test('Enter guards form action and default-button overrides, including URL credentials', async () => {
  for (const action of ['https://evil.test/collect', 'http://example.test/collect', 'https://user:pass@example.test/login', 'javascript:alert(1)']) {
    inForm([input('password')], action); const result = await probe();
    await refused('signinSubmitFocus', params(result.password!, 'password'));
  }
  const password = input('password'), button = new FakeElement('BUTTON', { type: 'submit', formaction: 'https://evil.test/collect' });
  inForm([password, button]); const result = await probe();
  await refused('signinSubmitFocus', params(result.password!, 'password'));
});
await test('form-free Enter remains bound to its original origin, role, field and null form', async () => {
  const password = input('password'); setup([password]); const found = await probe();
  assert.equal((await pageTask('signinSubmitFocus', params(found.password!, 'password'))).__gaddiError, undefined);
  await refused('signinSubmitFocus', params('#password', 'password'));
  await refused('signinSubmitFocus', params(found.password!, 'username'));
  for (const mutate of [
    (field: FakeElement) => { field.isConnected = false; },
    (field: FakeElement) => { field.type = 'text'; },
    (field: FakeElement) => { field.readOnly = true; },
    (field: FakeElement) => { field.form = new FakeForm('https://evil.test'); },
    (_field: FakeElement) => { Object.assign(globalThis, { location: { href: 'https://evil.test' } }); },
  ]) {
    const field = input('password'); setup([field]);
    const result = await probe();
    field.onFocus = () => mutate(field);
    await refused('signinSubmitFocus', params(result.password!, 'password'));
  }
});
await test('relative form destinations honor baseURI; empty action remains on the current page', async () => {
  for (const override of [false, true]) {
    const password = input('password');
    const button = new FakeElement('BUTTON', { type: 'submit', formaction: '/collect' });
    inForm(override ? [password, button] : [password], override ? `${site}/login` : '/collect');
    doc.baseURI = 'https://evil.test/base/';
    const result = await probe();
    await refused('signinSubmitFocus', params(result.password!, 'password'));
  }
  const password = input('password');
  const button = new FakeElement('BUTTON', { type: 'submit', formaction: '' });
  inForm([password, button], ''); doc.baseURI = 'https://evil.test/base/';
  const result = await probe();
  assert.equal((await pageTask('signinSubmitFocus', params(result.password!, 'password'))).__gaddiError, undefined);
});
await test('ordinary typing, pressing and evaluation still refuse passwords', async () => {
  const password = input('password'); inForm([password]); const result = await probe();
  assert.match((await pageTask('typeFocus', { selector: result.password })).__gaddiError!, /password/);
  doc.activeElement = password;
  assert.match((await pageTask('pressCheck')).__gaddiError!, /password/);
  assert.match((await pageTask('evalCheck')).__gaddiError!, /password/);
});

class Event<T extends (...args: never[]) => unknown> {
  listeners: T[] = [];
  addListener(listener: T) { this.listeners.push(listener); }
  removeListener(listener: T) { this.listeners = this.listeners.filter(fn => fn !== listener); }
}
const onMessage = new Event<(request: ChromeRequest) => void>();
const replies = new Map<string | number | null, (reply: Reply) => void>();
const calls: { method: string; params: Record<string, unknown> }[] = [];
let sendError = false;
let interruptedInsert: 'none' | 'landed' | 'missing' | 'partial' = 'none';
let injectionHook: ((action: string) => void) | undefined;
let submits = 0;
const fakeEvent = () => new Event<(...args: never[]) => void>();
const onDetach = new Event<(target: { tabId: number }, reason: string) => void>();
Object.assign(globalThis, { chrome: {
  runtime: { connectNative: () => ({ onMessage, onDisconnect: fakeEvent(), postMessage(reply: Reply) { replies.get(reply.id)?.(reply); } }), onStartup: fakeEvent(), onInstalled: fakeEvent() },
  alarms: { onAlarm: fakeEvent(), create() {} },
  tabs: { onRemoved: fakeEvent(), onUpdated: fakeEvent(), get: async () => ({ id: 1, url: location.href, active: true }) },
  debugger: { onDetach, attach: async () => {}, detach: async () => {},
    async sendCommand(_target: unknown, method: string, params: Record<string, unknown>) {
      calls.push({ method, params });
      if (sendError) throw new Error(secret);
      if (method === 'Input.insertText') {
        doc.activeElement.value = doc.activeElement.selected ? String(params.text) : doc.activeElement.value + String(params.text);
        doc.activeElement.selected = false;
        if (interruptedInsert !== 'none') {
          if (interruptedInsert === 'missing') doc.activeElement.value = '';
          if (interruptedInsert === 'partial') doc.activeElement.value = String(params.text).slice(0, -1);
          onDetach.listeners.forEach(listener => listener({ tabId: 1 }, 'target_closed'));
          throw new Error('Detached while handling command');
        }
      }
      if (method === 'Input.dispatchKeyEvent' && params.type === 'keyDown' && params.key === 'Enter') submits++;
      return {};
    } },
  scripting: { async executeScript(options: { func: typeof pageTask; args: [string, ChromeParams] }) {
    injectionHook?.(options.args[0]);
    return [{ result: await options.func(...options.args) }];
  } },
} });
// The imported service worker owns recurring health/reconnect timers. Bound their
// lifetime to this fixture without changing its input deadlines or assertions.
const nativeSetTimeout = globalThis.setTimeout;
const timers = new Set<ReturnType<typeof setTimeout>>();
globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
  const timer = nativeSetTimeout(...args);
  timers.add(timer);
  return timer;
}) as typeof setTimeout;
try {
await import('../../extension/bg.ts');
let next = 0;
async function request(method: string, options: ChromeParams): Promise<Reply> {
  const id = ++next;
  return await new Promise(resolve => {
    replies.set(id, resolve); onMessage.listeners[0]({ id, method: `chrome.${method}`, params: { tab: 1, ...options } });
  });
}
await test('native dispatcher types by trusted insertText, replacing values, and submits by trusted Enter', async () => {
  const user = input('email'), password = input('password'); inForm([user, password]);
  user.value = 'old user'; password.value = 'old password';
  const reply = await request('signinProbe', { signin: { site } });
  assert.ok(reply.result && typeof reply.result === 'object');
  const found = reply.result as { username: string; password: string };
  for (const [kind, selector] of [['username', found.username], ['password', found.password]] as const) {
    const typed = await request('signinType', { ...params(selector, kind), text: secret });
    assert.equal(typed.error, undefined); assert.deepEqual(typed.result, { typed: true });
  }
  assert.equal(user.value, secret); assert.equal(password.value, secret);
  const submit = await request('signinSubmit', params(found.password, 'password'));
  assert.equal(submit.error, undefined); assert.deepEqual(submit.result, { pressed: true }); assert.equal(submits, 1);
  assert.equal(calls.filter(call => call.method === 'Input.insertText').length, 2);
  assert.deepEqual(calls.filter(call => call.method === 'Input.dispatchKeyEvent').map(call => call.params.type), ['keyDown', 'keyUp']);
  assert.ok(!JSON.stringify([reply, submit]).includes(secret));
});
await test('native dispatcher rechecks before input and sanitizes Chrome/page exception text', async () => {
  const password = input('password'); inForm([password]); const found = await probe();
  const before = calls.filter(call => call.method === 'Input.insertText').length;
  injectionHook = action => { if (action === 'signinCheck') password.readOnly = true; };
  const denied = await request('signinType', { ...params(found.password!, 'password'), text: secret });
  injectionHook = undefined;
  assert.equal(denied.error?.message, 'Sign-in action failed');
  assert.equal(calls.filter(call => call.method === 'Input.insertText').length, before);
  password.readOnly = false; sendError = true;
  const failed = await request('signinType', { ...params(found.password!, 'password'), text: secret });
  sendError = false;
  assert.equal(failed.error?.message, 'Sign-in action failed'); assert.ok(!JSON.stringify(failed).includes(secret));
  password.onFocus = () => { throw new Error(secret); };
  assert.equal((await request('signinType', { ...params(found.password!, 'password'), text: secret })).error?.message, 'Sign-in action failed');
});
await test('interrupted credential insert succeeds only when fully delivered, never repeats, and never exports values', async () => {
  for (const kind of ['username', 'password', 'otp'] as const) {
    for (const interruption of ['landed', 'missing', 'partial'] as const) {
      const field = input(kind === 'password' ? 'password' : 'text', kind === 'otp' ? 'one-time-code' : kind);
      inForm([field]); const found = await probe();
      const before = calls.filter(call => call.method === 'Input.insertText').length;
      interruptedInsert = interruption;
      const reply = await request('signinType', { ...params(found[kind]!, kind), text: secret });
      interruptedInsert = 'none';
      if (interruption === 'landed') { assert.equal(reply.error, undefined); assert.deepEqual(reply.result, { typed: true }); }
      else assert.equal(reply.error?.message, 'Sign-in action failed');
      assert.equal(calls.filter(call => call.method === 'Input.insertText').length, before + 1, 'credential input must never be replayed');
      assert.ok(!JSON.stringify(reply).includes(secret));
    }
  }
});
console.log(`== Sign-in extension fakes: ${passed} passed, 0 failed`);
} finally {
  for (const timer of timers) clearTimeout(timer);
  globalThis.setTimeout = nativeSetTimeout;
}
