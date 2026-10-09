# Approval app

Gaddi shows pending actions in a menu-bar panel with the calling agent, tab, page, reason and expiry. A newly pending action brings the approval panel forward once and posts a notification. The panel still appears if notifications are denied or silenced by Focus. Repeated polls, connection errors and expired requests do not take focus. New requests wait while a decision is being authenticated. You can also open the panel from the notification, the menu, or `gaddi approve <id>`.

Approve and Deny require authentication and a Secure Enclave signature. Authentication supports Touch ID or the Mac password through macOS. The agent cannot produce an approval signature. `gaddi approve <id>` opens the requested action; it grants no authority.

Eligible sends use the sign-in panel's existing "Always allow on this site" choice. Authentication signs the exact origin and hold kind: Send with Enter and Send button are separate permissions. Remembered sends appear in the same panel with a signed Revoke action, and the default list is empty. Payment, deletion, security pages, uploads and refused actions never offer Always allow.

An agent can also ask, once per chat, to skip a few holds for a while (uploads, posts, deletes on pages it names). That request arrives as a card with its rules and length, approved with the same Touch ID signature. Active grants are listed in the panel under **Session grants**, with **End now**, which asks for no Touch ID because it only removes authority. See [authorization](../docs/authorization.md#session-grants).

## Build and install

Requires macOS 26 or later and Xcode:

```sh
bash app/build.sh
bash install/register/app.sh
```

The build produces `app/build/Gaddi.app` with ad-hoc signing. Registration installs it at `~/Applications/Gaddi.app`. The broker launches it in the background for a new hold or a restored pending hold after a restart. The app verifies the current pending list before raising the panel. Registration accepts `--dry-run` and `--remove`.

## Keys and approvals

The app stores an encrypted Secure Enclave key blob at `~/Library/Application Support/Gaddi/approver.key` with mode `0600`, and its public key at `approver.pub`. The blob is bound to the Mac. Keep it across rebuilds to retain the signing identity. An invalid or unreadable existing key causes an error and is never replaced. There is no software fallback when Secure Enclave is unavailable.

The broker verifies the signature against `GADDI_APPROVER_PUB`. Each decision binds the action ID, kind, tab, displayed detail and timestamp. The app rereads the pending action after authentication; a changed action needs a new review. The broker rejects stale or reused proofs, and a restart requires a fresh approval for an unconsumed grant. Displayed and stored addresses omit query strings.

`GADDI_SOCKET` overrides the broker socket. `GADDI_KEY_DIR` selects an isolated key directory for testing.

## Verify

```sh
bash tests/app/build.test.sh
bash tests/app/protocol.test.sh
bash tests/app/visibility.test.sh
bash tests/app/visibility-snapshot.test.sh
bash tests/app/approval-wake.test.sh
bash tests/app/key-store.test.sh
```

The build and protocol tests run without UI. The key-store test uses an isolated directory and needs Secure Enclave access. For a physical signature check, run from a desktop terminal:

```sh
'app/build/Gaddi.app/Contents/MacOS/Gaddi' --verify-self > tests/app/.signed
node tests/app/verify-signature.ts tests/app/.signed
```

With notifications denied or Focus enabled, create a harmless held action while Gaddi is stopped and while it is already running. Confirm the panel appears once without starting authentication. Close it and wait for two refreshes: it must stay closed until another pending action arrives. With a harmless held action, confirm the panel details, cancel authentication, then approve another action and deny another. Check that resolution and expiry remove pending entries. Try `gaddi approve <id>` with the app stopped and already running. Rebuild and relaunch, then check that the public key stays unchanged and the signature check passes.
