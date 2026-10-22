# Authorization and sign-in

The broker classifies an action as allowed, held or denied. A denied action has no approval path. A held action creates a pending request and returns its ID; the agent retries after the owner resolves it in Gaddi.

## Signed decisions

The approval app stores an encrypted, Mac-bound Secure Enclave key blob and its public key in Gaddi's local state directory. Signing requires macOS owner authentication. Touch ID and the Mac password are supported through the system authentication policy. An unavailable Secure Enclave has no software fallback.

Each signature binds the decision to the approval ID, action kind, tab, digest of the displayed detail and timestamp. The app rereads the pending action after authentication. The broker accepts proofs only within sixty seconds and records consumed signatures and operations before acting. Reusing a proof, changing the action or changing a bound target fails. A broker restart returns an unconsumed grant to pending, requiring another approval.

## Who asked and why

Every card, banner and phone message names who asked before what: the agent harness, its chat's title, the project, the agent's one-line purpose, the exact action and target, and what approving allows ("This one action, once, within 10 minutes at most." or, for a session grant, every listed action for its length, in that chat only). An agent sets `why` on any call that can be held (open, goto, read a URL, click, press, upload, signin, extensions); a session grant's label is its why. Its harness names the chat and project: `GADDI_CHAT` and `GADDI_PROJECT` when the adapter starts, or the unadvertised `_context: { chat, project }` argument on each call (Pi's `gaddi-context` extension fills it from the T3 thread). Without either, the project is the git repository the chat runs in.

APPROVAL-CONTEXT: these words are display only. They are cleaned to one plain line (no control or direction characters, no address queries, at most 80, 60 and 160 characters) and frozen when the request is first held; a repeat of the same action keeps its card and first words. They are not in the action hash, the remote digest or any signed message, so they can explain a request but never change what an approval allows. Everything except the harness comes from the agent or its harness, and the cards present it as their words, not as a checked fact.

The approval panel can show a page capture around a click or Enter target. This is context for your decision, not proof that the page is honest. A page can change between inspection and Chrome input. Page-version checks narrow that gap but are not atomic with trusted input.

The status menu updates in place while open. An approval review closes after its queue clears; authentication, visible errors and disconnections keep it open. A manually opened settings panel stays available when an approval arrives and resolves. Closing that panel and receiving a new request starts a fresh review.

## Remembered permissions

Sign-in grants and upload permissions cover one exact origin, including scheme and port. Eligible sends cover that origin plus a specific send kind: Enter and a Send button have separate scopes. Remembering or revoking requires a signed app decision. Payments, deletion, security pages, uploads and denied actions never offer remembered send permission. The default policy remembers nothing.

An eligible upload card offers **Always allow uploads on this site** alongside **Allow once**. Touch ID saves that choice across chats and broker restarts; the panel lists the sites with **Revoke**. Agents cannot add a permission. Remembered uploads stay held on built-in and owner-protected addresses and refused hosts; keys, credential files, browser profiles and other protected files remain refused. Each upload allowed by this permission records its reason in the audit.

## Session grants

An agent can ask once, at the start of a chat, to skip a few holds for a while. It calls `browser_grant` with rules of the form `<upload|post|delete> <https address prefix>` (for example `upload https://github.com/settings`), a length from 5 minutes to 12 hours, and an optional label in its own words. Gaddi shows a card with the rules, the length and the label, marked as the agent's description. Only your answer creates the grant, with Touch ID in the Gaddi app or, if you have turned it on, from your phone for a grant of at most 2 hours and twenty rules (see [approvals from another device](#approvals-from-another-device)); nothing an agent or a page says can.


**GRANT-FOLD** (replaces BR-GADDI-QUEUE, owner feedback of 19 October: "3,000 notifications... all asking for 12 hours authorization"). A chat has at most one waiting grant card. A later request from the same chat folds into it: the new card lists every rule asked for so far and the longest time, the folded requests leave the list, and nothing asked for is dropped. An identical retry changes nothing. A rule the chat already holds for long enough, or that a test zone already gives, needs no card at all, and a request made only of such rules is answered at once without one. A fold that would pass the card limit waits as its own request. Folding creates no grant: the owner still signs exactly the text on the card, ending the chat cancels its card, and another chat never joins it. Implemented by `daemon/daemon.ts:requestGrant`; checked by `ASSERT_GRANT_FOLD` in `tests/fixtures/broker-checks.ts` and its `FOLD` mutation in `tests/gates/session-grant-mutations.test.sh`. Revisit if the owner wants to approve parts of a chat's request separately.

