# Authorization and sign-in

The broker classifies an action as allowed, held or denied. A denied action has no approval path. A held action creates a pending request and returns its ID; the agent retries after the owner resolves it in Gaddi.

## Signed decisions

The approval app stores an encrypted, Mac-bound Secure Enclave key blob and its public key in Gaddi's local state directory. Signing requires macOS owner authentication. Touch ID and the Mac password are supported through the system authentication policy. An unavailable Secure Enclave has no software fallback.

Each signature binds the decision to the approval ID, action kind, tab, digest of the displayed detail and timestamp. The app rereads the pending action after authentication. The broker accepts proofs only within sixty seconds and records consumed signatures and operations before acting. Reusing a proof, changing the action or changing a bound target fails. A broker restart returns an unconsumed grant to pending, requiring another approval.

The approval panel can show a page capture around a click or Enter target. This is context for your decision, not proof that the page is honest. A page can change between inspection and Chrome input. Page-version checks narrow that gap but are not atomic with trusted input.

## Remembered permissions

Sign-in grants cover one exact origin, including scheme and port. Eligible sends cover that origin plus a specific send kind: Enter and a Send button have separate scopes. Remembering or revoking requires a signed app decision. Payments, deletion, security pages, uploads and denied actions never offer remembered send permission. The default policy remembers nothing.

## Session grants

An agent can ask once, at the start of a chat, to skip a few holds for a while. It calls `browser_grant` with rules of the form `<upload|post|delete> <https address prefix>` (for example `upload https://github.com/settings`), a length from 5 minutes to 12 hours, and an optional label in its own words. Gaddi shows a card with the rules, the length and the label, marked as the agent's description. Only your answer creates the grant, with Touch ID in the Gaddi app or, if you have turned it on, from your phone for a grant of at most 2 hours (see [approvals from another device](#approvals-from-another-device)); nothing an agent or a page says can.

