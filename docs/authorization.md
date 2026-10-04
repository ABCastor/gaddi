# Authorization and sign-in

The broker classifies an action as allowed, held or denied. A denied action has no approval path. A held action creates a pending request and returns its ID; the agent retries after the owner resolves it in Gaddi.

## Signed decisions

The approval app stores an encrypted, Mac-bound Secure Enclave key blob and its public key in Gaddi's local state directory. Signing requires macOS owner authentication. Touch ID and the Mac password are supported through the system authentication policy. An unavailable Secure Enclave has no software fallback.

Each signature binds the decision to the approval ID, action kind, tab, digest of the displayed detail and timestamp. The app rereads the pending action after authentication. The broker accepts proofs only within sixty seconds and records consumed signatures and operations before acting. Reusing a proof, changing the action or changing a bound target fails. A broker restart returns an unconsumed grant to pending, requiring another approval.

The approval panel can show a page capture around a click or Enter target. This is context for your decision, not proof that the page is honest. A page can change between inspection and Chrome input. Page-version checks narrow that gap but are not atomic with trusted input.

## Remembered permissions

Sign-in grants cover one exact origin, including scheme and port. Eligible sends cover that origin plus a specific send kind: Enter and a Send button have separate scopes. Remembering or revoking requires a signed app decision. Payments, deletion, security pages, uploads and denied actions never offer remembered send permission. The default policy remembers nothing.

The owner can also edit the local policy. That file and the broker run under the same macOS account as the agents: signed UI decisions do not make them tamper-proof against a process with full access to that account. Policy changes can relax defaults, including the upload hold. See [policy configuration](../install/README.md#policy).

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