- **What can be waived.** Only an upload hold, a hold on `post`, `publish`, `share` (and their Italian forms) and a hold on `delete`, `remove` and their forms. Payments, purchases, sending email or messages, sign-in, account and security changes, every protected address, guarded keys, navigation holds, extension operations and any verb you add yourself stay held every time. A request that names any of those is refused outright, and Gmail cannot be named at all. A refused or denied action stays refused or denied.
- **Where it applies.** A rule covers its exact site (scheme, host and port) and the path prefix on a path boundary: `/settings` covers `/settings/profile`, never `/settingsX`. A button whose name also contains a verb that is not granted ("Post and pay") stays held, and so does a link that leads outside the granted prefix or to a protected address. An upload still goes through the secret-file refusal first.
- **Whose it is.** A grant belongs to the one chat that asked, identified by the connection its Gaddi adapter keeps open (one adapter process is one chat; an app that runs several conversations through a single adapter shares the grant between them). Another adapter, or a command-line call, gets nothing. It ends when the time is up, when that connection closes, when you end it, or when the broker restarts: grants live in memory only and are never read back from disk.
- **Seeing and ending it.** The panel lists every active grant (who, until when, what, the agent's words) and shows an empty list when there is none. **End now** needs no Touch ID, because it only removes authority. The menu bar shows how many grants are running. `browser_approvals` lists them for the agent too.
- **Audit.** `grant.request`, `grant.start` and `grant.end` (expired, session-ended or revoked) are logged, and every action a grant allowed carries `grant: <id>`.

What this does not give you: a grant trusts the whole chat inside its rules, including anything a web page talks that chat into doing there. An upload grant lets the chat attach any file from your home folder that is not on the secret-file list to that page. Keep the rules narrow and the time short. The chat identity is a random ID held by the adapter process, not an authenticated operating-system identity: the broker never lists or logs it, but a process under your account that learned it could use the grant.

The owner can also edit the local policy. That file and the broker run under the same macOS account as the agents: signed UI decisions do not make them tamper-proof against a process with full access to that account. Policy changes can relax defaults, including the upload hold. See [policy configuration](../install/README.md#policy).

## Test zones

**TEST-ZONE** (owner request of 19 October: "on my own apps... here you can do whatever you want... It's a test. I can't do any damage"). A test zone is a whole site (exact origin: scheme, host and port) that the owner marks as his own test ground (extended on 20 October: "In the test zone, you should be able to also sign in autonomously... Payments, obviously not... not to anybody real"). On it, for every agent and chat and for command-line calls, with no expiry until he removes it, these run without asking: sign-in with the login he stored in 1Password for that site, uploads, posts, deletes, and account or security changes (password, two-step, recovery, closing the account, unsubscribing, and opening the site's own security and account-closure pages). Still held every time: payments, purchases, orders, transfers and their pages (a page can claim to be a test, so Gaddi never treats a payment as fake), and sending messages, because Gaddi cannot show that a recipient is a test account (a send he remembered for that site keeps working through its own rule). A mixed name such as "Post and pay", a link leaving the zone or reaching a payment page, and secret files stay held or refused. Refused hosts, his own protected addresses and identity providers (Google, Apple, iCloud, Microsoft, 1Password, Okta, Auth0, GitHub) can never be zones, because a zone there would act on his real identity. Typing into password fields stays refused everywhere. Enter on a form keeps grant parity (posts and deletes only), because the broker cannot see where a form submits; account and security changes need a click. His own refused hosts and protected addresses win over a zone, sign-in included.

- **Setting one.** In the Gaddi review window, a waiting upload, post, delete or grant card offers **Test zone: always allow on <site>**: one Touch ID makes its sites zones and answers that request. The **Test zones** section lists them, adds one by address (Touch ID) and removes one with **Remove** (no Touch ID, because it only takes authority away). A waiting grant request that asks only for what the zones now give is closed.
- **Where it lives.** The owner's policy overlay (`zones.sites`), written only after a verified signature over `zones.add|<site>|<ts>`. It survives restarts, unlike a session grant.
- **The limit.** A zone covers a site, not an account: if the site is signed in to a real account in his Chrome, the zone covers that account too. Use zones for sites, ports or staging hosts that only ever hold test data.
- **Audit.** Every action a zone allowed carries `zone: <site>`.

Implemented by `daemon/grants.ts:checkZone`, `daemon/policy.ts:setZone`, `daemon/proof.ts:zoneAddMessage` and the `zones.*` methods in `daemon/daemon.ts`; checked by `ASSERT_ZONE` and its `ZONE`, `ZONE_REASON`, `ZONE_MIXED` and `ZONE_PAYMENT` mutations, and by `tests/policy/zones.test.sh` (sites that can be zones, sign-in). Revisit if he needs a zone narrower than a site (one account or one path).

## The review window

The menu bar's "N actions are waiting for you" row opens the review window. A banner click opens it on everything waiting. Opened by the owner, it is a regular app window (with a Dock icon while open) that stays above other windows until closed; opened automatically, it still takes no focus. Requests are grouped by the chat that asked (harness and chat title); a group of two or more has **Approve all** and **Deny all**, one Touch ID that signs each request separately and skips any that changed. Banners are one per chat and are replaced as its requests arrive: the title says who asked, the subtitle the action, the body why.

## Approvals from another device

A separate program of yours, for instance a Telegram bot running on your own machine, can answer some of Gaddi's requests so that you can say yes from your phone. It is **off by default**. **Only your Touch ID in the Gaddi app turns it on.** **Anyone who can reach the socket can turn it off**, because turning it off only removes authority. It covers only the explicit upload/post/delete tier, and only requests Gaddi itself marks as answerable. Deletion can be permanent; uploads and publishing can expose data.

### What it can answer

While it is on, a waiting request carries `remote: true`, a `digest` and its enrollment `epoch` if it is one of these, and only then:

- **An upload, a post or a delete** that a session grant on that page could waive. The hold is the same upload, post or delete hold; the page is an address a grant rule can name (https, or http on this Mac) and is not protected (payments, account and security pages, Gmail); every action word in the button's name is one of those three, so "Post and pay" is not; and a link's destination is on the same site and not protected. Gaddi judges this with the very scan session grants use, from the page address as it was when the request was held (a query can make a page protected), and again every time the request is listed or answered.
- **A session-grant request of 2 hours or less and no more than twenty rules.**

Never, whatever the program sends: payments and purchases, sending email or messages, sign-in, account and security changes and every protected address, guarded keys (such as Cmd+Enter in Gmail), navigation, extension operations, script evaluation, and anything Gaddi did not mark. They are outside this remote/session-grant path; separately remembered permissions are described above.

### The contract

1. **Key.** The program generates its own Ed25519 key pair and writes the public key, as an SPKI PEM (`-----BEGIN PUBLIC KEY-----`), to `~/Library/Application Support/Gaddi/remote-approver.pub` (`$GADDI_REMOTE_KEY` overrides the path). That file is only a candidate. It authorizes nothing, a private key or any other kind of key is ignored, and once you have turned the feature on, changing the file does nothing until you turn it on again.
2. **Turn on.** In the Gaddi panel, **Approvals from your phone**, **Turn on…** shows the waiting key's fingerprint (the first 16 hex digits of the SHA-256 of its DER SPKI, in groups of four) so you can compare it with the one the program shows you, then asks for Touch ID. Touch ID signs `remote.enable|<fingerprint>|<ts>` over the full fingerprint. Gaddi stores that key (`remote.json`, owner-only) and uses only it from then on. The saved choice survives a restart; a damaged file means off.
3. **Listen.** Connect to the socket and send `{"id":1,"method":"events.subscribe","params":{"caller":"marcus"}}`. Act on `approval.pending` events whose `approval.remote === true`, or poll `approvals.list` and keep the rows where `remote === true`. Listen for `remote.changed` too: it announces on and off, and after it you should list again, because requests that were already waiting change their flag.
4. **Show and answer.** Show the owner `caller`, `kind`, `detail`, and `url`. A request that has a page capture also carries `imagePath` (a JPEG on this Mac) and `box` (the target, in the picture's pixels); showing the picture with the target outlined lets him see what he is approving, as the Mac does. When he decides, send `{"method":"approval.remote","params":{"id":…,"verb":"grant"|"deny","nonce":…,"ts":…,"sig":…}}` where
   - `sig` is the base64 Ed25519 signature (64 bytes) of the UTF-8 text `gaddi-remote-v2|<epoch>|<verb>|<id>|<kind>|<digest>|<nonce>|<ts>`;
   - `epoch` is the exact 32-hex enrollment generation from the displayed immutable card, never refreshed behind that card;
   - `digest` is the `digest` field of the request, the SHA-256 hex of `<kind>|<id>|<detail>`, so a decision cannot be moved to another request or to a request whose text changed;
   - `nonce` is 16 to 128 characters of `A-Za-z0-9_-`, never reused;
   - `ts` is the time in whole milliseconds, within 120 seconds of Gaddi's clock.
5. **Off and status.** `remote.status` reports `{enabled, fingerprint, enabledAt, epoch, candidate}`. `remote.disable` stops new decisions and revokes unused remote-derived approvals and active remote-derived grants; it needs no proof. It cannot undo an action already dispatched.

An answer is refused with `denied` while the feature is off, with `approval-invalid` if the request is not waiting or cannot be answered this way (one answer for every such case), and with `proof-invalid` for a wrong key, a changed field, a stale time, a malformed nonce or a replay. The signature and the nonce are written to the same durable journal as Touch ID proofs *before* Gaddi acts, so a replay fails after a restart too. An approved action is then retried by the agent with `approval=<id>` exactly as after a Touch ID approval, and it still works once and only for the exact action. An approved session-grant request starts the grant as Touch ID would, and the grant is listed and audited as approved from the phone. A denial closes the request.

### Seeing it and ending it

The panel section is always shown. Off, it says in two sentences what it would allow and what stays Touch ID only. On, it shows the key's fingerprint and since when, with **Turn off**, which needs no Touch ID. The menu bar says when it is on. A waiting request it may answer says "Can also be approved from your phone", and the last ten answers it gave are listed with what, where and when. From a terminal, `gaddi remote` shows the status and `gaddi remote off` turns it off; there is no `on`, because turning it on is Touch ID in the app. No agent tool can answer or turn it on or off; `browser_approvals` lists waiting requests as before, so an agent can see which carry the flag. The audit records every answer as `approval.remote` with `approver: remote`, the request, its kind, the verb and the outcome, and every turn-on and turn-off; it never records a signature or a nonce.

V2 signs the enrollment generation as well as the immutable request. Turning on creates a fresh random 128-bit generation. An older saved enrollment derives a stable generation from its fingerprint and enable time; this preserves an existing owner choice, while refusing all old v1 signatures. Ordinary restart keeps the generation. Disable/re-enable changes it even for the same key, so old phone cards cannot regain authority. Gaddi and its Marcus client must upgrade together; an old client fails closed.

### The limit

The key of the phone approver is a file that any process running as your macOS user can read, so this path is weaker than Touch ID: a program on this Mac that can read that key can approve exactly what is described above, and nothing beyond it. That is why the scope is small, why it is off until you turn it on, and why it is one signed answer per request. It does not weaken what stays Touch ID only. As with everything else here, a process that can write Gaddi's own files can do more: it could write `remote.json` and restart the broker, as it could replace the Touch ID verification key `approver.pub`; the signed turn-on protects against everything that cannot write there. The facts Gaddi keeps about a waiting request live in memory only, so a request that was waiting when Gaddi restarted can only be answered with Touch ID until its agent asks again; Gaddi then announces it again with `approval.pending`. To change the key, turn the feature off, let the program write its new key, and turn it on again.

## Optional longer waits and larger cards

These options ship inactive. Omitting them preserves the configured request expiry and the maximum of twenty rules. This section is the policy record for the owner-requested approval improvements of 18 October 2026; it claims conformance for these rules, not repository-wide coverage.

**AUTH-WAIT.** An eligible pending request may wait longer for an answer, while usable signed authority stays within `ttl_minutes` and remains single use. Only session grants and the same upload/post/delete tier eligible for remote approval use the longer wait. Payments, purchases, sign-in, sends, security changes, protected pages and unknown classes keep their existing expiry. A pending grant still needs its live chat; ending that chat cancels it. Restart never restores granted authority. A monotonic deadline prevents backward wall-clock changes from extending usable authority. Verification crossing the pending deadline fails after spending the proof. Invalid restored timestamps are rejected. New admission stops at one hundred live approval records and their bounded captures. Valid older state with more than one hundred records is retained; it must fall below the limit before a new request is admitted. Capacity refusal never evicts an existing request.

**AUTH-PHONE.** Phone decisions bind immutable request data and enrollment generation, remain signed and one-use, and are revoked on disable. All affected in-memory authority is removed even if saving, expiry bookkeeping or reporting fails; an error still reports the failure. Enrollment still requires Touch ID. The local-key trust limit above remains explicit; no per-button biometric or phone-only-key claim is made. Implemented in `daemon/remote.ts`, `daemon/daemon.ts`, `daemon/grants.ts` and the paired Marcus client; tested by the remote gate, generation/revocation checks, `tests/policy/remote-revocation.ts` fault recovery and mutation suite.

**AUTH-LARGE-GRANT.** The owner can raise the Mac card limit from twenty to at most one hundred rules. Every rule is validated, displayed and signed in full. Allowed verbs, protected addresses, chat isolation, revocation and maximum duration stay the same. Phone-approved grants stay limited to twenty rules and two hours. These are delegated implementation bounds under the owner's request for hours-long waits and larger grants; no setting is enabled by this change.

The optional policy overlay fields are:

```json
{
  "approvals": {
    "ttl_minutes": 10,
    "wait_minutes": 720,
    "grant_rules_max": 100
  }
}
```

`wait_minutes` accepts whole minutes from 1 through 720; omission uses `ttl_minutes`. `grant_rules_max` accepts whole counts from 1 through 100; omission uses twenty. Overlay validation rejects malformed values before the broker listens. Quit Gaddi and stop the broker before an owner-approved overlay edit, then restart through the installation's existing service procedure. Never edit running application state externally. Keep other overlay fields when editing. Removing the two optional fields restores the original settings.

A waiting request and a permission have different lifetimes. Answering near a request's expiry does not extend it past that deadline; otherwise the signed action has at most `ttl_minutes` left. A session grant's duration starts when approved and ends independently of the request's waiting time.

These options do not make an individual approval portable across tabs. Site, verb and a control's name cannot establish which record, account or content a page will affect. Individual approvals retain their exact tab/action binding. A deliberately scoped session grant is the existing way to authorize eligible actions across replacement tabs: the owner approves the named site, path, verbs, chat and duration, rather than one particular target. It does not claim to approve one exact object.

Implemented in `daemon/approvals.ts`, `daemon/daemon.ts`, `daemon/grants.ts`, `daemon/policy.ts` and `daemon/remote.ts`. Exercised by `tests/policy/approval-wait.ts`, `tests/gates/approval-wait.test.sh` and the existing grant/remote gate and mutation tests. The new gate runs a real isolated broker and fixture Chrome transport; it is not a real Telegram or biometric demonstration.

## 1Password sign-in

Install the 1Password CLI and enable its desktop-app integration. Gaddi uses the desktop-app account with `OP_*` environment variables removed. It searches Login items for the tab's host or registrable domain, requires HTTPS except for local testing, and never accepts an unrelated selected item. Multiple matches return `choose`; specify an item title or ID to select one.

```sh
gaddi signin <tab-id>
gaddi signin <tab-id> --item '<login-title>'
gaddi signin <tab-id> --approval <approved-id>
```

Gaddi fills supported one-step and two-step forms and an available TOTP. Captchas, passkeys, locked 1Password and unsupported verification return `needs_you`. A `signed_in` outcome requires the password field to disappear and the URL or page to change; it is a page-state heuristic, not server-side proof of authentication.

The agent receives an outcome, site and item title, never a credential field from the sign-in operation. For ten minutes, the broker redacts exact credential matches from text tool output and audit/error records. This does not cover transformed values or screenshot pixels. A visible username or revealed password can still appear in a screenshot. Agents with unrestricted shell access can reach 1Password independently of Gaddi.

## Local records

`gaddi audit` records caller labels, action metadata and outcomes. Addresses omit query strings; typed text and page contents are excluded. Caller labels are supplied by clients, not authenticated operating-system identities. Captures and other state stay in `~/Library/Application Support/Gaddi` by default. Gaddi forwards page content to the connected agent, whose model provider and data policy you choose separately.