- **What can be waived.** Only an upload hold, a hold on `post`, `publish`, `share` (and their Italian forms) and a hold on `delete`, `remove` and their forms. Payments, purchases, sending email or messages, sign-in, account and security changes, every protected address, guarded keys, navigation holds, extension operations and any verb you add yourself stay held every time. A request that names any of those is refused outright, and Gmail cannot be named at all. A refused or denied action stays refused or denied.
- **Where it applies.** A rule covers its exact site (scheme, host and port) and the path prefix on a path boundary: `/settings` covers `/settings/profile`, never `/settingsX`. A button whose name also contains a verb that is not granted ("Post and pay") stays held, and so does a link that leads outside the granted prefix or to a protected address. An upload still goes through the secret-file refusal first.
- **Whose it is.** A grant belongs to the one chat that asked, identified by the connection its Gaddi adapter keeps open (one adapter process is one chat; an app that runs several conversations through a single adapter shares the grant between them). Another adapter, or a command-line call, gets nothing. It ends when the time is up, when that connection closes, when you end it, or when the broker restarts: grants live in memory only and are never read back from disk.
- **Seeing and ending it.** The panel lists every active grant (who, until when, what, the agent's words) and shows an empty list when there is none. **End now** needs no Touch ID, because it only removes authority. The menu bar shows how many grants are running. `browser_approvals` lists them for the agent too.
- **Audit.** `grant.request`, `grant.start` and `grant.end` (expired, session-ended or revoked) are logged, and every action a grant allowed carries `grant: <id>`.

What this does not give you: a grant trusts the whole chat inside its rules, including anything a web page talks that chat into doing there. An upload grant lets the chat attach any file from your home folder that is not on the secret-file list to that page. Keep the rules narrow and the time short. The chat identity is a random ID held by the adapter process, not an authenticated operating-system identity: the broker never lists or logs it, but a process under your account that learned it could use the grant.

The owner can also edit the local policy. That file and the broker run under the same macOS account as the agents: signed UI decisions do not make them tamper-proof against a process with full access to that account. Policy changes can relax defaults, including the upload hold. See [policy configuration](../install/README.md#policy).

## Approvals from another device

A separate program of yours, for instance a Telegram bot running on your own machine, can answer some of Gaddi's requests so that you can say yes from your phone. It is **off by default**. **Only your Touch ID in the Gaddi app turns it on.** **Anyone who can reach the socket can turn it off**, because turning it off only removes authority. It covers only the lowest tiers, and only requests that Gaddi itself marks as answerable.

### What it can answer

While it is on, a waiting request carries `remote: true` and a `digest` if it is one of these, and only then:

- **An upload, a post or a delete** that a session grant on that page could waive. The hold is the same upload, post or delete hold; the page is an address a grant rule can name (https, or http on this Mac) and is not protected (payments, account and security pages, Gmail); every action word in the button's name is one of those three, so "Post and pay" is not; and a link's destination is on the same site and not protected. Gaddi judges this with the very scan session grants use, from the page address as it was when the request was held (a query can make a page protected), and again every time the request is listed or answered.
- **A session-grant request of 2 hours or less.**

Never, whatever the program sends: payments and purchases, sending email or messages, sign-in, account and security changes and every protected address, guarded keys (such as Cmd+Enter in Gmail), navigation, extension operations, script evaluation, and anything Gaddi did not mark. Those need your Touch ID on this Mac every time.

### The contract

1. **Key.** The program generates its own Ed25519 key pair and writes the public key, as an SPKI PEM (`-----BEGIN PUBLIC KEY-----`), to `~/Library/Application Support/Gaddi/remote-approver.pub` (`$GADDI_REMOTE_KEY` overrides the path). That file is only a candidate. It authorizes nothing, a private key or any other kind of key is ignored, and once you have turned the feature on, changing the file does nothing until you turn it on again.
2. **Turn on.** In the Gaddi panel, **Approvals from your phone**, **Turn on…** shows the waiting key's fingerprint (the first 16 hex digits of the SHA-256 of its DER SPKI, in groups of four) so you can compare it with the one the program shows you, then asks for Touch ID. Touch ID signs `remote.enable|<fingerprint>|<ts>` over the full fingerprint. Gaddi stores that key (`remote.json`, owner-only) and uses only it from then on. The saved choice survives a restart; a damaged file means off.
3. **Listen.** Connect to the socket and send `{"id":1,"method":"events.subscribe","params":{"caller":"marcus"}}`. Act on `approval.pending` events whose `approval.remote === true`, or poll `approvals.list` and keep the rows where `remote === true`. Listen for `remote.changed` too: it announces on and off, and after it you should list again, because requests that were already waiting change their flag.
4. **Show and answer.** Show the owner `caller`, `kind`, `detail`, and `url`. A request that has a page capture also carries `imagePath` (a JPEG on this Mac) and `box` (the target, in the picture's pixels); showing the picture with the target outlined lets him see what he is approving, as the Mac does. When he decides, send `{"method":"approval.remote","params":{"id":…,"verb":"grant"|"deny","nonce":…,"ts":…,"sig":…}}` where
   - `sig` is the base64 Ed25519 signature (64 bytes) of the UTF-8 text `gaddi-remote|<verb>|<id>|<kind>|<digest>|<nonce>|<ts>`;
   - `digest` is the `digest` field of the request, the SHA-256 hex of `<kind>|<id>|<detail>`, so a decision cannot be moved to another request or to a request whose text changed;
   - `nonce` is 16 to 128 characters of `A-Za-z0-9_-`, never reused;
   - `ts` is the time in whole milliseconds, within 120 seconds of Gaddi's clock.
5. **Off and status.** `remote.status` reports `{enabled, fingerprint, enabledAt, candidate}`. `remote.disable` turns it off at once and needs no proof.

An answer is refused with `denied` while the feature is off, with `approval-invalid` if the request is not waiting or cannot be answered this way (one answer for every such case), and with `proof-invalid` for a wrong key, a changed field, a stale time, a malformed nonce or a replay. The signature and the nonce are written to the same durable journal as Touch ID proofs *before* Gaddi acts, so a replay fails after a restart too. An approved action is then retried by the agent with `approval=<id>` exactly as after a Touch ID approval, and it still works once and only for the exact action. An approved session-grant request starts the grant as Touch ID would, and the grant is listed and audited as approved from the phone. A denial closes the request.

### Seeing it and ending it

The panel section is always shown. Off, it says in two sentences what it would allow and what stays Touch ID only. On, it shows the key's fingerprint and since when, with **Turn off**, which needs no Touch ID. The menu bar says when it is on. A waiting request it may answer says "Can also be approved from your phone", and the last ten answers it gave are listed with what, where and when. From a terminal, `gaddi remote` shows the status and `gaddi remote off` turns it off; there is no `on`, because turning it on is Touch ID in the app. No agent tool can answer or turn it on or off; `browser_approvals` lists waiting requests as before, so an agent can see which carry the flag. The audit records every answer as `approval.remote` with `approver: remote`, the request, its kind, the verb and the outcome, and every turn-on and turn-off; it never records a signature or a nonce.

### The limit

The key of the phone approver is a file that any process running as your macOS user can read, so this path is weaker than Touch ID: a program on this Mac that can read that key can approve exactly what is described above, and nothing beyond it. That is why the scope is small, why it is off until you turn it on, and why it is one signed answer per request. It does not weaken what stays Touch ID only. As with everything else here, a process that can write Gaddi's own files can do more: it could write `remote.json` and restart the broker, as it could replace the Touch ID verification key `approver.pub`; the signed turn-on protects against everything that cannot write there. The facts Gaddi keeps about a waiting request live in memory only, so a request that was waiting when Gaddi restarted can only be answered with Touch ID until its agent asks again; Gaddi then announces it again with `approval.pending`. To change the key, turn the feature off, let the program write its new key, and turn it on again.

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
