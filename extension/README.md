# Chrome bridge

The Gaddi extension connects Chrome to the local broker through a native-messaging host. It requests access to tabs, bookmarks, page scripts and Chrome's debugger to operate your existing session. `management` provides installed-extension controls; `storage` preserves recovery metadata and reload limits.

## Setup

Run `bash install/register/chrome-bridge.sh`, then open `chrome://extensions`, enable Developer mode and load this checkout's `extension/` folder. Restart or reload the extension after an update. Registration accepts `--dry-run` and `--remove`.

The native-host manifest permits only the pinned extension ID, `dkdhddaljaegpbloohdplknmghpgkoce`. Its wrapper finds Node through Homebrew or PATH without starting a login shell. `GADDI_SOCKET` selects the broker socket. `GADDI_BRIDGE_LOG` selects the lifecycle log, normally `~/Library/Application Support/Gaddi/bridge.log`; request and reply contents are excluded.

The worker health check reaches the broker through the host, so a live native port cannot hide a dead broker. Failed connections back off from 250 ms to thirty seconds; five failures can trigger a persisted, rate-limited self-reload. A thirty-second alarm revives suspended timers. Logging ENOSPC is tolerated, recovery-storage failures suppress reloads, and reconnection never replays input. [Recovery and extension controls](../docs/extension-controls.md) explain the limits and setup.

## Working with tabs

`browser_look` returns visible text, an element outline and `scroll: {y, height}`. Use its opaque references, such as `@k3f9xA:7`, or unique CSS selectors to interact. Each reference combines a random document token with a counter. References from another document, detached elements and the old `gaddi:` format are refused. The outline includes open shadow roots, but excludes iframe documents and closed shadow roots.

Role-less items with a pointer cursor, click handler or keyboard focus inside a floating menu or popover receive refs too. Nested labels and icons share the item's ref in the outline. `type` replaces content by default; `mode:"append"` moves to the end before trusted insertion, preserving rich content such as mention chips. A loaded app's same-origin route change returns the final URL; unrelated navigation still reports supersession.

`browser_look` with `visible:true` (`gaddi look --visible`) keeps only outline boxes and text nodes intersecting the viewport, and adds `offscreen: {above, below}` counts for outlined elements outside it. Hidden elements are excluded; default look is unchanged, and text in a partially visible text node is included in full.

Control lines show current values, checked state, expanded/selected/pressed attributes and disabled state. Values are capped at 80 characters; selects list up to 20 enabled `value:label` options for `browser_select`. An ellipsis marks a cut. Password, credit-card number/security/expiry, one-time-code and file fields show `value=(hidden)`; hidden inputs are not listed.

Click, hover, type, press, select and scroll return `changed: true|false` and the current URL after a brief observation. They compare document identity, URL, title, scroll, focus, form and ARIA state, and a digest of all `textContent` in the document body and open shadow roots. The baseline for click, hover and type is taken after Gaddi's preparatory scroll and focus; scroll and select retain the state before the action. Observation waits up to two frames or 50 ms; typing into a combobox allows up to 200 ms for visible options. The complete after-observation budget, including script injection and signature collection, is 300 ms, or 450 ms after typing into a combobox. If observation fails or cannot fit before the action deadline, the reply conservatively reports `changed: true`, using the last known URL when a fresh lookup is unavailable. Known navigation adds `navigating: true`. Input is never repeated. Text collection does not force layout and includes hidden text. CSS-only visibility changes, closed shadow roots and later updates can fall outside this snapshot; use `browser_look` to inspect the result.

`browser_wait` observes DOM mutations with a 250 ms backstop, rechecks after navigation, and returns `{met, ms, url}` without page content. Text matching ignores case and hidden/script/style content; selectors accept CSS or look references, `gone:true` waits for disappearance, and `timeout` defaults to 10000 ms (maximum 20000). Text/selector waits enable focus emulation only while waiting so background animation frames can run, then restore native visibility; URL waits follow tab events without emulation.

After three consecutive unchanged input actions, the broker adds advice to inspect the tab. A changed action, another URL, or that caller's look/screenshot resets the count; caller/tab state is capped at 1024 entries and removed when tab closure is observed.

Before dispatch, clicks recheck the name and link destination inspected by the broker; Enter rechecks the submit name. If either changed, the action is refused and asks you to look again.

