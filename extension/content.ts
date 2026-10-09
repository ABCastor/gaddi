import type { ChromeParams, PageResult, PageResults } from '../shared/protocol.ts';
export type { PageResult } from '../shared/protocol.ts';

interface PageElement extends Element {
  type?: string;
  labels?: NodeListOf<HTMLLabelElement> | null;
  value?: string;
  checked?: boolean;
  indeterminate?: boolean;
  multiple?: boolean;
  size?: number;
  isContentEditable?: boolean;
  tabIndex?: number;
  form?: HTMLFormElement | null;
  disabled?: boolean;
  readOnly?: boolean;
  contentDocument?: Document | null;
}
interface MotionState {
  originals: Map<Animation, number>;
  speed?: number;
  frame?: number;
}
interface ElementState {
  prefix: string;
  next: number;
  nodes: Map<string, PageElement>;
  ids: WeakMap<PageElement, string>;
  motion?: MotionState;
  appendNext?: number;
  appendCleanup?: { owner?: string; restore: () => void };
  signin?: Map<string, { kind: 'username' | 'password' | 'otp'; form: HTMLFormElement | null }>;
}
declare global { var __gaddiElements: ElementState | undefined; }
// This function is serialized by executeScript. Everything it needs lives inside
// it; persistent element references live in Chrome's isolated extension world.
export async function pageTask(action: string, params: ChromeParams = {}): Promise<PageResult> {
  try {
  const state: ElementState = globalThis.__gaddiElements ||= {
    // Six uniform base64url characters: 36 random bits, available on plain HTTP.
    prefix: '@' + [...crypto.getRandomValues(new Uint8Array(6))].map(n =>
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-'[n & 63]).join('') + ':',
    next: 0, nodes: new Map(), ids: new WeakMap(),
  };
  if (action === 'typeCleanup') {
    if (state.appendCleanup && state.appendCleanup.owner === params.appendCleanup) {
      state.appendCleanup.restore();
      delete state.appendCleanup;
    }
    return {} satisfies PageResults['typeCleanup'];
  }
  if (action === 'animationSpeed') {
    // The extension transport excludes CDP Animation. Adjust real animation
    // objects, never document.timeline, JavaScript timers, or page clocks.
    if (params.reset) {
      if (state.motion) {
        cancelAnimationFrame(state.motion.frame ?? 0);
        for (const [animation, rate] of state.motion.originals) animation.updatePlaybackRate(rate);
        delete state.motion;
      }
    } else {
      const motion: MotionState = state.motion ||= { originals: new Map() };
      motion.speed = params.animationSpeed;
      cancelAnimationFrame(motion.frame ?? 0);
      const update = () => {
        const current = new Set(document.getAnimations());
        for (const [animation, rate] of motion.originals) if (!current.has(animation)) {
          animation.updatePlaybackRate(rate); motion.originals.delete(animation);
        }
        for (const animation of current) {
          if (!motion.originals.has(animation)) motion.originals.set(animation, animation.playbackRate);
          const rate = motion.originals.get(animation)! * motion.speed!;
          if (animation.playbackRate !== rate) animation.updatePlaybackRate(rate);
        }
        motion.frame = requestAnimationFrame(update);
      };
      update();
    }
    return { animationSpeed: params.reset ? 1 : params.animationSpeed } satisfies PageResults['animationSpeed'];
  }
  const clean = (value: unknown) => String(value || '').replace(/\s+/g, ' ').trim();
  function resolve(selector: unknown): PageElement {
    if (typeof selector !== 'string' || !selector) throw new Error('A selector is required');
    if (selector === ':focus') return activeElement() || document.body;
    if (selector.startsWith('@') || selector.startsWith('gaddi:')) {
      const node = state.nodes.get(selector);
      if (!selector.startsWith(state.prefix) || !node?.isConnected) throw new Error('Stale selector; read the page again');
      return node;
    }
    const nodes = document.querySelectorAll(selector);
    if (nodes.length !== 1) throw new Error(`Selector must match exactly one element (matched ${nodes.length})`);
    return nodes[0];
  }
  function selectorFor(el: PageElement) {
    let selector = state.ids.get(el);
    if (!selector) {
      selector = `${state.prefix}${(++state.next).toString(36)}`;
      state.ids.set(el, selector);
    }
    state.nodes.set(selector, el); // Reattached nodes may have been pruned from the strong map.
    return selector;
  }
  function visible(el: PageElement) {
    const style = getComputedStyle(el);
    return !el.closest('[hidden], [aria-hidden="true"], [inert]')
      && style.visibility !== 'hidden' && style.visibility !== 'collapse'
      && style.display !== 'none' && el.getClientRects().length > 0;
  }
  function nameOf(el: PageElement, seen = new Set<PageElement>()): string {
    /* NAME_RESOLUTION_TEST_POINT */
    if (seen.has(el)) return '';
    seen.add(el);
    const refs = clean(el.getAttribute('aria-labelledby')).split(' ').filter(Boolean);
    if (refs.length) {
      const root = el.getRootNode();
      const name = clean(refs.map(id => {
        const ref = 'getElementById' in root ? (root as Document | ShadowRoot).getElementById(id) : undefined;
        return ref ? nameOf(ref, seen) : '';
      }).join(' '));
      if (name) return name;
    }
    const aria = clean(el.getAttribute('aria-label'));
    if (aria) return aria;
    if (el.labels?.length) return clean([...el.labels].map(label => label.textContent).join(' '));
    if (el.tagName === 'IMG' || (el.tagName === 'INPUT' && el.type === 'image')) return clean(el.getAttribute('alt'));
    if (el.tagName === 'INPUT') {
      if (['button', 'submit', 'reset'].includes(el.type || '')) return clean(el.value || (el.type === 'submit' ? 'Submit' : el.type === 'reset' ? 'Reset' : ''));
      return clean(el.getAttribute('title') || el.getAttribute('placeholder'));
    }
    if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable) return clean(el.getAttribute('title') || el.getAttribute('placeholder'));
    // Include descendant image alternatives, but never read a form value as a name.
    const content = [...el.childNodes].map(node => node.nodeType === Node.TEXT_NODE ? node.textContent
      : node.nodeType === Node.ELEMENT_NODE && !(node as Element).matches('script, style, [aria-hidden="true"]') ? nameOf(node as Element, seen) : '').join(' ');
    return clean(content || el.getAttribute('title'));
  }
  function roleOf(el: PageElement): string {
    const explicit = clean(el.getAttribute('role')).split(' ')[0];
    if (explicit) return explicit;
    const roles: Record<string, string> = { BUTTON: 'button', A: el.hasAttribute('href') ? 'link' : '', INPUT: 'textbox',
      TEXTAREA: 'textbox', SELECT: el.multiple || (el.size ?? 0) > 1 ? 'listbox' : 'combobox', SUMMARY: 'button',
      MAIN: 'main', NAV: 'navigation', ASIDE: 'complementary', SEARCH: 'search',
      HEADER: el.closest('article, aside, main, nav, section') ? '' : 'banner',
      FOOTER: el.closest('article, aside, main, nav, section') ? '' : 'contentinfo',
      FORM: el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby') ? 'form' : '',
      SECTION: el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby') ? 'region' : '',
    };
    if (el.tagName === 'INPUT') {
      return ({ hidden: '', checkbox: 'checkbox', radio: 'radio', range: 'slider', number: 'spinbutton',
        search: 'searchbox', button: 'button', submit: 'button', reset: 'button', image: 'button' } as Record<string, string>)[el.type || ''] ?? 'textbox';
    }
    return roles[el.tagName] || (/^H[1-6]$/.test(el.tagName) ? 'heading' : el.isContentEditable ? 'textbox' : floatingRole(el) || ((el.tabIndex ?? -1) >= 0 ? 'generic' : ''));
  }
  // Event-delegated menus often have no ARIA roles or DOM onclick property.
  // Infer controls only inside floating layers, and keep one ref per item.
  const floatingGroups = new WeakMap<Element, boolean>();
  function floatingRole(el: PageElement): string {
    if (!(el instanceof HTMLElement) || !['DIV', 'SPAN', 'LI'].includes(el.tagName)) return '';
    const handlesClick = (node: Element) => typeof (node as HTMLElement).onclick === 'function' || node.hasAttribute('onclick') || (node as HTMLElement).tabIndex >= 0;
    const clickable = (node: Element) => getComputedStyle(node).cursor === 'pointer' || handlesClick(node);
    function group(node: Element): boolean {
      const cached = action === 'read' ? floatingGroups.get(node) : undefined;
      if (cached !== undefined) return cached;
      const children = [...node.children].filter(child => ['DIV', 'LI'].includes(child.tagName) && visible(child) && clickable(child));
      // Grouping propagates through any number of wrappers. An item with its
      // own handler keeps its title/description children as one click surface.
      const grouped = children.some(group) || (handlesClick(node)
        ? children.filter(handlesClick).length > 1 : children.length > 1);
      if (action === 'read') floatingGroups.set(node, grouped);
      return grouped;
    }
    if (!clickable(el) && (el.tabIndex ?? -1) < 0) return '';
    if (group(el)) return ''; // A pointer-cursor menu wrapper is not one aggregate choice.
    for (let parent: Element | null = el.parentElement; parent; parent = parent.parentElement || (parent.getRootNode() as ShadowRoot).host) {
      const role = parent.getAttribute('role');
      if (['button', 'link', 'menuitem', 'option', 'tab'].includes(role || '') || parent.matches('button, a[href]')) return '';
      const style = getComputedStyle(parent);
      if (parent.matches('[popover], [data-radix-popper-content-wrapper], [data-popper-placement]')
        || ['menu', 'listbox'].includes(role || '')
        || ['absolute', 'fixed'].includes(style.position) && Number(style.zIndex) > 0) {
        return role === 'listbox' ? 'option' : role === 'menu' ? 'menuitem' : 'button';
      }
      if (clickable(parent) && !group(parent)) return ''; // A label/icon inherits the item's pointer cursor.
    }
    return '';
  }
  function isPassword(el: PageElement) {
    // Invariant: input never reaches a password target, even if daemon policy is
    // bypassed. Autocomplete may include section tokens before the password token.
    return typeof el.type === 'string' && el.type.toLowerCase() === 'password'
      || /(?:^|\s)(?:current-password|new-password)(?:\s|$)/i.test(el.getAttribute('autocomplete') || '');
  }
  function hiddenValue(el: PageElement) {
    return isPassword(el) || el.tagName === 'INPUT' && ['hidden', 'file'].includes(el.type || '')
      || /(?:^|\s)(?:cc-number|cc-csc|cc-exp\S*|one-time-code)(?:\s|$)/i.test(el.getAttribute('autocomplete') || '');
  }
  const short = (value: unknown) => { const text = String(value ?? ''); return text.length > 80 ? text.slice(0, 79) + '…' : text; };
  function controlState(el: PageElement) {
    /* OUTLINE_STATE_TEST_POINT */
    const parts: string[] = [], role = roleOf(el);
    if (el.tagName === 'SELECT') {
      const options = [...(el as HTMLSelectElement).options];
      parts.push(hiddenValue(el) ? 'value=(hidden)' : `value=${JSON.stringify(short(options.filter(o => o.selected).map(o => o.label).join('|')))}`);
      if (!hiddenValue(el)) {
        const enabled = options.filter(o => !o.disabled && !(o.parentElement as HTMLOptGroupElement | null)?.disabled);
        parts.push(`options=${JSON.stringify(enabled.slice(0, 20).map(o => `${short(o.value)}:${short(o.label)}`).join('|') + (enabled.length > 20 ? '|…' : ''))}`);
      }
    } else if (hiddenValue(el)) parts.push('value=(hidden)');
    else if (el.tagName === 'TEXTAREA' || el.isContentEditable
      || ['textbox', 'searchbox', 'spinbutton', 'combobox', 'slider'].includes(role)) {
      parts.push(`value=${JSON.stringify(short(el.value ?? el.getAttribute('aria-valuetext') ?? el.getAttribute('aria-valuenow') ?? el.textContent))}`);
    }
    if (['checkbox', 'radio', 'switch'].includes(role)) {
      const checked = el.getAttribute('aria-checked') ?? (el.indeterminate ? 'mixed' : String(el.checked ?? false));
      parts.push(checked === 'true' ? 'checked' : checked === 'mixed' ? 'mixed' : 'unchecked');
    }
    for (const key of ['expanded', 'selected', 'pressed']) if (el.hasAttribute(`aria-${key}`)) parts.push(`${key}=${el.getAttribute(`aria-${key}`)}`);
    if (el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true') parts.push('disabled');
    return parts.length ? ' ' + parts.join(' ') : '';
  }
  function accessibleName(el: PageElement) {
    // Landmarks and generic containers get their names from authors, not all of
    // their descendant text. Otherwise one main landmark can swallow the outline.
    if ((['main', 'navigation', 'complementary', 'banner', 'contentinfo', 'search', 'form', 'region', 'generic'].includes(roleOf(el))
      || ['BODY', 'HTML'].includes(el.tagName)) && !el.hasAttribute('aria-label') && !el.hasAttribute('aria-labelledby')) {
      return clean(el.getAttribute('title'));
    }
    return nameOf(el);
  }
  function describe(el: PageElement) {
    // Invariant: clicking a child icon is described as clicking its interactive
    // ancestor, so it cannot hide the button/link name or destination from gates.
    const interactive = el.closest('button, a[href], [role="button"], [role="link"], [role="menuitem"], [role="tab"], input[type="submit"], input[type="button"], input[type="image"], summary, label') || el;
    const form = el.form || el.closest('form');
    const submit = form && [...form.elements].find((control: PageElement) =>
      !control.disabled && ((control.tagName === 'BUTTON' && control.type === 'submit')
        || (control.tagName === 'INPUT' && ['submit', 'image'].includes(control.type || ''))));
    // Enter on a focused button/link activates that control, not the form's
    // default button. Only implicit submission from a text field uses the default.
    const activationTarget = ['button', 'link'].includes(roleOf(interactive)) ? interactive : submit;
    return { selector: selectorFor(el), tag: el.tagName.toLowerCase(), type: el.getAttribute('type') || (typeof el.type === 'string' ? el.type : ''),
      autocomplete: el.getAttribute('autocomplete') || '', role: roleOf(el), name: accessibleName(interactive),
      href: interactive.closest<HTMLAnchorElement>('a[href]')?.href || '', submitName: activationTarget ? nameOf(activationTarget) : '',
      password: isPassword(el), disabled: el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true' };
  }
  function activeElement() {
    let el = document.activeElement;
    while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
    return el;
  }
  // The middle of the part of el inside the viewport, or null when the page shows something else there.
  function centrePoint(el: PageElement) {
    const rect = el.getBoundingClientRect();
    const x = (Math.max(0, rect.left) + Math.min(innerWidth, rect.right)) / 2;
    const y = (Math.max(0, rect.top) + Math.min(innerHeight, rect.bottom)) / 2;
    let hit = document.elementFromPoint(x, y);
    while (hit?.shadowRoot?.elementFromPoint(x, y) && hit.shadowRoot.elementFromPoint(x, y) !== hit) hit = hit.shadowRoot.elementFromPoint(x, y);
    return hit && (hit === el || el.contains(hit)) ? { x, y } : null;
  }
  // The nearest element, from el upwards, that a wheel on this axis can really scroll; else the page.
  // overflow:hidden is skipped on purpose: the wheel chains past it, so it is not where the scroll lands.
  function scrollerFor(el: PageElement, axis: 'x' | 'y'): Element {
    for (let node: Element | null = el; node && node !== document.body && node !== document.documentElement;
      node = node.parentElement || (node.getRootNode() as ShadowRoot).host || null) {
      const style = getComputedStyle(node);
      if (axis === 'x' ? /^(?:auto|scroll|overlay)$/.test(style.overflowX) && node.scrollWidth > node.clientWidth
        : /^(?:auto|scroll|overlay)$/.test(style.overflowY) && node.scrollHeight > node.clientHeight) return node;
    }
    return document.scrollingElement || document.documentElement;
  }
  function checkDescription(el: PageElement, enter = false) {
    /* CHECKED_DESCRIPTION_TEST_POINT */
    const checked = params.checkedDescription;
    if (!checked) return;
    const current = describe(el);
    if (enter ? current.submitName !== checked.submitName : current.name !== checked.name || current.href !== checked.href)
      throw new Error('Element changed since it was checked; look again');
  }
  function fnvAccumulator() {
    let hash = 2166136261;
    const add = (value: unknown) => {
      const text = String(value ?? ''), imul = Math.imul;
      let digest = hash;
      for (let i = 0; i < text.length; i++) digest = imul(digest ^ text.charCodeAt(i), 16777619);
      hash = imul(digest ^ 0, 16777619);
    };
    return { add, digest: () => hash >>> 0 };
  }
  const controls = 'input, textarea, select, [contenteditable], [role="textbox"], [role="searchbox"], [role="spinbutton"], [role="combobox"], [role="checkbox"], [role="radio"], [role="switch"], [aria-checked], [aria-expanded], [aria-selected], [aria-pressed], [aria-valuenow], [aria-valuetext]';
  function pageVersion() {
    const { add, digest } = fnvAccumulator();
    add(location.href); add(performance.timeOrigin);
    // One targeted query, no text, layout, focus, values or control state.
    for (const el of document.querySelectorAll<PageElement>(controls + ', a[href], button')) {
      add(selectorFor(el)); add(el.tagName); add(el.getAttribute('type'));
      add(el.matches('a[href]') ? (el as HTMLAnchorElement).href : '');
      add(el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true');
    }
    return `v1-${digest()}`;
  }
  function signature() {
    // Values stay in the isolated world. Only a digest crosses the wire.
    const { add, digest } = fnvAccumulator();
    add(location.href); add(document.title); add(scrollX); add(scrollY);
    const focused = activeElement(); add(focused ? selectorFor(focused) : '');
    function walk(root: Document | ShadowRoot) {
      for (const el of root.querySelectorAll<PageElement>(controls)) {
        add(selectorFor(el)); add(el.value ?? el.textContent); add(el.checked); add(el.indeterminate); add(el.disabled);
        for (const key of ['checked', 'expanded', 'selected', 'pressed', 'valuenow', 'valuetext']) add(el.getAttribute(`aria-${key}`));
        if (el.tagName === 'SELECT') for (const option of (el as HTMLSelectElement).options) add(option.selected);
      }
      add((root === document ? document.body : root)?.textContent);
      // Shadow hosts have no CSS selector. This cheap pass only discovers roots;
      // control state is read by the targeted query above, including nested roots.
      for (const el of root === document ? document.getElementsByTagName('*') : root.querySelectorAll('*')) {
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    }
    walk(document);
    const hash = digest();
    return `${performance.timeOrigin}:${hash >>> 0}`;
  }
  function assertWritable(el: PageElement) {
    if (isPassword(el)) throw new Error('Refusing to type into a password field');
    if (!visible(el) || el.matches(':disabled') || el.readOnly || el.getAttribute('aria-disabled') === 'true') throw new Error('Element is not writable');
    if (!(el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'INPUT'
      && ['text', 'search', 'email', 'url', 'tel', 'number'].includes(el.type || ''))) throw new Error('Element is not a text input');
  }
  function signinSite() {
    const site = params.signin?.site;
    if (typeof site !== 'string') throw new Error('Sign-in refused');
    const url = new URL(site), page = new URL(location.href);
    if (url.origin !== site || url.username || url.password || page.username || page.password
      || page.origin !== site || !(url.protocol === 'https:'
        || url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('Sign-in refused');
    return site;
  }
  function signinKind(el: PageElement, hintsOnly = false): 'username' | 'password' | 'otp' | undefined {
    if (el.tagName !== 'INPUT' || !visible(el) || el.matches(':disabled') || el.disabled || el.readOnly
      || el.getAttribute('aria-disabled') === 'true') return;
    const tokens = (el.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/);
    if (tokens.includes('new-password')) return;
    const type = (el.type || 'text').toLowerCase();
    if (!['text', 'email', 'tel', 'number', 'password'].includes(type)) return;
    if (tokens.includes('current-password')) return 'password';
    if (tokens.includes('one-time-code') && type !== 'password') return 'otp';
    if ((tokens.includes('username') || tokens.includes('email')) && ['text', 'email'].includes(type)) return 'username';
    if (hintsOnly) return;
    const name = `${el.getAttribute('name') || ''} ${el.getAttribute('id') || ''}`.toLowerCase();
    if (type === 'password') return 'password';
    if (/(?:^|[\s_-])(?:otp|totp|code|verification[-_]?code|one[-_]?time[-_]?code|auth[-_]?code)(?:$|[\s_-])/.test(name)) return 'otp';
    if (['text', 'email'].includes(type) && (type === 'email' || /(?:^|[\s_-])(?:username|user[-_]?name|email|login)(?:$|[\s_-])/.test(name))) return 'username';
    // Generated IDs often carry no semantics. Use the control's accessible name,
    // which resolves labels in its own root and falls back to the placeholder.
    /* SIGNIN_ACCESSIBLE_NAME_TEST_POINT */
    if (['text', 'email'].includes(type) && /^(?:user[\s_-]?name|e[\s_-]?mail(?:[\s_-]+(?:address|adresse))?|login)$/i.test(nameOf(el))) return 'username';
  }
  function signinFields() {
    const fields: Partial<Record<'username' | 'password' | 'otp', PageElement>> = {};
    const inputs: PageElement[] = [];
    function walk(root: Document | ShadowRoot) {
      for (const el of root.querySelectorAll<PageElement>('*')) {
        if (el.tagName === 'INPUT') inputs.push(el);
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    }
    walk(document);
    let ambiguous = inputs.some(el => visible(el) && /(?:^|\s)new-password(?:\s|$)/i.test(el.getAttribute('autocomplete') || ''));
    // An unavailable verification control still means authentication is unfinished.
    if (inputs.some(el => visible(el) && el.type !== 'password'
      && (/(?:^|\s)one-time-code(?:\s|$)/i.test(el.getAttribute('autocomplete') || '')
        || /(?:^|[\s_-])(?:otp|totp|code|verification[-_]?code|one[-_]?time[-_]?code|auth[-_]?code)(?:$|[\s_-])/i.test(`${el.getAttribute('name') || ''} ${el.getAttribute('id') || ''}`))
      && signinKind(el) !== 'otp')) ambiguous = true;
    for (const kind of ['username', 'password', 'otp'] as const) {
      const hinted = inputs.filter(el => signinKind(el, true) === kind);
      const matches = hinted.length ? hinted : inputs.filter(el => signinKind(el) === kind);
      if (matches.length > 1) ambiguous = true;
      else if (matches.length === 1) fields[kind] = matches[0];
    }
    if (new Set(Object.values(fields).map(el => el.form || null)).size > 1) ambiguous = true;
    // Number controls cannot reliably select existing text for replacement.
    // Flag them as a challenge so their presence cannot imply sign-in succeeded.
    if (Object.values(fields).some(el => el.type === 'number')) ambiguous = true;
    const passwordPresent = inputs.some(el => el.isConnected && visible(el)
      && ((el.type || '').toLowerCase() === 'password'
        || /(?:^|\s)current-password(?:\s|$)/i.test(el.getAttribute('autocomplete') || '')));
    return { fields, ambiguous, passwordPresent };
  }
  function signinSignature() {
    const { add, digest } = fnvAccumulator();
    add(location.href); add(document.title);
    function walk(root: Document | ShadowRoot) {
      for (const el of root.querySelectorAll<PageElement>('*')) {
        if (!visible(el)) continue;
        add(el.tagName); add(selectorFor(el));
        if (el.tagName === 'INPUT') {
          add(el.type); add(el.getAttribute('autocomplete')); add(el.disabled); add(el.readOnly);
        } else if (!['TEXTAREA', 'SELECT', 'SCRIPT', 'STYLE'].includes(el.tagName) && !el.isContentEditable) {
          // Direct text nodes describe page changes without ever hashing input values.
          for (const child of el.childNodes) if (child.nodeType === Node.TEXT_NODE) add(child.textContent);
        }
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    }
    walk(document);
    return `signin-${digest()}`;
  }
  function signinChallenge() {
    const text = (document.body?.innerText || '').toLowerCase();
    if (/captcha|i[’']?m not a robot|verify (?:that )?you are human|use (?:a |your )?passkey|sign in with (?:a )?passkey|approve (?:the |this )?(?:sign[- ]?in|request)|(?:code|message).{0,40}(?:sent|texted).{0,40}(?:phone|sms|mobile)|(?:sms|text message).{0,40}code/.test(text)) return true;
    return [...document.querySelectorAll<PageElement>('iframe, [id], [class]')].some(el => visible(el)
      && /(?:recaptcha|hcaptcha|turnstile|captcha)/i.test(`${el.getAttribute('src') || ''} ${el.getAttribute('id') || ''} ${el.getAttribute('class') || ''}`));
  }
  function signinForm(el: PageElement) {
    const form = el.form;
    // Script-driven logins can handle Enter without a native form destination.
    // signinTarget still binds their origin, role, identity and null form.
    if (!form) { /* SIGNIN_NO_FORM_TEST_POINT */ return; }
    if (form.tagName !== 'FORM' || !form.isConnected) throw new Error('Sign-in refused');
    // Read attributes: a named form control can clobber form.action in page DOM.
    const action = form.getAttribute('action');
    const url = action ? new URL(action, document.baseURI) : new URL(location.href);
    if (url.origin !== signinSite() || url.username || url.password) throw new Error('Sign-in refused');
    // A default submit button's override is the destination of implicit Enter.
    const submit = [...form.elements].find(control => !control.matches(':disabled')
      && ((control.tagName === 'BUTTON' && (control as HTMLButtonElement).type === 'submit')
        || control.tagName === 'INPUT' && ['submit', 'image'].includes((control as HTMLInputElement).type)));
    if (submit?.hasAttribute('formaction')) {
      const action = submit.getAttribute('formaction');
      const override = action ? new URL(action, document.baseURI) : new URL(location.href);
      if (override.origin !== signinSite() || override.username || override.password) throw new Error('Sign-in refused');
    }
  }
  function signinTarget(submit: boolean) {
    signinSite();
    if (typeof params.selector !== 'string' || !params.selector.startsWith(state.prefix)) throw new Error('Sign-in refused');
    const known = state.signin?.get(params.selector), el = resolve(params.selector);
    const kind = params.signin?.kind;
    const { fields, ambiguous } = signinFields();
    if (!known || known.kind !== kind || ambiguous || signinChallenge() || fields[known.kind] !== el
      || signinKind(el) !== known.kind || (el.form || null) !== known.form) throw new Error('Sign-in refused');
    if (submit) signinForm(el);
    return el;
  }
  if (action === 'signinProbe') {
    signinSite();
    const { fields, ambiguous, passwordPresent } = signinFields(), challenge = ambiguous || signinChallenge();
    state.signin = new Map();
    const refs: Partial<Record<'username' | 'password' | 'otp', string>> = {};
    if (!challenge) for (const kind of ['username', 'password', 'otp'] as const) {
      const el = fields[kind];
      if (el) { const ref = selectorFor(el); refs[kind] = ref; state.signin.set(ref, { kind, form: el.form || null }); }
    }
    return { url: location.href, signature: signinSignature(), passwordPresent, ...refs, ...(challenge ? { challenge: true } : {}) } satisfies PageResults['signinProbe'];
  }
  if (action === 'signinLanded') {
    // Only the checked origin, role, field and form may confirm an interrupted
    // credential insert. Compare inside the isolated world; return no value.
    const el = signinTarget(false);
    return { landed: typeof params.text === 'string' && el.value === params.text } satisfies PageResults['signinLanded'];
  }
  if (['signinFocus', 'signinCheck', 'signinSubmitFocus', 'signinSubmitCheck'].includes(action)) {
    const submit = action.startsWith('signinSubmit'), el = signinTarget(submit);
    if (action.endsWith('Focus')) {
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      (el as HTMLElement).focus({ preventScroll: true });
      signinTarget(submit); // Focus handlers can navigate, replace fields or change form destinations.
      if (activeElement() !== el) throw new Error('Sign-in refused');
      if (!submit) (el as HTMLInputElement).select();
    }
    signinTarget(submit);
    if (activeElement() !== el) throw new Error('Sign-in refused');
    return { selector: selectorFor(el), signature: signinSignature(), combobox: false } satisfies PageResults['signinFocus'];
  }
  if (params.version && ['describe', 'snapshot', 'pressCheck', 'scroll', 'scrollPoint', 'select', 'upload', 'typeFocus', 'typeCheck', 'clickPoint', 'clickCheck', 'hoverPoint'].includes(action)
    && params.version !== pageVersion()) {
    throw Object.assign(new Error('the page changed since you looked'), { code: 'stale' });
  }
  if (action === 'wait') {
    const selector = params.selector;
    // Parse CSS once: invalid syntax is an error, an absent element is not.
    if (selector && !selector.startsWith('@') && !selector.startsWith('gaddi:')) document.querySelector(selector);
    const needle = params.text?.replace(/\s+/g, ' ').trim().toLowerCase();
    let textCache: string | undefined, textReadAt = 0;
    function matches() {
      /* WAIT_CHECK_TEST_POINT */
      if (selector) {
        if (selector.startsWith('@') || selector.startsWith('gaddi:')) {
          const el = state.nodes.get(selector);
          return !!el?.isConnected && visible(el);
        }
        return [...document.querySelectorAll(selector)].some(visible);
      }
      // Native rendered text preserves whitespace and hidden subtrees. Cache it:
      // mutations invalidate immediately; the backstop refreshes at most once/sec.
      if (textCache === undefined || performance.now() - textReadAt >= 1000) {
        textCache = (document.body?.innerText || '').replace(/\s+/g, ' ').trim().toLowerCase();
        textReadAt = performance.now();
      }
      return textCache.includes(needle!); /* WAIT_TEXT_END */
    }
    return await new Promise<PageResults['wait']>((resolve, reject) => {
      let debounce: ReturnType<typeof setTimeout> | undefined, frame = 0, done = false;
      const end = performance.now() + (params.timeout ?? 500);
      const observer = new MutationObserver(() => { textCache = undefined; debounce ??= setTimeout(() => { debounce = undefined; check(); }, 40); });
      const finish = (met: boolean, error?: unknown) => {
        if (done) return; done = true;
        observer.disconnect(); clearInterval(backstop); clearTimeout(timer); clearTimeout(debounce); cancelAnimationFrame(frame);
        if (error) reject(error); else resolve({ met });
      };
      const check = () => {
        try { if (matches() !== !!params.gone) finish(true); } catch (error) { finish(false, error); }
      };
      const backstop = setInterval(check, 250);
      const finalCheck = () => { textCache = undefined; check(); finish(false); };
      // Focus emulation supplies frames even when Chrome postpones hidden-tab timers.
      const tick = () => { if (performance.now() >= end) finalCheck(); else frame = requestAnimationFrame(tick); };
      const timer = setTimeout(finalCheck, params.timeout ?? 500);
      frame = requestAnimationFrame(tick);
      observer.observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
      check();
    });
  }
  if (action === 'read') {
    if (params.visible !== undefined && typeof params.visible !== 'boolean') throw new Error('visible must be boolean');
    const viewportOnly = params.visible === true; /* VISIBLE_TEST_POINT */
    const intersects = (rect: DOMRect) => rect.width > 0 && rect.height > 0
      && rect.right > 0 && rect.left < innerWidth && rect.bottom > 0 && rect.top < innerHeight;
    for (const [key, el] of state.nodes) if (!el.isConnected) state.nodes.delete(key);
    const elements: string[] = [], texts: string[] = [], offscreen = { above: 0, below: 0 };
    function walk(root: Document | ShadowRoot) {
      for (const el of root.querySelectorAll<PageElement>('*')) {
        if (visible(el) && roleOf(el)) {
          const box = viewportOnly ? el.getBoundingClientRect() : undefined;
          if (box && !intersects(box)) {
            if (box.bottom <= 0) offscreen.above++;
            else if (box.top >= innerHeight) offscreen.below++;
          } else {
            const info = describe(el);
            elements.push(`${info.role} ${JSON.stringify(info.name)}${controlState(el)} ${info.selector}`);
          }
        }
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    }
    let previousTextRect: DOMRect | undefined;
    function collectText(root: Node) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
      const range = document.createRange();
      let node: Node | null;
      while ((node = walker.nextNode())) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          if ((node as Element).shadowRoot) collectText((node as Element).shadowRoot!);
          continue;
        }
        const parent = node.parentElement || (node.getRootNode() as ShadowRoot).host;
        if (!parent || !node.textContent || parent.closest('script,style,noscript,template,[hidden],[aria-hidden="true"],[inert]')) continue;
        if (!parent.checkVisibility({ checkVisibilityCSS: true })) {
          const style = getComputedStyle(parent);
          if (style.display !== 'contents' || style.visibility !== 'visible') continue;
        }
        range.selectNodeContents(node);
        const rects = [...range.getClientRects()].filter(intersects);
        if (!rects.length) continue;
        const first = rects[0];
        if (previousTextRect && (first.top >= previousTextRect.bottom || first.bottom <= previousTextRect.top)) texts.push(' ');
        texts.push(node.textContent);
        previousTextRect = rects[rects.length - 1];
      }
    }
    walk(document);
    if (viewportOnly) collectText(document.body || document);
    return { text: (viewportOnly ? texts.join('').replace(/\s+/g, ' ').trim() : document.body?.innerText || '').slice(0, 20000),
      outline: elements.join('\n'), version: pageVersion(), scroll: { y: scrollY, height: document.documentElement.scrollHeight },
      ...(viewportOnly ? { offscreen } : {}) } satisfies PageResults['read'];
  }
  if (action === 'snapshot') return { signature: signature() } satisfies PageResults['snapshot'];
  if (action === 'settle') {
    const combo = params.settleMs === 200;
    await new Promise<void>(resolve => {
      let frame = 0, frames = 0;
      const finish = () => { clearTimeout(timer); cancelAnimationFrame(frame); resolve(); };
      const timer = setTimeout(finish, combo ? 200 : 50);
      const tick = () => {
        if (++frames >= 2 && (!combo || [...document.querySelectorAll('[role="option"], [role="listbox"]')].some(visible))) finish();
        else frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
    });
    return { signature: signature(), url: location.href, version: pageVersion() } satisfies PageResults['settle'];
  }
  if (action === 'evalCheck') {
    // Invariant: arbitrary evaluation is refused on documents containing password
    // fields, including open shadows and readable embedded documents. Cross-origin
    // frames are unreadable to main-world JS by the browser's same-origin policy.
    function check(root: Document | ShadowRoot) {
      for (const el of root.querySelectorAll<PageElement>('*')) {
        if (isPassword(el)) throw new Error('Refusing evaluation on a page with password fields');
        if (el.shadowRoot) check(el.shadowRoot);
        if (['IFRAME', 'FRAME', 'OBJECT', 'EMBED'].includes(el.tagName)) {
          let child;
          try { child = el.contentDocument; } catch { /* Same-origin policy also blocks eval access. */ }
          if (child) check(child);
        }
      }
    }
    check(document);
    return {} satisfies PageResults['evalCheck'];
  }
  if (action === 'html') {
    const copy = document.documentElement?.cloneNode(true) as Element | undefined;
    // Invariant: markup extraction never exports password values from attributes.
    for (const el of copy?.querySelectorAll<PageElement>('*') || []) if (isPassword(el)) {
      el.removeAttribute('value'); el.textContent = '';
    }
    const html = copy?.outerHTML || '';
    // Bound by bytes, not UTF-16 code units (the daemon's HTML limit is 5 MiB).
    const bytes = new TextEncoder().encode(html);
    return { html: new TextDecoder().decode(bytes.subarray(0, 5 * 1024 * 1024)), truncated: bytes.length > 5 * 1024 * 1024 } satisfies PageResults['html'];
  }
  if (action === 'closeForeignFrames') {
    // Invariant: removes only frames that show ANOTHER extension's page. While one is in the
    // tab, Chrome refuses every chrome.debugger call there (debugger_api.cc
    // ExtensionMayAttachToRenderFrameHost), so a password manager's inline or sign-in menu
    // would lock Gaddi out of the whole tab. Removing the frame is what dismissing the menu
    // does for a person. Nothing inside such a frame is read (it is cross-origin), the other
    // extension's own elements stay, and the page's own frames are never touched.
    const own = `chrome-extension://${chrome.runtime.id}/`;
    let closed = 0;
    const sweep = (root: Document | ShadowRoot) => {
      for (const el of root.querySelectorAll('*')) {
        try {
        const url = ['IFRAME', 'FRAME', 'EMBED'].includes(el.tagName) ? (el as HTMLIFrameElement).src
          : el.tagName === 'OBJECT' ? (el as HTMLObjectElement).data : '';
        if (url.startsWith('chrome-extension://') && !url.startsWith(own)) { el.remove(); closed++; continue; }
        // Extensions inject their menus in closed shadow roots; only the isolated world sees them.
        // Chrome throws for elements that cannot host a shadow root (SVG, some form controls); skip those.
        let shadow = el.shadowRoot;
        if (!shadow && el instanceof HTMLElement) {
          try { shadow = globalThis.chrome?.dom?.openOrClosedShadowRoot(el) ?? null; } catch { shadow = null; }
        }
        if (shadow) sweep(shadow);
        } catch { /* One malformed node or unavailable shadow root must not poison the tab. */ }
      }
    };
    sweep(document);
    return { closed } satisfies PageResults['closeForeignFrames'];
  }
  if (action === 'pressCheck') {
    const el = activeElement();
    if (params.selector && el !== resolve(params.selector)) throw new Error('Focused target changed since it was checked');
    // A top-frame script cannot validate the actual keyboard target inside an
    // embedded document. Refuse instead of sending unchecked text to that frame.
    if (el && ['IFRAME', 'FRAME', 'OBJECT', 'EMBED'].includes(el.tagName)) throw new Error('Refusing keyboard input into an uninspected embedded document');
    if (el && isPassword(el)) throw new Error('Refusing keyboard input into a password field');
    if (params.checkedDescription) checkDescription(el || document.body, true);
    return { signature: signature() } satisfies PageResults['pressCheck'];
  }
  const el = resolve(params.selector);
  // Whether a type whose session Chrome cut mid-insert left the field holding the text.
  if (action === 'typeLanded') return { landed: !isPassword(el)
    && (el.isContentEditable ? el.textContent : el.value) === params.text } satisfies PageResults['typeLanded'];
  if (action === 'describe') return { ...describe(el),
    matched: (params.denySelectors || []).filter(selector => el.matches(selector)) } satisfies PageResults['describe'];
  if (action === 'captureBox') {
    if (!visible(el)) throw new Error('Capture target is not visible');
    if (params.key && activeElement() !== el) throw new Error('Capture focus changed');
    checkDescription(el, !!params.key);
    /* CAPTURE_SCROLL_TEST_POINT */
    const rect = el.getBoundingClientRect();
    const box = { x: rect.left + scrollX, y: rect.top + scrollY, width: rect.width, height: rect.height };
    if (box.width <= 0 || box.height <= 0 || box.x < 0 || box.y < 0) throw new Error('Capture target has no usable box');
    // Offscreen document content can be captured without scrolling, but content
    // clipped inside another element is not painted there. Never outline it.
    let viewportBound = false, clipped = false, transformed = false;
    for (let node: Element | null = el; node; node = node.parentElement || (node.getRootNode() as ShadowRoot).host || null) {
      const style = getComputedStyle(node);
      if (style.transform !== 'none' || style.translate !== 'none' || style.scale !== 'none' || style.rotate !== 'none' || style.perspective !== 'none' || Number.parseFloat(style.zoom) !== 1) transformed = true;
      if (style.position === 'fixed' || style.position === 'sticky') viewportBound = true;
      if (node === el || node === document.documentElement || node === document.body) continue;
      if (style.overflowX !== 'visible' || style.overflowY !== 'visible') clipped = true;
      const parent = node.getBoundingClientRect();
      if (style.overflowX !== 'visible' && (rect.left < parent.left + node.clientLeft || rect.right > parent.left + node.clientLeft + node.clientWidth)
        || style.overflowY !== 'visible' && (rect.top < parent.top + node.clientTop || rect.bottom > parent.top + node.clientTop + node.clientHeight))
        throw new Error('Capture target is clipped by an ancestor');
    }
    if (clipped && transformed) throw new Error('Capture target has a transformed clipping ancestor');
    if (transformed) throw new Error('Capture target is transformed');
    // Enough page to recognise the setting, with at least 120 CSS px on each
    // side before document/viewport clipping. Large controls keep their padding
    // even when the preferred contextual size has reached its cap.
    const width = Math.max(700, Math.min(1200, 4 * box.width), box.width + 240);
    const height = Math.max(320, Math.min(700, 6 * box.height), box.height + 240);
    let x = Math.max(0, Math.floor(box.x + (box.width - width) / 2));
    let y = Math.max(0, Math.floor(box.y + (box.height - height) / 2));
    let right = Math.min(Math.max(document.documentElement.scrollWidth, innerWidth), Math.ceil(box.x + (box.width + width) / 2));
    let bottom = Math.min(Math.max(document.documentElement.scrollHeight, innerHeight), Math.ceil(box.y + (box.height + height) / 2));
    if (right < box.x + box.width || bottom < box.y + box.height) throw new Error('Capture target is outside the document');
    if (viewportBound) {
      const viewport = visualViewport;
      const left = viewport?.pageLeft ?? scrollX, top = viewport?.pageTop ?? scrollY;
      const width = viewport?.width ?? innerWidth, height = viewport?.height ?? innerHeight;
      if (box.x < left || box.y < top || box.x + box.width > left + width || box.y + box.height > top + height)
        throw new Error('Capture fixed or sticky target is outside the viewport');
      x = Math.max(x, left); y = Math.max(y, top);
      right = Math.min(right, left + width); bottom = Math.min(bottom, top + height);
    }
    return { box, clip: { x, y, width: right - x, height: bottom - y }, beyondViewport: !viewportBound,
      pixelRatio: devicePixelRatio, selector: selectorFor(el) } satisfies PageResults['captureBox'];
  }
  if (action === 'scroll') {
    if (!visible(el)) throw new Error('Element is not visible');
    const before = signature();
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    return { scrolled: true, signature: before } satisfies PageResults['scroll'];
  }
  if (action === 'scrollPosition') return { left: el.scrollLeft, top: el.scrollTop } satisfies PageResults['scrollPosition'];
  if (action === 'scrollPoint') {
    if (!visible(el)) throw new Error('Element is not visible');
    // Move the page only when the element's centre cannot be reached where it is.
    let point = centrePoint(el);
    if (!point) {
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      point = centrePoint(el);
    }
    if (!point) throw new Error('Element centre is obscured');
    // Baseline after any preparatory scroll, so only the wheel counts as change.
    const scroller = scrollerFor(el, params.dx ? 'x' : 'y');
    return { ...point, signature: signature(), scroller: selectorFor(scroller),
      left: scroller.scrollLeft, top: scroller.scrollTop } satisfies PageResults['scrollPoint'];
  }
  if (action === 'upload') {
    // The target is a file field, a label or container holding one (often hidden behind an
    // "Upload" button), or a drop zone with no field at all.
    const fields = (root: Element) => [...root.querySelectorAll<HTMLInputElement>('input[type="file" i]')];
    let input: HTMLInputElement | null = el.matches('input[type="file" i]') ? el as HTMLInputElement : null;
    if (!input && el.tagName === 'LABEL' && (el as HTMLLabelElement).control?.matches('input[type="file" i]')) input = (el as HTMLLabelElement).control as HTMLInputElement;
    if (!input) {
      const inner = fields(el);
      if (inner.length > 1) throw new Error('Several file fields are inside that element; target one of them');
      input = inner[0] || null;
    }
    const file = params.file!;
    const bytes = Uint8Array.from(atob(file.data), c => c.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], file.name, { type: file.type, lastModified: file.lastModified }));
    const before = signature();
    if (input) {
      if (input.disabled) throw new Error('The file field is disabled');
      const accept = input.accept.split(',').map(token => token.trim().toLowerCase()).filter(Boolean);
      const name = file.name.toLowerCase(), type = file.type.toLowerCase();
      if (accept.length && !accept.some(token => token.startsWith('.') ? name.endsWith(token)
        : token.endsWith('/*') ? type.startsWith(token.slice(0, -1)) : type === token)) throw new Error(`The file field accepts only ${input.accept}`);
      input.files = transfer.files;
      input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return { signature: before, via: 'input' } satisfies PageResults['upload'];
    }
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.isContentEditable)
      throw new Error('That element is not a file field, the label of one, or a drop zone');
    if (!visible(el)) throw new Error('No file field there, and the element is not visible to drop onto');
    for (const type of ['dragenter', 'dragover', 'drop']) el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, composed: true, dataTransfer: transfer }));
    return { signature: before, via: 'drop' } satisfies PageResults['upload'];
  }
  if (action === 'select') {
    if (isPassword(el)) throw new Error('Refusing password field access');
    if (el.tagName !== 'SELECT' || !visible(el) || el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true') throw new Error('Element is not an enabled select');
    if (typeof params.value !== 'string' || ![...(el as HTMLSelectElement).options].some(option => option.value === params.value && !option.disabled && !(option.parentElement as HTMLOptGroupElement | null)?.disabled)) throw new Error('No enabled option with that value');
    const before = signature();
    el.value = params.value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { selected: true, signature: before } satisfies PageResults['select'];
  }
  if (action === 'typeFocus' || action === 'typeCheck') {
    if (params.mode !== undefined && params.mode !== 'replace' && params.mode !== 'append') throw new Error('mode must be replace or append');
    assertWritable(el);
    if (action === 'typeFocus') {
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      (el as HTMLElement).focus({ preventScroll: true });
      assertWritable(el);
    }
    if (activeElement() !== el) throw new Error('Input focus moved; refusing to type');
    // Debugger focus emulation runs between typeFocus and typeCheck. Restore
    // the append caret after it, without refocusing a field that lost focus.
    if (action === 'typeFocus' || params.mode === 'append') {
      if (el.isContentEditable) {
        const range = document.createRange();
        let end: Node = el;
        if (params.mode === 'append') {
          // A container boundary after a chip can resolve inside its
          // noneditable contents. Use an editable text node outside the chip.
          while (end.lastChild && (end.lastChild.nodeType === Node.TEXT_NODE
            || end.lastChild.nodeType === Node.ELEMENT_NODE && (end.lastChild as HTMLElement).isContentEditable
              && !['BR', 'IMG', 'HR', 'INPUT', 'EMBED'].includes((end.lastChild as Element).tagName))) end = end.lastChild;
          if (end.nodeType !== Node.TEXT_NODE) {
            const br = (end.lastChild as Element | null)?.tagName === 'BR' ? end.lastChild : null;
            const text = br?.previousSibling?.nodeType === Node.TEXT_NODE ? br.previousSibling : null;
            end = text || end.insertBefore(document.createTextNode(''), br);
          }
          // Native insertion may leave the original empty anchor after its
          // new text node. Reuse the text that now owns the rendered caret.
          while (end.nodeType === Node.TEXT_NODE && !end.textContent && end.previousSibling?.nodeType === Node.TEXT_NODE) end = end.previousSibling;
          if (action === 'typeCheck') {
            state.appendCleanup?.restore();
            const parent = end.parentElement!;
            // An empty text node after a block chip has no native editing
            // position. A temporary break gives Chrome a rendered caret.
            const br = !end.textContent && parent.lastChild === end
              && (end.previousSibling as Element | null)?.tagName !== 'BR' ? document.createElement('br') : null;
            // Blink replaces leading spaces with NBSP under collapsing CSS.
            // Preserve the requested text while the trusted insert runs.
            const style = (parent as HTMLElement).style;
            const preserve = ['normal', 'nowrap', 'pre-line'].includes(getComputedStyle(parent).whiteSpace);
            const previous = preserve ? ['white-space-collapse', 'text-wrap-mode'].map(property => ({
              property, value: style.getPropertyValue(property), priority: style.getPropertyPriority(property),
            })) : [];
            const hadStyle = parent.hasAttribute('style');
            state.appendCleanup = { owner: params.appendCleanup, restore: () => {
              br?.remove();
              if (preserve && style.getPropertyValue('white-space') === 'pre-wrap' && style.getPropertyPriority('white-space') === 'important') {
                style.removeProperty('white-space');
                for (const { property, value, priority } of previous) if (value) style.setProperty(property, value, priority);
                if (!hadStyle && !style.length) {
                  // Flush Chrome's lazy CSSOM attribute serialization first.
                  parent.getAttribute('style');
                  parent.removeAttribute('style');
                }
              }
            } };
            if (br) parent.insertBefore(br, end);
            if (preserve) style.setProperty('white-space', 'pre-wrap', 'important');
          }
        }
        range.selectNodeContents(end);
        if (params.mode === 'append') range.collapse(false);
        const selection = document.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      } else if (params.mode === 'append' && !['email', 'number'].includes(el.type || '')) {
        const field = el as HTMLInputElement | HTMLTextAreaElement;
        field.setSelectionRange(field.value.length, field.value.length);
      } else if (params.mode !== 'append') (el as HTMLInputElement | HTMLTextAreaElement).select();
    }
    assertWritable(el); // Focus handlers can change the field's type or autocomplete.
    if (activeElement() !== el) throw new Error('Input focus moved; refusing to type');
    const before = signature();
    return { selector: selectorFor(el), signature: before,
      ...(params.mode === 'append' ? { expectedText: String(el.isContentEditable ? el.textContent ?? '' : el.value ?? '') + (params.text ?? '') } : {}),
      ...(params.mode === 'append' && el.isContentEditable ? { appendCleanup: action === 'typeFocus'
        ? `${state.prefix}type:${state.appendNext = (state.appendNext ?? 0) + 1}` : params.appendCleanup } : {}),
      ...(params.mode === 'append' && el.tagName === 'INPUT' && ['email', 'number'].includes(el.type || '') ? { appendNeedsEnd: true } : {}),
      combobox: el.getAttribute('role') === 'combobox' || el.tagName === 'INPUT' && ['aria-controls', 'aria-owns', 'list'].some(key => el.hasAttribute(key)) } satisfies PageResults['typeFocus' | 'typeCheck'];
  }
  if (action === 'clickPoint' || action === 'clickCheck' || action === 'hoverPoint') {
    if (!visible(el) || action !== 'hoverPoint' && (el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true')) throw new Error('Element is not interactable');
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const before = action === 'clickCheck' ? '' : signature();
    const point = centrePoint(el);
    if (!point) throw new Error('Element centre is obscured');
    const { x, y } = point;
    if (action !== 'hoverPoint') checkDescription(el);
    if (action === 'clickCheck') return { x, y } satisfies PageResults['clickCheck'];
    return { x, y, signature: before } satisfies PageResults['clickPoint' | 'hoverPoint'];
  }
  throw new Error('Unknown page operation');
  } catch (error) {
    // Chrome does not consistently return rejected executeScript promises to the
    // caller. Serialize failures so a password refusal stays a useful RPC error.
    return { __gaddiError: action.startsWith('signin') ? 'Sign-in refused' : error && typeof error === 'object' && 'message' in error && typeof error.message === 'string' ? error.message || 'Page operation failed' : 'Page operation failed',
      ...(error && typeof error === 'object' && 'code' in error && error.code === 'stale' ? { __gaddiCode: 'stale' } : {}) };
  }
}
