// This function is serialized by executeScript. Everything it needs lives inside
// it; persistent element references live in Chrome's isolated extension world.
export async function pageTask(action, params = {}) {
    try {
        const state = globalThis.__gaddiElements ||= {
            // Six uniform base64url characters: 36 random bits, available on plain HTTP.
            prefix: '@' + [...crypto.getRandomValues(new Uint8Array(6))].map(n => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-'[n & 63]).join('') + ':',
            next: 0, nodes: new Map(), ids: new WeakMap(),
        };
        if (action.startsWith('download')) {
            const capture = params.downloadCapture;
            if (!capture || typeof capture.id !== 'string' || capture.site !== location.origin)
                throw new Error('Download origin changed');
            if (action === 'downloadArm') {
                if (state.download)
                    throw new Error('A download capture is already active');
                const abort = new AbortController();
                const download = { id: capture.id, site: capture.site, busy: false, stop: () => { } };
                // DOWNLOAD: intercept only a same-origin blob/filesystem anchor. Never navigate to
                // an arbitrary scheme, inspect another origin, or export bytes to page/agent code.
                const listener = (event) => {
                    const anchor = event.composedPath().find(node => node instanceof HTMLAnchorElement);
                    if (!anchor)
                        return;
                    const href = anchor.href;
                    if (!/^(?:blob:|filesystem:)/.test(href))
                        return;
                    event.preventDefault();
                    event.stopImmediatePropagation();
                    if (download.busy)
                        return;
                    download.busy = true;
                    let url;
                    try {
                        url = new URL(href.replace(/^filesystem:/, ''));
                    }
                    catch {
                        download.error = 'Invalid generated download';
                        return;
                    }
                    if (url.origin !== capture.site) {
                        download.error = 'Generated download belongs to a different site';
                        return;
                    }
                    void (async () => {
                        const response = await fetch(href, { signal: abort.signal, redirect: 'error' });
                        if (!response.ok || !response.body)
                            throw new Error();
                        const reader = response.body.getReader(), pieces = [];
                        let size = 0;
                        while (true) {
                            const { done, value } = await reader.read();
                            if (done)
                                break;
                            size += value.byteLength;
                            if (size > 20 * 1024 * 1024) {
                                await reader.cancel();
                                download.error = 'Download exceeds 20 MB';
                                return;
                            }
                            pieces.push(value);
                        }
                        const bytes = new Uint8Array(size);
                        let offset = 0;
                        for (const piece of pieces) {
                            bytes.set(piece, offset);
                            offset += piece.byteLength;
                        }
                        if (!abort.signal.aborted)
                            download.data = bytes;
                    })().catch(() => { download.error ||= 'Generated download could not be captured'; });
                };
                const timer = setTimeout(() => { download.stop(); if (state.download === download)
                    delete state.download; }, 15000);
                download.stop = () => { clearTimeout(timer); document.removeEventListener('click', listener, true); abort.abort(); };
                state.download = download;
                document.addEventListener('click', listener, true);
                return { armed: true };
            }
            const download = state.download;
            if (!download || download.id !== capture.id || download.site !== capture.site)
                throw new Error('Download capture expired or page changed');
            if (action === 'downloadEnd') {
                download.stop();
                delete state.download;
                return { ended: true };
            }
            if (action === 'downloadPoll')
                return { ready: !!download.data, ...(download.data ? { bytes: download.data.length, chunks: Math.max(1, Math.ceil(download.data.length / (192 * 1024))) } : {}), ...(download.error ? { error: download.error } : {}) };
            if (action === 'downloadChunk') {
                const index = capture.index;
                if (!download.data || typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0 || index >= Math.max(1, Math.ceil(download.data.length / (192 * 1024))))
                    throw new Error('Invalid download chunk');
                let binary = '';
                for (const byte of download.data.subarray(index * 192 * 1024, (index + 1) * 192 * 1024))
                    binary += String.fromCharCode(byte);
                return { data: btoa(binary) };
            }
            throw new Error('Unsupported download action');
        }
        if (action === 'typeCleanup') {
            if (state.appendCleanup && state.appendCleanup.owner === params.appendCleanup) {
                state.appendCleanup.restore();
                delete state.appendCleanup;
            }
            return {};
        }
        if (action === 'animationSpeed') {
            // The extension transport excludes CDP Animation. Adjust real animation
            // objects, never document.timeline, JavaScript timers, or page clocks.
            if (params.reset) {
                if (state.motion) {
                    cancelAnimationFrame(state.motion.frame ?? 0);
                    for (const [animation, rate] of state.motion.originals)
                        animation.updatePlaybackRate(rate);
                    delete state.motion;
                }
            }
            else {
                const motion = state.motion ||= { originals: new Map() };
                motion.speed = params.animationSpeed;
                cancelAnimationFrame(motion.frame ?? 0);
                const update = () => {
                    const current = new Set(document.getAnimations());
                    for (const [animation, rate] of motion.originals)
                        if (!current.has(animation)) {
                            animation.updatePlaybackRate(rate);
                            motion.originals.delete(animation);
                        }
                    for (const animation of current) {
                        if (!motion.originals.has(animation))
                            motion.originals.set(animation, animation.playbackRate);
                        const rate = motion.originals.get(animation) * motion.speed;
                        if (animation.playbackRate !== rate)
                            animation.updatePlaybackRate(rate);
                    }
                    motion.frame = requestAnimationFrame(update);
                };
                update();
            }
            return { animationSpeed: params.reset ? 1 : params.animationSpeed };
        }
        const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        function resolve(selector) {
            if (typeof selector !== 'string' || !selector)
                throw new Error('A selector is required');
            if (selector === ':focus')
                return activeElement() || document.body;
            if (selector.startsWith('@') || selector.startsWith('gaddi:')) {
                const node = state.nodes.get(selector);
                if (!selector.startsWith(state.prefix) || !node?.isConnected)
                    throw new Error('Stale selector; read the page again');
                return node;
            }
            const nodes = document.querySelectorAll(selector);
            if (nodes.length !== 1)
                throw new Error(`Selector must match exactly one element (matched ${nodes.length})`);
            return nodes[0];
        }
        function selectorFor(el) {
            let selector = state.ids.get(el);
            if (!selector) {
                selector = `${state.prefix}${(++state.next).toString(36)}`;
                state.ids.set(el, selector);
            }
            state.nodes.set(selector, el); // Reattached nodes may have been pruned from the strong map.
            return selector;
        }
        // What a person can put a finger on. `hidden` and `inert` are out because the page itself hides
        // them; `aria-hidden` is NOT, because it only tells a screen reader to skip a region, and whole
        // course players wrap their real controls in it. A control a person can see and press is a
        // control an agent may press.
        function visible(el) {
            const style = getComputedStyle(el);
            return !el.closest('[hidden], [inert]')
                && style.visibility !== 'hidden' && style.visibility !== 'collapse'
                && style.display !== 'none' && el.getClientRects().length > 0;
        }
        // What a reader may be told. Text behind `aria-hidden` is decoration for assistive tools, so it
        // is never offered as page content or as a ref, even though a click on it still lands.
        function readable(el) {
            return visible(el) && !el.closest('[aria-hidden="true"]');
        }
        function nameOf(el, seen = new Set()) {
            /* NAME_RESOLUTION_TEST_POINT */
            if (seen.has(el))
                return '';
            seen.add(el);
            const refs = clean(el.getAttribute('aria-labelledby')).split(' ').filter(Boolean);
            if (refs.length) {
                const root = el.getRootNode();
                const name = clean(refs.map(id => {
                    const ref = 'getElementById' in root ? root.getElementById(id) : undefined;
                    return ref ? nameOf(ref, seen) : '';
                }).join(' '));
                if (name)
                    return name;
            }
            const aria = clean(el.getAttribute('aria-label'));
            if (aria)
                return aria;
            if (el.labels?.length)
                return clean([...el.labels].map(label => label.textContent).join(' '));
            if (el.tagName === 'IMG' || (el.tagName === 'INPUT' && el.type === 'image'))
                return clean(el.getAttribute('alt'));
            if (el.tagName === 'INPUT') {
                if (['button', 'submit', 'reset'].includes(el.type || ''))
                    return clean(el.value || (el.type === 'submit' ? 'Submit' : el.type === 'reset' ? 'Reset' : ''));
                return clean(el.getAttribute('title') || el.getAttribute('placeholder'));
            }
            if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
                return clean(el.getAttribute('title') || el.getAttribute('placeholder'));
            // Include descendant image alternatives, but never read a form value as a name. A form control
            // inside the element carries this element's own text in its labels, so counting it again would
            // say a label's words twice (and a gate would read the same prose twice).
            const content = [...el.childNodes].map(node => node.nodeType === Node.TEXT_NODE ? node.textContent
                : node.nodeType === Node.ELEMENT_NODE && !node.matches('script, style, [aria-hidden="true"], input, select, textarea') ? nameOf(node, seen) : '').join(' ');
            return clean(content || el.getAttribute('title'));
        }
        function roleOf(el) {
            const explicit = clean(el.getAttribute('role')).split(' ')[0];
            if (explicit)
                return explicit;
            const roles = { BUTTON: 'button', A: el.hasAttribute('href') ? 'link' : '', INPUT: 'textbox',
                TEXTAREA: 'textbox', SELECT: el.multiple || (el.size ?? 0) > 1 ? 'listbox' : 'combobox', SUMMARY: 'button',
                MAIN: 'main', NAV: 'navigation', ASIDE: 'complementary', SEARCH: 'search',
                HEADER: el.closest('article, aside, main, nav, section') ? '' : 'banner',
                FOOTER: el.closest('article, aside, main, nav, section') ? '' : 'contentinfo',
                FORM: el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby') ? 'form' : '',
                SECTION: el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby') ? 'region' : '',
            };
            if (el.tagName === 'INPUT') {
                return { hidden: '', checkbox: 'checkbox', radio: 'radio', range: 'slider', number: 'spinbutton',
                    search: 'searchbox', button: 'button', submit: 'button', reset: 'button', image: 'button' }[el.type || ''] ?? 'textbox';
            }
            return roles[el.tagName] || (/^H[1-6]$/.test(el.tagName) ? 'heading' : el.isContentEditable ? 'textbox' : floatingRole(el) || ((el.tabIndex ?? -1) >= 0 ? 'generic' : ''));
        }
        // Event-delegated menus often have no ARIA roles or DOM onclick property.
        // Infer controls only inside floating layers, and keep one ref per item.
        const floatingGroups = new WeakMap();
        function floatingRole(el) {
            if (!(el instanceof HTMLElement) || !['DIV', 'SPAN', 'LI'].includes(el.tagName))
                return '';
            const handlesClick = (node) => typeof node.onclick === 'function' || node.hasAttribute('onclick') || node.tabIndex >= 0;
            const clickable = (node) => getComputedStyle(node).cursor === 'pointer' || handlesClick(node);
            function group(node) {
                const cached = action === 'read' ? floatingGroups.get(node) : undefined;
                if (cached !== undefined)
                    return cached;
                const children = [...node.children].filter(child => ['DIV', 'LI'].includes(child.tagName) && readable(child) && clickable(child));
                // Grouping propagates through any number of wrappers. An item with its
                // own handler keeps its title/description children as one click surface.
                const grouped = children.some(group) || (handlesClick(node)
                    ? children.filter(handlesClick).length > 1 : children.length > 1);
                if (action === 'read')
                    floatingGroups.set(node, grouped);
                return grouped;
            }
            if (!clickable(el) && (el.tabIndex ?? -1) < 0)
                return '';
            if (group(el))
                return ''; // A pointer-cursor menu wrapper is not one aggregate choice.
            for (let parent = el.parentElement; parent; parent = parent.parentElement || parent.getRootNode().host) {
                const role = parent.getAttribute('role');
                if (['button', 'link', 'menuitem', 'option', 'tab'].includes(role || '') || parent.matches('button, a[href]'))
                    return '';
                const style = getComputedStyle(parent);
                if (parent.matches('[popover], [data-radix-popper-content-wrapper], [data-popper-placement]')
                    || ['menu', 'listbox'].includes(role || '')
                    || ['absolute', 'fixed'].includes(style.position) && Number(style.zIndex) > 0) {
                    return role === 'listbox' ? 'option' : role === 'menu' ? 'menuitem' : 'button';
                }
                if (clickable(parent) && !group(parent))
                    return ''; // A label/icon inherits the item's pointer cursor.
            }
            return '';
        }
        function isPassword(el) {
            // Invariant: input never reaches a password target, even if daemon policy is
            // bypassed. Autocomplete may include section tokens before the password token.
            return typeof el.type === 'string' && el.type.toLowerCase() === 'password'
                || /(?:^|\s)(?:current-password|new-password)(?:\s|$)/i.test(el.getAttribute('autocomplete') || '');
        }
        function hiddenValue(el) {
            return isPassword(el) || el.tagName === 'INPUT' && ['hidden', 'file'].includes(el.type || '')
                || /(?:^|\s)(?:cc-number|cc-csc|cc-exp\S*|one-time-code)(?:\s|$)/i.test(el.getAttribute('autocomplete') || '');
        }
        const short = (value) => { const text = String(value ?? ''); return text.length > 80 ? text.slice(0, 79) + '…' : text; };
        function controlState(el) {
            /* OUTLINE_STATE_TEST_POINT */
            const parts = [], role = roleOf(el);
            if (el.tagName === 'SELECT') {
                const options = [...el.options];
                parts.push(hiddenValue(el) ? 'value=(hidden)' : `value=${JSON.stringify(short(options.filter(o => o.selected).map(o => o.label).join('|')))}`);
                if (!hiddenValue(el)) {
                    const enabled = options.filter(o => !o.disabled && !o.parentElement?.disabled);
                    parts.push(`options=${JSON.stringify(enabled.slice(0, 20).map(o => `${short(o.value)}:${short(o.label)}`).join('|') + (enabled.length > 20 ? '|…' : ''))}`);
                }
            }
            else if (hiddenValue(el))
                parts.push('value=(hidden)');
            else if (el.tagName === 'TEXTAREA' || el.isContentEditable
                || ['textbox', 'searchbox', 'spinbutton', 'combobox', 'slider'].includes(role)) {
                parts.push(`value=${JSON.stringify(short(el.value ?? el.getAttribute('aria-valuetext') ?? el.getAttribute('aria-valuenow') ?? el.textContent))}`);
            }
            if (['checkbox', 'radio', 'switch'].includes(role)) {
                const checked = el.getAttribute('aria-checked') ?? (el.indeterminate ? 'mixed' : String(el.checked ?? false));
                parts.push(checked === 'true' ? 'checked' : checked === 'mixed' ? 'mixed' : 'unchecked');
            }
            for (const key of ['expanded', 'selected', 'pressed'])
                if (el.hasAttribute(`aria-${key}`))
                    parts.push(`${key}=${el.getAttribute(`aria-${key}`)}`);
            if (el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true')
                parts.push('disabled');
            return parts.length ? ' ' + parts.join(' ') : '';
        }
        function accessibleName(el) {
            // Landmarks and generic containers get their names from authors, not all of
            // their descendant text. Otherwise one main landmark can swallow the outline.
            if ((['main', 'navigation', 'complementary', 'banner', 'contentinfo', 'search', 'form', 'region', 'generic'].includes(roleOf(el))
                || ['BODY', 'HTML'].includes(el.tagName)) && !el.hasAttribute('aria-label') && !el.hasAttribute('aria-labelledby')) {
                return clean(el.getAttribute('title'));
            }
            return nameOf(el);
        }
        function describe(el) {
            // Invariant: clicking a child icon is described as clicking its interactive
            // ancestor, so it cannot hide the button/link name or destination from gates.
            const interactive = interactiveOf(el), { activationTarget } = activation(el, interactive);
            return { selector: selectorFor(el), tag: el.tagName.toLowerCase(), type: el.getAttribute('type') || (typeof el.type === 'string' ? el.type : ''),
                autocomplete: el.getAttribute('autocomplete') || '', role: roleOf(el), name: accessibleName(interactive),
                href: interactive.closest('a[href]')?.href || '', submitName: activationTarget ? nameOf(activationTarget) : '',
                password: isPassword(el), disabled: el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true',
                choice: isChoice(el, interactive) };
        }
        // What the gates judge beyond a control's own name. Only for the one element an action is about: an outline
        // describes every control, and these read the form or the page around each.
        function gateFacts(el) {
            const interactive = interactiveOf(el), { pressed, activationTarget } = activation(el, interactive);
            // KEY-CHOICE: Space presses the focused button or menu item itself, never a form's default button.
            const spaceTarget = ['button', 'menuitem'].includes(roleOf(pressed)) ? pressed : undefined;
            const chosen = el.tagName === 'SELECT' && typeof params.value === 'string'
                ? [...el.options].find(option => option.value === params.value) : undefined;
            // A details summary only opens its section, and a link goes somewhere: neither sends a form.
            const commitFrom = roleOf(interactive) === 'button' && interactive.tagName !== 'SUMMARY' ? interactive : undefined;
            const enterFrom = activationTarget && roleOf(activationTarget) !== 'link' && activationTarget.tagName !== 'SUMMARY' ? activationTarget
                : el.form ? el : undefined;
            return {
                // TX-BIND: a digest of the transaction this control acts on (its form, dialog or composer); '' when it is in none.
                transaction: transactionDigest(interactive),
                // CONTAINER-VERB: the visible controls inside what the click lands on, so the broker can tell a panel whose name is
                // all its text (its buttons' names included) from one of those buttons.
                controls: innerControls(interactive),
                // SELECT-CHOICE: the option this value picks (the first with that value, as the page's own select does).
                ...(el.tagName === 'SELECT' && typeof params.value === 'string' ? { chosen: chosen ? optionNames(chosen) : [] } : {}),
                // COMMIT-CHOICES: a button commits the choices that are on in its form (or dialog, or page); null is not a button.
                committed: commitFrom ? committedChoices(commitFrom) : null,
                // KEY-CHOICE: what a key on this focused element can choose, press, or commit.
                keyChoices: keyChoices(el), spaceName: spaceTarget ? nameOf(spaceTarget) : '',
                ...(enterFrom ? { enterCommits: committedChoices(enterFrom) } : {}),
                ...(spaceTarget && spaceTarget.tagName !== 'SUMMARY' ? { spaceCommits: committedChoices(spaceTarget) } : {}),
                // KEY-EFFECT: what Cmd/Ctrl+Enter in this text field may press: the visible buttons of its form or dialog.
                composer: composerButtons(el)
            };
        }
        // CONTAINER-VERB invariant: counts the visible controls strictly inside el (el itself never counts), at most 50. A real
        // button holds none, so its name is still judged as a whole; only an element that holds two or more is a container.
        const INNER_CONTROLS = 'button, a[href], input, select, textarea, summary, [role="button"], [role="link"], [role="menuitem"], '
            + '[role="tab"], [role="checkbox"], [role="radio"], [role="switch"], [role="option"]';
        function innerControls(el) {
            let count = 0;
            for (const node of el.querySelectorAll(INNER_CONTROLS))
                if (node !== el && visible(node) && ++count >= 50)
                    break;
            return count;
        }
        // KEY-EFFECT: in a text field, Cmd/Ctrl+Enter is the composer's send. Invariant: the names of every visible button in the
        // nearest form, else the nearest dialog, around a focused text field (shadow roots included); [] for any other focus.
        // The broker judges each as its click would be, and this fact can only add a hold: a page that hides its Send button
        // from this list hides it from the user's screen too, and then Enter-submits and the site table still apply.
        function composerButtons(el) {
            const role = roleOf(el);
            if (el.tagName !== 'TEXTAREA' && !['textbox', 'searchbox', 'combobox', 'spinbutton'].includes(role))
                return [];
            const scope = (el.form || el.closest('form') || el.closest('dialog, [role="dialog"], [role="alertdialog"]'));
            if (!scope)
                return [];
            const buttons = deepAll(scope, 'button, [role="button"], input[type="submit"], input[type="button"], input[type="image"]')
                .filter(button => visible(button) && roleOf(button) === 'button');
            return unique(buttons.map(button => nameOf(button)));
        }
        const INTERACTIVE = 'button, a[href], [role="button"], [role="link"], [role="menuitem"], [role="tab"], input[type="submit"], input[type="button"], input[type="image"], summary, label';
        function interactiveOf(el) { return el.closest(INTERACTIVE) || el; }
        function activeDescendant(el) {
            const id = el.getAttribute('aria-activedescendant');
            if (!id)
                return null;
            const root = el.getRootNode();
            return 'getElementById' in root ? root.getElementById(id) : null;
        }
        // What Enter on el presses: a focused button, link or menu item itself (or the item a list or menu that keeps the
        // focus points at, aria-activedescendant), else the form's default button for implicit submission from a field.
        function activation(el, interactive) {
            const form = el.form || el.closest('form');
            const submit = form && [...form.elements].find((control) => !control.disabled && ((control.tagName === 'BUTTON' && control.type === 'submit')
                || (control.tagName === 'INPUT' && ['submit', 'image'].includes(control.type || ''))));
            const pointed = activeDescendant(el), pressed = pointed ? interactiveOf(pointed) : interactive;
            return { pressed, activationTarget: ['button', 'link', 'menuitem'].includes(roleOf(pressed)) ? pressed : submit };
        }
        // Every element matching selector under root, through open shadow roots.
        function deepAll(root, selector) {
            const found = [...root.querySelectorAll(selector)];
            for (const node of root.querySelectorAll('*'))
                if (node.shadowRoot)
                    found.push(...deepAll(node.shadowRoot, selector));
            return found;
        }
        // Never cut short: the broker refuses a list too long to judge rather than judge part of it.
        const unique = (names) => [...new Set(names.map(clean).filter(Boolean))];
        // SELECT-CHOICE: the words a gate reads for one option: what the list shows, its text, its own label and its group's.
        function optionNames(option) {
            const group = option.parentElement?.tagName === 'OPTGROUP' ? option.parentElement.label : '';
            return unique([option.label, option.text, option.getAttribute('aria-label') || '', group]);
        }
        const enabledOption = (option) => !option.disabled && !option.parentElement?.disabled;
        const CHOICE_ROLES = '[role="checkbox"], [role="radio"], [role="switch"], [role="option"], [role="menuitemcheckbox"], [role="menuitemradio"]';
        // COMMIT-CHOICES: the names of the choices that are on where a button acts: its form (with every control that names
        // that form), else the dialog it sits in, else its whole document minus the choices of other forms (those go with
        // their own buttons). Checked boxes and radios, selected options and ARIA choices marked checked or selected count,
        // whoever turned them on (the page, a key, a click).
        function committedChoices(button) {
            const form = button.form || button.closest('form');
            const scope = form ? [...form.elements]
                : deepAll(button.closest('dialog, [role="dialog"], [role="alertdialog"]') || document, `input, select, ${CHOICE_ROLES}`)
                    .filter(control => !control.form && !control.closest('form'));
            if (form)
                scope.push(...deepAll(form, CHOICE_ROLES));
            const names = [];
            for (const control of scope) {
                if (control.matches(':disabled'))
                    continue;
                if (control.tagName === 'SELECT') {
                    for (const option of control.selectedOptions)
                        names.push(...optionNames(option));
                }
                else if (control.tagName === 'INPUT') {
                    if (['checkbox', 'radio'].includes((control.type || '').toLowerCase()) && control.checked)
                        names.push(nameOf(control));
                }
                else if (control.matches(CHOICE_ROLES) && (control.getAttribute('aria-checked') === 'true' || control.getAttribute('aria-selected') === 'true')) {
                    names.push(nameOf(control));
                }
            }
            return unique(names);
        }
        // KEY-CHOICE: every choice a key on this focused element could turn on. A select picks any enabled option by its
        // letters or arrows; arrows move a radio to the others of its group; Space toggles a checkbox; a list or menu that
        // points at an item picks that item.
        function keyChoices(el) {
            const names = [];
            const group = (node) => {
                const role = roleOf(node);
                if (node.tagName === 'INPUT' && (node.type || '').toLowerCase() === 'radio') {
                    const radios = node.form ? [...node.form.elements] : deepAll(node.getRootNode(), 'input[type="radio"]');
                    const name = node.getAttribute('name');
                    for (const radio of radios)
                        if (radio === node || name && radio.tagName === 'INPUT' && (radio.type || '').toLowerCase() === 'radio'
                            && radio.getAttribute('name') === name)
                            names.push(nameOf(radio));
                }
                else if (['radio', 'option', 'menuitemradio'].includes(role)) {
                    const container = node.closest('[role="radiogroup"], [role="listbox"], [role="menu"], [role="menubar"], [role="group"]');
                    for (const item of container ? deepAll(container, CHOICE_ROLES) : [node])
                        names.push(nameOf(item));
                }
                else if (isChoice(node, interactiveOf(node)))
                    names.push(accessibleName(interactiveOf(node)));
            };
            if (el.tagName === 'SELECT') {
                for (const option of el.options)
                    if (enabledOption(option))
                        names.push(...optionNames(option));
                names.push(accessibleName(interactiveOf(el)));
            }
            else
                group(el);
            if (['listbox', 'radiogroup'].includes(roleOf(el)))
                for (const item of deepAll(el, CHOICE_ROLES))
                    names.push(nameOf(item));
            const pointed = activeDescendant(el);
            if (pointed)
                group(pointed);
            return unique(names);
        }
        // A click that toggles a choice performs nothing: the words of a checkbox, a radio, an
        // option or the label of one describe what is being chosen, not what the page will do.
        // A gate that reads an action verb out of that prose asks the user about an answer.
        function isChoice(el, interactive) {
            for (const node of [interactive, el]) {
                const label = (node.tagName === 'LABEL' ? node : node.closest('label'));
                const control = label?.control;
                if (control && control.tagName === 'INPUT' && ['checkbox', 'radio'].includes((control.type || '').toLowerCase()))
                    return true;
            }
            return ['checkbox', 'radio', 'option', 'switch'].includes(roleOf(interactive));
        }
        function activeElement() {
            let el = document.activeElement;
            while (el?.shadowRoot?.activeElement)
                el = el.shadowRoot.activeElement;
            return el;
        }
        // The middle of the part of el inside the viewport, or null when the page shows something else there.
        function centrePoint(el) {
            const rect = el.getBoundingClientRect();
            const x = (Math.max(0, rect.left) + Math.min(innerWidth, rect.right)) / 2;
            const y = (Math.max(0, rect.top) + Math.min(innerHeight, rect.bottom)) / 2;
            let hit = document.elementFromPoint(x, y);
            while (hit?.shadowRoot?.elementFromPoint(x, y) && hit.shadowRoot.elementFromPoint(x, y) !== hit)
                hit = hit.shadowRoot.elementFromPoint(x, y);
            return hit && (hit === el || el.contains(hit)) ? { x, y } : null;
        }
        // The element at a point the user can see, looked through open shadows.
        function pointElement(at) {
            if (!Number.isFinite(at.x) || !Number.isFinite(at.y) || at.x < 0 || at.y < 0 || at.x > innerWidth || at.y > innerHeight)
                return null;
            let hit = document.elementFromPoint(at.x, at.y);
            while (hit?.shadowRoot?.elementFromPoint(at.x, at.y) && hit.shadowRoot.elementFromPoint(at.x, at.y) !== hit)
                hit = hit.shadowRoot.elementFromPoint(at.x, at.y);
            return hit;
        }
        // The nearest element, from el upwards, that a wheel on this axis can really scroll; else the page.
        // overflow:hidden is skipped on purpose: the wheel chains past it, so it is not where the scroll lands.
        function scrollerFor(el, axis) {
            for (let node = el; node && node !== document.body && node !== document.documentElement; node = node.parentElement || node.getRootNode().host || null) {
                const style = getComputedStyle(node);
                if (axis === 'x' ? /^(?:auto|scroll|overlay)$/.test(style.overflowX) && node.scrollWidth > node.clientWidth
                    : /^(?:auto|scroll|overlay)$/.test(style.overflowY) && node.scrollHeight > node.clientHeight)
                    return node;
            }
            return document.scrollingElement || document.documentElement;
        }
        function checkDescription(el, enter = false) {
            /* CHECKED_DESCRIPTION_TEST_POINT */
            const checked = params.checkedDescription;
            if (!checked)
                return;
            // FRAME-BIND: a control checked inside an embedded document is pressed only while that document is still the same site.
            if (checked.origin !== undefined && checked.origin !== location.origin)
                throw new Error('That control is now in a different document than the one checked; look again');
            const facts = ['chosen', 'committed', 'keyChoices', 'spaceName', 'enterCommits', 'spaceCommits', 'composer', 'transaction' /* TX_CHECK_TEST_POINT */];
            // The page around the control is read again only when the gate judged it.
            const current = { ...describe(el), ...(facts.some(key => key in checked) ? gateFacts(el) : {}) };
            if (enter ? 'submitName' in checked && current.submitName !== checked.submitName : current.name !== checked.name || current.href !== checked.href)
                throw new Error('Element changed since it was checked; look again');
            // SELECT-CHOICE, COMMIT-CHOICES, KEY-CHOICE: the option, the choices a commit sends and what a key can pick are
            // bound as the gate judged them; a page that swaps one in afterwards gets nothing done. TX-BIND: so is the digest of
            // the transaction around the control, so an amount, recipient or message changed after approval stops the input.
            for (const key of facts) {
                if (key in checked && JSON.stringify(current[key] ?? null) !== JSON.stringify(checked[key]))
                    throw new Error('Element changed since it was checked; look again');
            }
        }
        // TX-BIND: what an approved action does is more than the name of its button. "Pay" sends the amount and recipient
        // of its form; "Send" sends the recipients and body of its composer. Invariant: the digest covers the values of the
        // visible, non-secret controls of the transaction the control belongs to (its form, else its dialog, else the
        // nearest container around it that holds a control: a composer), and that container's visible text. Only the digest
        // crosses the wire; no value does. Secrets (passwords, hidden and file inputs, card and one-time codes: hiddenValue)
        // are left out, and so is text that changes by itself: live regions, status lines, timers, logs, alerts, progress
        // (TX_CHURN). A page whose own clock ticks inside the very form is the residual case; it fails closed (asks again).
        const TX_CONTROLS = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="searchbox"], '
            + '[role="combobox"], [role="spinbutton"], [role="slider"], [role="checkbox"], [role="radio"], [role="switch"]';
        const TX_CHURN = '[aria-live]:not([aria-live="off"]), [role="status"], [role="timer"], [role="marquee"], [role="log"], [role="alert"], '
            + '[role="progressbar"], output' /* TX_CHURN_TEST_POINT */;
        const TX_SKIP = `script, style, noscript, template, textarea, select, ${TX_CHURN}`;
        const upward = (node) => node.parentElement || node.getRootNode().host || null;
        function txControl(control) {
            const type = (control.type || '').toLowerCase();
            return !hiddenValue(control) && visible(control) && !control.closest(TX_CHURN)
                && !(control.tagName === 'INPUT' && ['submit', 'button', 'reset', 'image'].includes(type));
        }
        function transactionScope(el) {
            const form = el.form || el.closest('form');
            if (form)
                return form;
            const dialog = el.closest('dialog, [role="dialog"], [role="alertdialog"]');
            if (dialog)
                return dialog;
            for (let node = upward(el); node && node !== document.body && node !== document.documentElement; node = upward(node)) {
                if (deepAll(node, TX_CONTROLS).some(control => control !== el && txControl(control)))
                    return node;
            }
            return null;
        }
        function txValue(control) {
            const type = (control.type || '').toLowerCase();
            if (control.tagName === 'INPUT' && ['checkbox', 'radio'].includes(type))
                return String(!!control.checked);
            if (control.tagName === 'SELECT')
                return [...control.selectedOptions].map(option => option.value).join('\u0001');
            if (control.tagName === 'INPUT' || control.tagName === 'TEXTAREA')
                return String(control.value ?? '');
            return [control.getAttribute('aria-checked'), control.getAttribute('aria-valuenow'), control.getAttribute('aria-valuetext'), control.textContent].join('\u0001');
        }
        function transactionDigest(el) {
            const scope = transactionScope(el);
            if (!scope)
                return '';
            const controls = new Set(scope.tagName === 'FORM' ? [...scope.elements] : []);
            for (const control of deepAll(scope, TX_CONTROLS))
                controls.add(control);
            const values = [];
            for (const control of controls)
                if (txControl(control)) {
                    values.push([`${control.tagName}:${(control.type || '').toLowerCase()}:${control.getAttribute('name') || ''}`, txValue(control)]);
                }
            const text = [];
            let budget = 50000;
            const walk = (root) => {
                for (const child of root.childNodes) {
                    if (--budget < 0)
                        return;
                    if (child.nodeType === 3 /* text */) {
                        const parent = child.parentElement;
                        if (child.nodeValue?.trim() && (!parent || getComputedStyle(parent).visibility === 'visible'))
                            text.push(child.nodeValue);
                    }
                    else if (child.nodeType === 1 /* element */) {
                        const element = child;
                        if (element.matches(TX_SKIP) || !element.checkVisibility())
                            continue;
                        if (element.shadowRoot)
                            walk(element.shadowRoot);
                        walk(element);
                    }
                }
            };
            walk(scope);
            return sha256(JSON.stringify([values, text.join(' ').replace(/\s+/g, ' ').trim(), budget < 0]));
        }
        // SHA-256 (FIPS 180-4), here because this function runs alone in the page and crypto.subtle is missing on plain HTTP.
        function sha256(message) {
            const bytes = new TextEncoder().encode(message), words = new Uint32Array((((bytes.length + 8) >> 6) + 1) << 4);
            for (let i = 0; i < bytes.length; i++)
                words[i >> 2] |= bytes[i] << (24 - (i & 3) * 8);
            words[bytes.length >> 2] |= 0x80 << (24 - (bytes.length & 3) * 8);
            words[words.length - 2] = Math.floor(bytes.length / 0x20000000);
            words[words.length - 1] = (bytes.length * 8) >>> 0;
            const k = [], hash = [];
            for (let n = 2, found = 0; found < 64; n++) {
                let prime = true;
                for (let d = 2; d * d <= n; d++)
                    if (n % d === 0) {
                        prime = false;
                        break;
                    }
                if (!prime)
                    continue;
                if (found < 8)
                    hash.push((Math.sqrt(n) % 1) * 0x100000000 >>> 0);
                k.push((Math.cbrt(n) % 1) * 0x100000000 >>> 0);
                found++;
            }
            const w = new Uint32Array(64), rotr = (x, n) => (x >>> n) | (x << (32 - n));
            for (let block = 0; block < words.length; block += 16) {
                for (let t = 0; t < 64; t++)
                    w[t] = t < 16 ? words[block + t]
                        : (rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3)) + w[t - 16] + (rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10)) + w[t - 7];
                let [a, b, c, d, e, f, g, h] = hash;
                for (let t = 0; t < 64; t++) {
                    const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + k[t] + w[t]) | 0;
                    const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
                    h = g;
                    g = f;
                    f = e;
                    e = (d + t1) | 0;
                    d = c;
                    c = b;
                    b = a;
                    a = (t1 + t2) | 0;
                }
                [a, b, c, d, e, f, g, h].forEach((value, i) => { hash[i] = (hash[i] + value) | 0; });
            }
            return hash.map(value => (value >>> 0).toString(16).padStart(8, '0')).join('');
        }
        function fnvAccumulator() {
            let hash = 2166136261;
            const add = (value) => {
                const text = String(value ?? ''), imul = Math.imul;
                let digest = hash;
                for (let i = 0; i < text.length; i++)
                    digest = imul(digest ^ text.charCodeAt(i), 16777619);
                hash = imul(digest ^ 0, 16777619);
            };
            return { add, digest: () => hash >>> 0 };
        }
        const controls = 'input, textarea, select, [contenteditable], [role="textbox"], [role="searchbox"], [role="spinbutton"], [role="combobox"], [role="checkbox"], [role="radio"], [role="switch"], [aria-checked], [aria-expanded], [aria-selected], [aria-pressed], [aria-valuenow], [aria-valuetext]';
        function pageVersion() {
            const { add, digest } = fnvAccumulator();
            add(location.href);
            add(performance.timeOrigin);
            // One targeted query, no text, layout, focus, values or control state.
            for (const el of document.querySelectorAll(controls + ', a[href], button')) {
                add(selectorFor(el));
                add(el.tagName);
                add(el.getAttribute('type'));
                add(el.matches('a[href]') ? el.href : '');
                add(el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true');
            }
            return `v1-${digest()}`;
        }
        function signature() {
            // Values stay in the isolated world. Only a digest crosses the wire.
            const { add, digest } = fnvAccumulator();
            add(location.href);
            add(document.title);
            add(scrollX);
            add(scrollY);
            const focused = activeElement();
            add(focused ? selectorFor(focused) : '');
            function walk(root) {
                for (const el of root.querySelectorAll(controls)) {
                    add(selectorFor(el));
                    add(el.value ?? el.textContent);
                    add(el.checked);
                    add(el.indeterminate);
                    add(el.disabled);
                    for (const key of ['checked', 'expanded', 'selected', 'pressed', 'valuenow', 'valuetext'])
                        add(el.getAttribute(`aria-${key}`));
                    if (el.tagName === 'SELECT')
                        for (const option of el.options)
                            add(option.selected);
                }
                add((root === document ? document.body : root)?.textContent);
                // Shadow hosts have no CSS selector. This cheap pass only discovers roots;
                // control state is read by the targeted query above, including nested roots.
                for (const el of root === document ? document.getElementsByTagName('*') : root.querySelectorAll('*')) {
                    if (el.shadowRoot)
                        walk(el.shadowRoot);
                }
            }
            walk(document);
            const hash = digest();
            return `${performance.timeOrigin}:${hash >>> 0}`;
        }
        function assertWritable(el) {
            // Invariant: typed text reaches a password field only as the broker's 1Password fill (params.fill). That fill
            // names this page's own origin and targets a password field on it; its text came from 1Password, never from an agent.
            if (params.fill) {
                const site = params.fill.site, page = new URL(location.href);
                if (typeof site !== 'string' || page.origin !== site || page.username || page.password)
                    throw new Error('1Password fill refused: the page changed site');
                if (el.tagName !== 'INPUT' || !isPassword(el))
                    throw new Error('1Password fills only a password field');
            }
            else if (isPassword(el))
                throw new Error('Refusing to type into a password field');
            if (!visible(el) || el.matches(':disabled') || el.readOnly || el.getAttribute('aria-disabled') === 'true')
                throw new Error('Element is not writable');
            if (!(el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'INPUT'
                && ['text', 'search', 'email', 'url', 'tel', 'number', ...(params.fill ? ['password'] : [])].includes(el.type || '')))
                throw new Error('Element is not a text input');
        }
        function signinSite() {
            const site = params.signin?.site;
            if (typeof site !== 'string')
                throw new Error('Sign-in refused');
            const url = new URL(site), page = new URL(location.href);
            if (url.origin !== site || url.username || url.password || page.username || page.password
                || page.origin !== site || !(url.protocol === 'https:'
                || url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))
                throw new Error('Sign-in refused');
            return site;
        }
        function signinInputs() {
            const inputs = [];
            function walk(root) {
                for (const el of root.querySelectorAll('*')) {
                    if (el.tagName === 'INPUT')
                        inputs.push(el);
                    if (el.shadowRoot)
                        walk(el.shadowRoot);
                }
            }
            walk(document);
            return inputs;
        }
        // A sign-up form's "Confirm email" box. Named as such, or else the second of exactly two email/username boxes in
        // one form, as the second of two password boxes is the password's confirmation. Only in sign-up mode.
        let confirmationFound; // Once per page operation: the probe asks per field.
        function usernameConfirmation() {
            if (!params.signin?.signup)
                return;
            return (confirmationFound ??= { el: findUsernameConfirmation() }).el;
        }
        function findUsernameConfirmation() {
            const words = (el) => `${el.getAttribute('name') || ''} ${el.getAttribute('id') || ''} ${nameOf(el)}`;
            const named = (el) => /(?:confirm|repeat|re-?type|re-?enter|verify|again)/i.test(words(el)) && /e[\s_-]?mail|user[\s_-]?name|login/i.test(words(el));
            // An Email box and a Username box are two different answers; only two email boxes are one answer twice.
            const email = (el) => (el.type || '').toLowerCase() === 'email' || /e[\s_-]?mail/i.test(words(el));
            const candidates = signinInputs().filter(el => readable(el) && ['text', 'email'].includes((el.type || 'text').toLowerCase())
                && !el.disabled && !el.readOnly && (baseSigninKind(el) === 'username' || named(el)));
            const confirming = candidates.filter(named);
            if (confirming.length === 1 && candidates.length === 2)
                return confirming[0];
            if (!confirming.length && candidates.length === 2 && candidates.every(email) && (candidates[0].form || null) === (candidates[1].form || null))
                return candidates[1];
        }
        function signinKind(el, hintsOnly = false) {
            if (params.signin?.signup && el === usernameConfirmation())
                return 'usernameConfirmation';
            return baseSigninKind(el, hintsOnly);
        }
        function baseSigninKind(el, hintsOnly = false) {
            if (el.tagName !== 'INPUT' || !visible(el) || el.matches(':disabled') || el.disabled || el.readOnly
                || el.getAttribute('aria-disabled') === 'true')
                return;
            const tokens = (el.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/);
            if (tokens.includes('new-password') && !params.signin?.signup)
                return;
            if (params.signin?.signup && el.type === 'password') {
                const passwords = [...(el.form?.elements || document.querySelectorAll('input'))].filter(control => control.type === 'password' && visible(control) && !control.disabled);
                if (passwords.length === 2 && passwords[1] === el)
                    return 'confirmation';
                return 'password';
            }
            const type = (el.type || 'text').toLowerCase();
            if (!['text', 'email', 'tel', 'number', 'password'].includes(type))
                return;
            if (tokens.includes('current-password'))
                return 'password';
            if (tokens.includes('one-time-code') && type !== 'password')
                return 'otp';
            if ((tokens.includes('username') || tokens.includes('email')) && ['text', 'email'].includes(type))
                return 'username';
            if (hintsOnly)
                return;
            const name = `${el.getAttribute('name') || ''} ${el.getAttribute('id') || ''}`.toLowerCase();
            if (type === 'password')
                return 'password';
            if (/(?:^|[\s_-])(?:otp|totp|code|verification[-_]?code|one[-_]?time[-_]?code|auth[-_]?code)(?:$|[\s_-])/.test(name))
                return 'otp';
            if (['text', 'email'].includes(type) && (type === 'email' || /(?:^|[\s_-])(?:username|user[-_]?name|email|login)(?:$|[\s_-])/.test(name)))
                return 'username';
            // Generated IDs often carry no semantics. Use the control's accessible name,
            // which resolves labels in its own root and falls back to the placeholder.
            /* SIGNIN_ACCESSIBLE_NAME_TEST_POINT */
            if (['text', 'email'].includes(type) && /^(?:user[\s_-]?name|e[\s_-]?mail(?:[\s_-]+(?:address|adresse))?|login)$/i.test(nameOf(el)))
                return 'username';
        }
        function signinFields() {
            const fields = {};
            const inputs = signinInputs();
            let ambiguous = !params.signin?.signup && inputs.some(el => readable(el) && /(?:^|\s)new-password(?:\s|$)/i.test(el.getAttribute('autocomplete') || ''));
            if (params.signin?.signup && inputs.filter(el => readable(el) && el.type === 'password').length > 2)
                ambiguous = true;
            // An unavailable verification control still means authentication is unfinished.
            if (inputs.some(el => readable(el) && el.type !== 'password'
                && (/(?:^|\s)one-time-code(?:\s|$)/i.test(el.getAttribute('autocomplete') || '')
                    || /(?:^|[\s_-])(?:otp|totp|code|verification[-_]?code|one[-_]?time[-_]?code|auth[-_]?code)(?:$|[\s_-])/i.test(`${el.getAttribute('name') || ''} ${el.getAttribute('id') || ''}`))
                && signinKind(el) !== 'otp'))
                ambiguous = true;
            const confirmation = usernameConfirmation();
            if (confirmation)
                fields.usernameConfirmation = confirmation;
            for (const kind of ['username', 'password', 'confirmation', 'otp']) {
                const hinted = inputs.filter(el => el !== confirmation && signinKind(el, true) === kind);
                const matches = hinted.length ? hinted : inputs.filter(el => el !== confirmation && signinKind(el) === kind);
                if (matches.length > 1)
                    ambiguous = true;
                else if (matches.length === 1)
                    fields[kind] = matches[0];
            }
            if (new Set(Object.values(fields).map(el => el.form || null)).size > 1)
                ambiguous = true;
            // Number controls cannot reliably select existing text for replacement.
            // Flag them as a challenge so their presence cannot imply sign-in succeeded.
            if (Object.values(fields).some(el => el.type === 'number'))
                ambiguous = true;
            const passwordPresent = inputs.some(el => el.isConnected && readable(el)
                && ((el.type || '').toLowerCase() === 'password'
                    || /(?:^|\s)current-password(?:\s|$)/i.test(el.getAttribute('autocomplete') || '')));
            return { fields, ambiguous, passwordPresent };
        }
        function signinSignature() {
            const { add, digest } = fnvAccumulator();
            add(location.href);
            add(document.title);
            function walk(root) {
                for (const el of root.querySelectorAll('*')) {
                    if (!readable(el))
                        continue;
                    add(el.tagName);
                    add(selectorFor(el));
                    if (el.tagName === 'INPUT') {
                        add(el.type);
                        add(el.getAttribute('autocomplete'));
                        add(el.disabled);
                        add(el.readOnly);
                    }
                    else if (!['TEXTAREA', 'SELECT', 'SCRIPT', 'STYLE'].includes(el.tagName) && !el.isContentEditable) {
                        // Direct text nodes describe page changes without ever hashing input values.
                        for (const child of el.childNodes)
                            if (child.nodeType === Node.TEXT_NODE)
                                add(child.textContent);
                    }
                    if (el.shadowRoot)
                        walk(el.shadowRoot);
                }
            }
            walk(document);
            return `signin-${digest()}`;
        }
        function signinChallenge() {
            // An invisible reCAPTCHA (its badge, its notice, its size=invisible frame) asks nothing of anyone until it pops a
            // challenge; that challenge is a separate, visible frame and still counts.
            const text = (document.body?.innerText || '').toLowerCase()
                .replace(/(?:this site is )?protected by recaptcha(?: and the google)?/g, '').replace(/\brecaptcha\s+privacy\s*-\s*terms\b/g, '');
            if (/captcha|i[’']?m not a robot|verify (?:that )?you are human|use (?:a |your )?passkey|sign in with (?:a )?passkey|approve (?:the |this )?(?:sign[- ]?in|request)|(?:code|message).{0,40}(?:sent|texted).{0,40}(?:phone|sms|mobile)|(?:sms|text message).{0,40}code/.test(text))
                return true;
            return [...document.querySelectorAll('iframe, [id], [class]')].some(el => visible(el)
                && !el.closest('.grecaptcha-badge') && !/[?&#]size=invisible(?:&|$)/i.test(el.getAttribute('src') || '')
                && /(?:recaptcha|hcaptcha|turnstile|captcha)/i.test(`${el.getAttribute('src') || ''} ${el.getAttribute('id') || ''} ${el.getAttribute('class') || ''}`));
        }
        function signinForm(el) {
            const form = el.form;
            // Script-driven logins can handle Enter without a native form destination.
            // signinTarget still binds their origin, role, identity and null form.
            if (!form) { /* SIGNIN_NO_FORM_TEST_POINT */
                return;
            }
            if (form.tagName !== 'FORM' || !form.isConnected)
                throw new Error('Sign-in refused');
            // Read attributes: a named form control can clobber form.action in page DOM.
            const action = form.getAttribute('action');
            const url = action ? new URL(action, document.baseURI) : new URL(location.href);
            if (url.origin !== signinSite() || url.username || url.password)
                throw new Error('Sign-in refused');
            // A default submit button's override is the destination of implicit Enter.
            const submit = [...form.elements].find(control => !control.matches(':disabled')
                && ((control.tagName === 'BUTTON' && control.type === 'submit')
                    || control.tagName === 'INPUT' && ['submit', 'image'].includes(control.type)));
            if (submit?.hasAttribute('formaction')) {
                const action = submit.getAttribute('formaction');
                const override = action ? new URL(action, document.baseURI) : new URL(location.href);
                if (override.origin !== signinSite() || override.username || override.password)
                    throw new Error('Sign-in refused');
            }
        }
        // The form's default submit button; without a form element, the one button (or the one sign-up-worded button) in
        // the nearest container that holds the field. Nothing when that is not clear.
        function signupButton(field) {
            if (!field)
                return;
            const usable = (el) => readable(el) && !el.matches(':disabled') && el.getAttribute('aria-disabled') !== 'true';
            if (field.form)
                return [...field.form.elements].find((control) => usable(control)
                    && (control.tagName === 'BUTTON' && control.type === 'submit' || control.tagName === 'INPUT' && ['submit', 'image'].includes(control.type || '')));
            for (let box = field.parentElement; box && box !== document.documentElement; box = box.parentElement) {
                const buttons = [...box.querySelectorAll('button, input[type="submit"], [role="button"]')].filter(usable);
                if (!buttons.length)
                    continue;
                if (buttons.length === 1)
                    return buttons[0];
                const worded = buttons.filter(el => /^(?:sign ?up|register|create(?: an| my| your)? account|join|continue|submit|next|get started|registrati|iscriviti|crea(?: un)? account|continua|avanti)\b/i.test(nameOf(el)));
                return worded.length === 1 ? worded[0] : undefined;
            }
        }
        function signinTarget(submit) {
            signinSite();
            if (typeof params.selector !== 'string' || !params.selector.startsWith(state.prefix))
                throw new Error('Sign-in refused');
            const known = state.signin?.get(params.selector), el = resolve(params.selector);
            const kind = params.signin?.kind;
            const { fields, ambiguous } = signinFields();
            if (!known || known.kind !== kind || known.signup !== (params.signin?.signup === true) || ambiguous || signinChallenge() || fields[known.kind] !== el
                || signinKind(el) !== known.kind || (el.form || null) !== known.form)
                throw new Error('Sign-in refused');
            // Signup authority fills only. Submission always crosses the ordinary click/payment/send/delete gates.
            if (submit && params.signin?.signup)
                throw new Error('Sign-in refused');
            if (submit)
                signinForm(el);
            return el;
        }
        if (action === 'signinProbe') {
            signinSite();
            const { fields, ambiguous, passwordPresent } = signinFields(), challenge = ambiguous || signinChallenge();
            state.signin = new Map();
            const refs = {};
            if (!challenge)
                for (const kind of ['username', 'usernameConfirmation', 'password', 'confirmation', 'otp']) {
                    const el = fields[kind];
                    if (el) {
                        const ref = selectorFor(el);
                        refs[kind] = ref;
                        state.signin.set(ref, { kind, form: el.form || null, signup: params.signin?.signup === true });
                    }
                }
            // Sign-up only: the button that sends the form, which the broker presses as an ordinary, gated click.
            const button = !challenge && params.signin?.signup ? signupButton(fields.password ?? fields.username) : undefined;
            return { url: location.href, signature: signinSignature(), passwordPresent, ...refs, ...(button ? { submit: selectorFor(button) } : {}),
                ...(challenge ? { challenge: true } : {}) };
        }
        if (action === 'signinLanded') {
            // Only the checked origin, role, field and form may confirm an interrupted
            // credential insert. Compare inside the isolated world; return no value.
            const el = signinTarget(false);
            return { landed: typeof params.text === 'string' && el.value === params.text };
        }
        if (['signinFocus', 'signinCheck', 'signinSubmitFocus', 'signinSubmitCheck'].includes(action)) {
            const submit = action.startsWith('signinSubmit'), el = signinTarget(submit);
            if (action.endsWith('Focus')) {
                el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
                el.focus({ preventScroll: true });
                signinTarget(submit); // Focus handlers can navigate, replace fields or change form destinations.
                if (activeElement() !== el)
                    throw new Error('Sign-in refused');
                if (!submit)
                    el.select();
            }
            signinTarget(submit);
            if (activeElement() !== el)
                throw new Error('Sign-in refused');
            return { selector: selectorFor(el), signature: signinSignature(), combobox: false };
        }
        if (params.version && ['describe', 'snapshot', 'pressCheck', 'scroll', 'scrollPoint', 'select', 'upload', 'typeFocus', 'typeCheck', 'clickPoint', 'clickCheck', 'hoverPoint', 'domClick'].includes(action)
            && params.version !== pageVersion()) {
            throw Object.assign(new Error('the page changed since you looked'), { code: 'stale' });
        }
        if (action === 'wait') {
            const selector = params.selector;
            // Parse CSS once: invalid syntax is an error, an absent element is not.
            if (selector && !selector.startsWith('@') && !selector.startsWith('gaddi:'))
                document.querySelector(selector);
            const needle = params.text?.replace(/\s+/g, ' ').trim().toLowerCase();
            let textCache, textReadAt = 0;
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
                return textCache.includes(needle); /* WAIT_TEXT_END */
            }
            return await new Promise((resolve, reject) => {
                let debounce, frame = 0, done = false;
                const end = performance.now() + (params.timeout ?? 500);
                const observer = new MutationObserver(() => { textCache = undefined; debounce ??= setTimeout(() => { debounce = undefined; check(); }, 40); });
                const finish = (met, error) => {
                    if (done)
                        return;
                    done = true;
                    observer.disconnect();
                    clearInterval(backstop);
                    clearTimeout(timer);
                    clearTimeout(debounce);
                    cancelAnimationFrame(frame);
                    if (error)
                        reject(error);
                    else
                        resolve({ met });
                };
                const check = () => {
                    try {
                        if (matches() !== !!params.gone)
                            finish(true);
                    }
                    catch (error) {
                        finish(false, error);
                    }
                };
                const backstop = setInterval(check, 250);
                const finalCheck = () => { textCache = undefined; check(); finish(false); };
                // Focus emulation supplies frames even when Chrome postpones hidden-tab timers.
                const tick = () => { if (performance.now() >= end)
                    finalCheck();
                else
                    frame = requestAnimationFrame(tick); };
                const timer = setTimeout(finalCheck, params.timeout ?? 500);
                frame = requestAnimationFrame(tick);
                observer.observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
                check();
            });
        }
        if (action === 'read') {
            if (params.visible !== undefined && typeof params.visible !== 'boolean')
                throw new Error('visible must be boolean');
            const viewportOnly = params.visible === true; /* VISIBLE_TEST_POINT */
            const intersects = (rect) => rect.width > 0 && rect.height > 0
                && rect.right > 0 && rect.left < innerWidth && rect.bottom > 0 && rect.top < innerHeight;
            for (const [key, el] of state.nodes)
                if (!el.isConnected)
                    state.nodes.delete(key);
            const elements = [], texts = [], offscreen = { above: 0, below: 0 };
            const positions = [];
            function walk(root) {
                for (const el of root.querySelectorAll('*')) {
                    if (visible(el) && roleOf(el)) {
                        const box = viewportOnly ? el.getBoundingClientRect() : undefined;
                        if (box && !intersects(box)) {
                            if (box.bottom <= 0)
                                offscreen.above++;
                            else if (box.top >= innerHeight)
                                offscreen.below++;
                        }
                        else {
                            const info = describe(el);
                            elements.push(`${info.role} ${JSON.stringify(info.name)}${controlState(el)} ${info.selector}`);
                            const rect = box || el.getBoundingClientRect();
                            positions.push({ ref: info.selector, x: rect.x, y: rect.y, width: rect.width, height: rect.height });
                        }
                    }
                    if (el.shadowRoot)
                        walk(el.shadowRoot);
                }
            }
            let previousTextRect;
            function collectText(root) {
                const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
                const range = document.createRange();
                let node;
                while ((node = walker.nextNode())) {
                    if (node.nodeType === Node.ELEMENT_NODE) {
                        if (node.shadowRoot)
                            collectText(node.shadowRoot);
                        continue;
                    }
                    const parent = node.parentElement || node.getRootNode().host;
                    if (!parent || !node.textContent || parent.closest('script,style,noscript,template,[hidden],[aria-hidden="true"],[inert]'))
                        continue;
                    if (!parent.checkVisibility({ checkVisibilityCSS: true })) {
                        const style = getComputedStyle(parent);
                        if (style.display !== 'contents' || style.visibility !== 'visible')
                            continue;
                    }
                    range.selectNodeContents(node);
                    const rects = [...range.getClientRects()].filter(intersects);
                    if (!rects.length)
                        continue;
                    const first = rects[0];
                    if (previousTextRect && (first.top >= previousTextRect.bottom || first.bottom <= previousTextRect.top))
                        texts.push(' ');
                    texts.push(node.textContent);
                    previousTextRect = rects[rects.length - 1];
                }
            }
            walk(document);
            if (viewportOnly)
                collectText(document.body || document);
            return { text: (viewportOnly ? texts.join('').replace(/\s+/g, ' ').trim() : document.body?.innerText || '').slice(0, 20000),
                outline: elements.join('\n'), positions, version: pageVersion(), scroll: { y: scrollY, height: document.documentElement.scrollHeight },
                ...(viewportOnly ? { offscreen } : {}) };
        }
        if (action === 'snapshot')
            return { signature: signature() };
        if (action === 'settle') {
            const combo = params.settleMs === 200;
            await new Promise(resolve => {
                let frame = 0, frames = 0;
                const finish = () => { clearTimeout(timer); cancelAnimationFrame(frame); resolve(); };
                const timer = setTimeout(finish, combo ? 200 : 50);
                const tick = () => {
                    if (++frames >= 2 && (!combo || [...document.querySelectorAll('[role="option"], [role="listbox"]')].some(visible)))
                        finish();
                    else
                        frame = requestAnimationFrame(tick);
                };
                frame = requestAnimationFrame(tick);
            });
            return { signature: signature(), url: location.href, version: pageVersion() };
        }
        if (action === 'evalCheck') {
            // Invariant: evaluation runs on pages with password fields, but never returns what they hold. This collects the
            // values of every password field the evaluation could reach (open shadows and readable embedded documents;
            // cross-origin frames are unreadable to main-world JS by the same-origin policy) so the extension removes them
            // from the result. They go to the extension only, never to the broker or the agent.
            const hidden = [];
            function check(root) {
                for (const el of root.querySelectorAll('*')) {
                    if (isPassword(el) && typeof el.value === 'string' && el.value)
                        hidden.push(el.value);
                    if (el.shadowRoot)
                        check(el.shadowRoot);
                    if (['IFRAME', 'FRAME', 'OBJECT', 'EMBED'].includes(el.tagName)) {
                        let child;
                        try {
                            child = el.contentDocument;
                        }
                        catch { /* Same-origin policy also blocks eval access. */ }
                        if (child)
                            check(child);
                    }
                }
            }
            check(document);
            return { hidden };
        }
        if (action === 'html') {
            const copy = document.documentElement?.cloneNode(true);
            // Invariant: markup extraction never exports password values from attributes.
            for (const el of copy?.querySelectorAll('*') || [])
                if (isPassword(el)) {
                    el.removeAttribute('value');
                    el.textContent = '';
                }
            const html = copy?.outerHTML || '';
            // Bound by bytes, not UTF-16 code units (the daemon's HTML limit is 5 MiB).
            const bytes = new TextEncoder().encode(html);
            return { html: new TextDecoder().decode(bytes.subarray(0, 5 * 1024 * 1024)), truncated: bytes.length > 5 * 1024 * 1024 };
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
            const sweep = (root) => {
                for (const el of root.querySelectorAll('*')) {
                    try {
                        const url = ['IFRAME', 'FRAME', 'EMBED'].includes(el.tagName) ? el.src
                            : el.tagName === 'OBJECT' ? el.data : '';
                        if (url.startsWith('chrome-extension://') && !url.startsWith(own)) {
                            el.remove();
                            closed++;
                            continue;
                        }
                        // Extensions inject their menus in closed shadow roots; only the isolated world sees them.
                        // Chrome throws for elements that cannot host a shadow root (SVG, some form controls); skip those.
                        let shadow = el.shadowRoot;
                        if (!shadow && el instanceof HTMLElement) {
                            try {
                                shadow = globalThis.chrome?.dom?.openOrClosedShadowRoot(el) ?? null;
                            }
                            catch {
                                shadow = null;
                            }
                        }
                        if (shadow)
                            sweep(shadow);
                    }
                    catch { /* One malformed node or unavailable shadow root must not poison the tab. */ }
                }
            };
            sweep(document);
            return { closed };
        }
        if (action === 'pressCheck') {
            const el = activeElement();
            if (params.selector && el !== resolve(params.selector))
                throw new Error('Focused target changed since it was checked');
            // A top-frame script cannot validate the actual keyboard target inside an
            // embedded document. Refuse instead of sending unchecked text to that frame.
            if (el && ['IFRAME', 'FRAME', 'OBJECT', 'EMBED'].includes(el.tagName))
                throw new Error('Refusing keyboard input into an uninspected embedded document: '
                    + 'look lists every document with its frame id, then press with frameId (--frame <id>) so that document itself is checked');
            if (el && isPassword(el))
                throw new Error('Refusing keyboard input into a password field');
            if (params.checkedDescription)
                checkDescription(el || document.body, true);
            return { signature: signature() };
        }
        // Whether this document handed its focus to an embedded one. Keys follow the focus, so a
        // press aimed inside a frame is delivered there only while that frame holds it.
        if (action === 'pressFocus') {
            const el = activeElement();
            return { embedded: !!el && ['IFRAME', 'FRAME', 'OBJECT', 'EMBED'].includes(el.tagName) };
        }
        // The visible part of this document, so a point measured elsewhere can be held to it.
        if (action === 'viewport')
            return { width: innerWidth, height: innerHeight };
        if (action === 'pointTarget') {
            // What the user would be clicking at that point, in this document. When it is an
            // embedded document, bg.ts follows the same point into it, so the gate judges the
            // control inside rather than the frame around it.
            const at = params.at;
            if (!at || !Number.isFinite(at.x) || !Number.isFinite(at.y))
                throw new Error('A point is required');
            const hit = pointElement(at);
            if (!hit)
                throw new Error('Nothing is at that point');
            const described = { ...describe(hit), ...gateFacts(hit) };
            const frame = ['IFRAME', 'FRAME'].includes(hit.tagName);
            // The hit and its ancestors, so a caller can tell "the control I measured" from "something
            // else now sitting at that point"; document references keep this check inside one document.
            const chain = [];
            for (let node = hit; node && chain.length < 80; node = node.parentElement || node.getRootNode().host || null) {
                chain.push(selectorFor(node));
            }
            return { selector: described.selector, name: described.name, tag: described.tag, role: described.role,
                choice: described.choice === true, href: described.href, type: described.type, autocomplete: described.autocomplete,
                submitName: described.submitName, secret: described.password, disabled: described.disabled,
                committed: described.committed, controls: described.controls,
                // TX-BIND and FRAME-BIND: the transaction around the control, and the document's own origin (bg.ts adds Chrome's
                // document id). A point on a frame element is followed inwards, so its own digest is never used.
                transaction: frame ? '' : described.transaction, origin: location.origin,
                signature: signature(), chain, frame };
        }
        const el = resolve(params.selector);
        // Whether a type whose session Chrome cut mid-insert left the field holding the text.
        if (action === 'typeLanded')
            return { landed: (!isPassword(el) || !!params.fill)
                    && (el.isContentEditable ? el.textContent : el.value) === params.text };
        // Inside an embedded document the gates judge that document's own site, so it says where it is.
        const topWindow = globalThis.top, embedded = topWindow != null && topWindow !== globalThis;
        if (action === 'describe')
            return { ...describe(el), ...gateFacts(el), ...(embedded ? { frameUrl: location.href, origin: location.origin } : {}),
                matched: (params.denySelectors || []).filter(selector => el.matches(selector)) };
        if (action === 'captureBox') {
            if (!visible(el))
                throw new Error('Capture target is not visible');
            if (params.key && activeElement() !== el)
                throw new Error('Capture focus changed');
            checkDescription(el, !!params.key);
            /* CAPTURE_SCROLL_TEST_POINT */
            const rect = el.getBoundingClientRect();
            const box = { x: rect.left + scrollX, y: rect.top + scrollY, width: rect.width, height: rect.height };
            if (box.width <= 0 || box.height <= 0 || box.x < 0 || box.y < 0)
                throw new Error('Capture target has no usable box');
            // Offscreen document content can be captured without scrolling, but content
            // clipped inside another element is not painted there. Never outline it.
            let viewportBound = false, clipped = false, transformed = false;
            for (let node = el; node; node = node.parentElement || node.getRootNode().host || null) {
                const style = getComputedStyle(node);
                if (style.transform !== 'none' || style.translate !== 'none' || style.scale !== 'none' || style.rotate !== 'none' || style.perspective !== 'none' || Number.parseFloat(style.zoom) !== 1)
                    transformed = true;
                if (style.position === 'fixed' || style.position === 'sticky')
                    viewportBound = true;
                if (node === el || node === document.documentElement || node === document.body)
                    continue;
                if (style.overflowX !== 'visible' || style.overflowY !== 'visible')
                    clipped = true;
                const parent = node.getBoundingClientRect();
                if (style.overflowX !== 'visible' && (rect.left < parent.left + node.clientLeft || rect.right > parent.left + node.clientLeft + node.clientWidth)
                    || style.overflowY !== 'visible' && (rect.top < parent.top + node.clientTop || rect.bottom > parent.top + node.clientTop + node.clientHeight))
                    throw new Error('Capture target is clipped by an ancestor');
            }
            if (clipped && transformed)
                throw new Error('Capture target has a transformed clipping ancestor');
            if (transformed)
                throw new Error('Capture target is transformed');
            // Enough page to recognise the setting, with at least 120 CSS px on each
            // side before document/viewport clipping. Large controls keep their padding
            // even when the preferred contextual size has reached its cap.
            const width = Math.max(700, Math.min(1200, 4 * box.width), box.width + 240);
            const height = Math.max(320, Math.min(700, 6 * box.height), box.height + 240);
            let x = Math.max(0, Math.floor(box.x + (box.width - width) / 2));
            let y = Math.max(0, Math.floor(box.y + (box.height - height) / 2));
            let right = Math.min(Math.max(document.documentElement.scrollWidth, innerWidth), Math.ceil(box.x + (box.width + width) / 2));
            let bottom = Math.min(Math.max(document.documentElement.scrollHeight, innerHeight), Math.ceil(box.y + (box.height + height) / 2));
            if (right < box.x + box.width || bottom < box.y + box.height)
                throw new Error('Capture target is outside the document');
            if (viewportBound) {
                const viewport = visualViewport;
                const left = viewport?.pageLeft ?? scrollX, top = viewport?.pageTop ?? scrollY;
                const width = viewport?.width ?? innerWidth, height = viewport?.height ?? innerHeight;
                if (box.x < left || box.y < top || box.x + box.width > left + width || box.y + box.height > top + height)
                    throw new Error('Capture fixed or sticky target is outside the viewport');
                x = Math.max(x, left);
                y = Math.max(y, top);
                right = Math.min(right, left + width);
                bottom = Math.min(bottom, top + height);
            }
            return { box, clip: { x, y, width: right - x, height: bottom - y }, beyondViewport: !viewportBound,
                pixelRatio: devicePixelRatio, selector: selectorFor(el) };
        }
        if (action === 'scroll') {
            if (!visible(el))
                throw new Error('Element is not visible');
            const before = signature();
            el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
            return { scrolled: true, signature: before };
        }
        if (action === 'scrollPosition')
            return { left: el.scrollLeft, top: el.scrollTop };
        if (action === 'scrollPoint') {
            if (!visible(el))
                throw new Error('Element is not visible');
            // Move the page only when the element's centre cannot be reached where it is.
            let point = centrePoint(el);
            if (!point) {
                el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
                point = centrePoint(el);
            }
            if (!point)
                throw new Error('Element centre is obscured');
            // Baseline after any preparatory scroll, so only the wheel counts as change.
            const scroller = scrollerFor(el, params.dx ? 'x' : 'y');
            return { ...point, signature: signature(), selector: selectorFor(el), scroller: selectorFor(scroller),
                left: scroller.scrollLeft, top: scroller.scrollTop };
        }
        if (action === 'upload') {
            // The target is a file field, a label or container holding one (often hidden behind an
            // "Upload" button), or a drop zone with no field at all.
            const fields = (root) => [...root.querySelectorAll('input[type="file" i]')];
            let input = el.matches('input[type="file" i]') ? el : null;
            if (!input && el.tagName === 'LABEL' && el.control?.matches('input[type="file" i]'))
                input = el.control;
            if (!input) {
                const inner = fields(el);
                if (inner.length > 1)
                    throw new Error('Several file fields are inside that element; target one of them');
                input = inner[0] || null;
            }
            const file = params.file;
            const bytes = Uint8Array.from(atob(file.data), c => c.charCodeAt(0));
            const transfer = new DataTransfer();
            transfer.items.add(new File([bytes], file.name, { type: file.type, lastModified: file.lastModified }));
            const before = signature();
            if (input) {
                if (input.disabled)
                    throw new Error('The file field is disabled');
                const accept = input.accept.split(',').map(token => token.trim().toLowerCase()).filter(Boolean);
                const name = file.name.toLowerCase(), type = file.type.toLowerCase();
                if (accept.length && !accept.some(token => token.startsWith('.') ? name.endsWith(token)
                    : token.endsWith('/*') ? type.startsWith(token.slice(0, -1)) : type === token))
                    throw new Error(`The file field accepts only ${input.accept}`);
                input.files = transfer.files;
                input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
                return { signature: before, via: 'input' };
            }
            if (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.isContentEditable)
                throw new Error('That element is not a file field, the label of one, or a drop zone');
            if (!visible(el))
                throw new Error('No file field there, and the element is not visible to drop onto');
            for (const type of ['dragenter', 'dragover', 'drop'])
                el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, composed: true, dataTransfer: transfer }));
            return { signature: before, via: 'drop' };
        }
        if (action === 'select') {
            if (isPassword(el))
                throw new Error('Refusing password field access');
            if (el.tagName !== 'SELECT' || !visible(el) || el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true')
                throw new Error('Element is not an enabled select');
            if (typeof params.value !== 'string' || ![...el.options].some(option => option.value === params.value && !option.disabled && !option.parentElement?.disabled))
                throw new Error('No enabled option with that value');
            checkDescription(el);
            const before = signature();
            el.value = params.value;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return { selected: true, signature: before };
        }
        if (action === 'typeFocus' || action === 'typeCheck') {
            if (params.mode !== undefined && params.mode !== 'replace' && params.mode !== 'append')
                throw new Error('mode must be replace or append');
            assertWritable(el);
            if (action === 'typeFocus') {
                el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
                el.focus({ preventScroll: true });
                assertWritable(el);
            }
            if (activeElement() !== el)
                throw new Error('Input focus moved; refusing to type');
            // Debugger focus emulation runs between typeFocus and typeCheck. Restore
            // the append caret after it, without refocusing a field that lost focus.
            if (action === 'typeFocus' || params.mode === 'append') {
                if (el.isContentEditable) {
                    const range = document.createRange();
                    let end = el;
                    if (params.mode === 'append') {
                        // A container boundary after a chip can resolve inside its
                        // noneditable contents. Use an editable text node outside the chip.
                        while (end.lastChild && (end.lastChild.nodeType === Node.TEXT_NODE
                            || end.lastChild.nodeType === Node.ELEMENT_NODE && end.lastChild.isContentEditable
                                && !['BR', 'IMG', 'HR', 'INPUT', 'EMBED'].includes(end.lastChild.tagName)))
                            end = end.lastChild;
                        if (end.nodeType !== Node.TEXT_NODE) {
                            const br = end.lastChild?.tagName === 'BR' ? end.lastChild : null;
                            const text = br?.previousSibling?.nodeType === Node.TEXT_NODE ? br.previousSibling : null;
                            end = text || end.insertBefore(document.createTextNode(''), br);
                        }
                        // Native insertion may leave the original empty anchor after its
                        // new text node. Reuse the text that now owns the rendered caret.
                        while (end.nodeType === Node.TEXT_NODE && !end.textContent && end.previousSibling?.nodeType === Node.TEXT_NODE)
                            end = end.previousSibling;
                        if (action === 'typeCheck') {
                            state.appendCleanup?.restore();
                            const parent = end.parentElement;
                            // An empty text node after a block chip has no native editing
                            // position. A temporary break gives Chrome a rendered caret.
                            const br = !end.textContent && parent.lastChild === end
                                && end.previousSibling?.tagName !== 'BR' ? document.createElement('br') : null;
                            // Blink replaces leading spaces with NBSP under collapsing CSS.
                            // Preserve the requested text while the trusted insert runs.
                            const style = parent.style;
                            const preserve = ['normal', 'nowrap', 'pre-line'].includes(getComputedStyle(parent).whiteSpace);
                            const previous = preserve ? ['white-space-collapse', 'text-wrap-mode'].map(property => ({
                                property, value: style.getPropertyValue(property), priority: style.getPropertyPriority(property),
                            })) : [];
                            const hadStyle = parent.hasAttribute('style');
                            state.appendCleanup = { owner: params.appendCleanup, restore: () => {
                                    br?.remove();
                                    if (preserve && style.getPropertyValue('white-space') === 'pre-wrap' && style.getPropertyPriority('white-space') === 'important') {
                                        style.removeProperty('white-space');
                                        for (const { property, value, priority } of previous)
                                            if (value)
                                                style.setProperty(property, value, priority);
                                        if (!hadStyle && !style.length) {
                                            // Flush Chrome's lazy CSSOM attribute serialization first.
                                            parent.getAttribute('style');
                                            parent.removeAttribute('style');
                                        }
                                    }
                                } };
                            if (br)
                                parent.insertBefore(br, end);
                            if (preserve)
                                style.setProperty('white-space', 'pre-wrap', 'important');
                        }
                    }
                    range.selectNodeContents(end);
                    if (params.mode === 'append')
                        range.collapse(false);
                    const selection = document.getSelection();
                    selection?.removeAllRanges();
                    selection?.addRange(range);
                }
                else if (params.mode === 'append' && !['email', 'number'].includes(el.type || '')) {
                    const field = el;
                    field.setSelectionRange(field.value.length, field.value.length);
                }
                else if (params.mode !== 'append')
                    el.select();
            }
            assertWritable(el); // Focus handlers can change the field's type or autocomplete.
            if (activeElement() !== el)
                throw new Error('Input focus moved; refusing to type');
            const before = signature();
            return { selector: selectorFor(el), signature: before,
                ...(params.mode === 'append' ? { expectedText: String(el.isContentEditable ? el.textContent ?? '' : el.value ?? '') + (params.text ?? '') } : {}),
                ...(params.mode === 'append' && el.isContentEditable ? { appendCleanup: action === 'typeFocus'
                        ? `${state.prefix}type:${state.appendNext = (state.appendNext ?? 0) + 1}` : params.appendCleanup } : {}),
                ...(params.mode === 'append' && el.tagName === 'INPUT' && ['email', 'number'].includes(el.type || '') ? { appendNeedsEnd: true } : {}),
                combobox: el.getAttribute('role') === 'combobox' || el.tagName === 'INPUT' && ['aria-controls', 'aria-owns', 'list'].some(key => el.hasAttribute(key)) };
        }
        if (action === 'clickPoint' || action === 'clickCheck' || action === 'hoverPoint' || action === 'domClick') {
            if (action !== 'hoverPoint' && (el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true'))
                throw new Error('Element is not interactable');
            const choice = action !== 'hoverPoint' && describe(el).choice;
            // A radio or checkbox the page hides and draws through its label is pressed where a person presses it: on the label.
            const label = choice && el.tagName === 'INPUT' && !visible(el) ? [...(el.labels ?? [])].find(visible) : undefined;
            const target = label ?? el;
            if (!visible(target)) {
                // A hidden choice or list option (a list that closed when the page lost focus, a styled radio with no
                // visible label) has no point to press. It is clicked through the page instead, the way the page's own
                // script would, after the same checks. Only a control the gates already judged by its own name gets this.
                if (action === 'domClick' && choice) {
                    checkDescription(el);
                    const before = signature();
                    el.click();
                    return { signature: before, domClick: true };
                }
                if (choice && action === 'clickPoint')
                    return { x: -1, y: -1, selector: selectorFor(el), signature: signature(), domClick: true, choice: true };
                throw new Error('Element is not interactable');
            }
            if (action === 'domClick')
                throw new Error('Element is visible; it takes a real click');
            // Inside an embedded document, scroll only when the control is really out of view: scrolling
            // also moves the page around the frame, which would shift the point measured for the tab.
            target.scrollIntoView({ block: params.frameId === undefined ? 'center' : 'nearest', inline: 'center', behavior: 'instant' });
            const before = action === 'clickCheck' ? '' : signature();
            const point = centrePoint(target);
            if (!point)
                throw new Error('Element centre is obscured');
            const { x, y } = point;
            if (action !== 'hoverPoint')
                checkDescription(el);
            if (action === 'clickCheck')
                return { x, y };
            return { x, y, selector: selectorFor(el), signature: before, ...(choice ? { choice: true } : {}) };
        }
        throw new Error('Unknown page operation');
    }
    catch (error) {
        // Chrome does not consistently return rejected executeScript promises to the
        // caller. Serialize failures so a password refusal stays a useful RPC error.
        return { __gaddiError: action.startsWith('signin') ? 'Sign-in refused' : error && typeof error === 'object' && 'message' in error && typeof error.message === 'string' ? error.message || 'Page operation failed' : 'Page operation failed',
            ...(error && typeof error === 'object' && 'code' in error && error.code === 'stale' ? { __gaddiCode: 'stale' } : {}) };
    }
}