Open, goto and back wait up to 20 seconds for the target document to finish parsing. Later application data and animations may still be loading. A failed open closes its temporary tab unless another navigation took over; cleanup failures report the preserved tab ID.

New tabs open in collapsed background groups named `● <task> · <caller>`, or `● <caller>`. Task names are limited to 40 characters. `foreground: true` brings a new tab forward. Grouping can move existing tabs between windows; closing accepts 1 to 100 explicit IDs and reports individual failures. Confirm before closing unsaved work.

A blocked page request expires after 25 seconds. Close and show remain available while it is blocked. Frozen pages are woken for reads and actions. Discarded tabs are reported without silently reloading them.

Screenshots are JPEG, no larger than CSS pixel size or 1568 pixels on the long edge. Emulation persists until reset, tab closure or debugger detachment. Reset restores native dimensions, color preference and original animation rates without reloading. `animationSpeed` must be greater than zero and at most one; it affects CSS and Web Animations only.

## Uploads

`chrome.uploadChunk` stores base64 pieces of a file the broker has already read and checked, only from the native port, for at most 60 seconds and four uploads at a time. `chrome.upload` joins them, verifies size and SHA-256, and attaches the file with page events: it sets a file field's files and fires `input` and `change`, or, on an element with no field inside, fires `dragenter`, `dragover` and `drop` with the file. A label or container with exactly one file field targets that field, hidden or not. The field's `accept` list and disabled state are checked, the page version applies, and no debugger is used, so uploads also work while another extension's frame is open. Chrome itself lets an extension set files through the debugger only with "Allow access to file URLs" switched on, which Gaddi does not need.

## Other extensions' frames

Chrome refuses every debugger call on a tab while any frame in it shows another extension's page, such as a password manager's inline menu or its sign-in options popover, and ends a running session the moment such a frame starts loading (Chromium `debugger_api.cc`, `ExtensionMayAttachToRenderFrameHost`). The refusal comes before the command is sent. A person is not affected, because their clicks do not go through the debugger.

So when Chrome refuses, Gaddi removes that frame from the page, as dismissing the menu would, and attaches again; every action then runs as usual, with trusted input, and the reply's `note` says a frame was removed. Only frames showing another extension's page are removed, including ones inside closed shadow roots; the other extension's own elements and the page's own frames stay, and nothing inside the removed frame is read. If the other extension puts its frame back, each refusal within a second removes it again. A frame Gaddi cannot find (for example inside another site's embedded page) is reported at once.

- A menu that opens on focus can end the session before input went out; the action then runs once more (`type` without focus emulation, whose focus event would reopen such a menu). A click sends press and release together, so a menu opening on the press cannot split them; if Chrome ends the session after both were sent, the reply says clicked, with a note. Other input already delivered is reported as possibly landed and never sent again, and a `type` whose session ended mid-insert reports success only when the field holds exactly the text.
- Chrome freezes background tabs, page scripts do not run in a frozen tab, and waking one needs the debugger. So after meeting such a frame in a tab nobody has in front, Gaddi removes any it left behind while the page still runs. A tab frozen with a frame someone else opened is reported as such: close it and open the page again, or ask the user to bring it forward.
- A session Chrome would not let Gaddi detach is adopted by the next action on that tab, or detached within 30 seconds once the frame is gone. A person cancelling the debugging bar is never worked around.

## Password protection

Password and password-autocomplete fields refuse typing, including a focus handler that changes the field type. HTML extraction removes password values from a cloned document. Eval refuses password expressions and pages containing password fields, including readable embedded documents and open shadow roots.

These checks are not a JavaScript sandbox. Obfuscation, page-held references, dynamic fields and changes between checking and execution are outside the guarantee. Closed shadow roots can hide an input target; cross-origin frames follow Chrome's same-origin restrictions. Prefer dedicated reading and interaction tools.

## Verify

```sh
bash tests/bridge/framing.test.sh
bash tests/bridge/recovery.test.sh
bash tests/bridge/host-recovery.test.sh
bash tests/bridge/logic.test.sh
bash tests/bridge/extension.test.sh
```

The browser suite uses Chrome for Testing under `~/Library/Application Support/Gaddi/bin`, disposable profiles, local fixture pages and a test native host. It runs headless and rejects a visible-window launch before starting Chrome. Mutated test copies must fail checks for element names, explicit close IDs and screenshot position. Desktop registration is a separate check.
