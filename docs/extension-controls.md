# Recovery and extension controls

`browser_extensions` and `gaddi extensions` share the broker's policy and signed approvals. `operation` defaults to `list`. Use `extensionId` for `reload`, `enable`, `disable` and `uninstall`, or `path` for `install`. The ID `self` selects Gaddi. Public callers cannot supply Chrome debugging endpoints, protocol commands or trust roots.

| Operation | Gaddi gate | Chrome behavior |
|---|---|---|
| List | None | Returns extension identity, version, enabled state and management restrictions |
| Reload Gaddi | None | Acknowledges a scheduled self-reload, subject to persisted limits |
| Reload another enabled extension | None | Disable then enable; restores enabled state if the first enable fails |
| Enable | None | Chrome can require a user gesture when permissions increased |
| Disable | Held by default | Cannot disable Gaddi or override Chrome management policy |
| Uninstall | Held by default | Returns `needs_you`; the owner must click Remove and confirm in Chrome |
| Install a folder under an owner-configured trusted root | None | Requires explicit installer setup and Chrome connection consent |
| Install another eligible owner-local folder | Held | Approval binds to all source bytes; Chrome loads a retained snapshot |

An owner's policy can set `hold.extensions.disable` or `hold.extensions.uninstall` to `false`. The shipped defaults hold both. Installation is held by default. To trust a local development tree, set `GADDI_EXTENSION_TRUST_ROOT` to an absolute folder in your home when starting the broker. Only its subfolders are trusted; symlinked or unavailable roots grant no trust. Agents cannot supply a trust root through a browser request. Supplied approval IDs always undergo exact-action and single-use checks, including on otherwise allowed operations. Extension names and descriptions are untrusted output.

Other-extension reload restarts its code with the currently registered manifest. It does not promise to load changed permissions or update cached manifest metadata. Chrome's own Reload button is still required for those changes. Reloading a disabled extension is refused; enabling must be explicit. Chrome's [management API](https://developer.chrome.com/docs/extensions/reference/api/management) requires a Chrome user gesture for another extension's uninstall confirmation. Touch ID in the native Gaddi app does not supply that gesture.

## Install into the existing Chrome

Chrome's consent mode lets a local debugging client connect to the existing browser, including its default profile, after an owner dialog. This is broader access than extension management alone: other local debugging clients can also request permission. Gaddi's installer opens a short connection, sends only `Extensions.loadUnpacked` with the vetted local path, and closes it. It exposes no arbitrary debugging command to agents.

Setup:

1. In the existing Chrome, open `chrome://inspect/#remote-debugging` and enable remote debugging. Gaddi never changes this setting or Chrome's preferences itself.
2. In the main checkout, run `bash install/register/daemon.sh --allow-extension-install`. This writes `GADDI_EXTENSION_INSTALL=1` into the broker's LaunchAgent and restarts it when its registration changes. Running registration without that flag turns automatic installation off again. A manually launched broker can use the same environment variable.
3. Ask for a local install, then approve Chrome's connection dialog. Chrome asks per connection, so this path is not an unattended zero-click installer.

The installer reads the owner-controlled default Chrome profile's `DevToolsActivePort` file and uses only the consent server's fixed `/devtools/browser` route on IPv4 loopback. It deliberately avoids the UUID route used by flag-based debugging servers. Missing setup or refused consent returns `installed:false` and the manual Load unpacked steps. Losing confirmation after sending returns `installed:null`: inspect the extension list before retrying, because Chrome may have loaded it.

The public folder validator accepts Manifest V3, regular owner-owned files in the owner's home, and bounded trees of up to 5,000 entries and 64 MB. It refuses symlinks, files writable by other users, downloaded-origin metadata, Downloads and Trash, credentials and protected app state. Install requests never fetch packages or execute extension files. Stable identities pinned by a manifest `key` require the owner's manual Load unpacked path; use Gaddi's reload operation after that initial registration.

Owner repository installs keep the original development folder, so future code edits remain available on restart. An outside-repo approval loads a retained copy under Gaddi's `extension-installs` storage. Editing the original does not change that installed snapshot; installing a changed snapshot creates a new path-derived identity, so the owner must remove the old copy explicitly. These copies are retained while Chrome may reference them. Outside-repo extensions with static network rules use the manual Load unpacked path: Chrome needs to write indexed rules under the extension folder, which conflicts with an immutable approved snapshot. Revalidation happens after both Gaddi approval and Chrome connection consent.

Primary sources: [Chrome's existing-session debugging announcement](https://developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session), [Chrome 154 consent server](https://chromium.googlesource.com/chromium/src/+/154.0.8037.97/chrome/browser/devtools/remote_debugging_server.cc), [Chrome 154 browser-target extension handler](https://chromium.googlesource.com/chromium/src/+/154.0.8037.97/chrome/browser/devtools/chrome_devtools_session.cc), and [macOS external-install restrictions](https://developer.chrome.com/docs/extensions/how-to/distribute/install-extensions). External JSON installs on macOS require the Web Store; they do not load an unpacked local folder.

## Recovery

The extension makes a health request through the native host to the broker. A connected native port alone is insufficient: a host can remain alive while the broker is absent or stuck. The health deadline is ten seconds; healthy connections are checked every fifteen seconds, with a thirty-second Chrome alarm recovering suspended timers. Reconnect delay grows from 250 ms to thirty seconds and resets only after a successful broker round trip.

Five failures schedule `chrome.runtime.reload()`. Recovery metadata and reload allowance are saved before that call: one reload per ten minutes, at most three per hour, across worker restarts. A failed storage read cannot overwrite unknown prior allowance, and failed writes cannot authorize a reload. Connection attempts continue while reload is rate-limited or storage is unavailable. Broker status reports the last reconnect or reload with a fixed reason code after a subsequent health report.

No pending page action is replayed on reconnect. Old port messages, stale replies and expired requests cannot start work on the replacement connection. A self-reload returns `scheduled:true` before dropping the port; `scheduled:false` explains cooldown or unavailable storage.

Recovery cannot re-enable a manually disabled Gaddi, recreate missing host registration or binaries, or free disk space. The ENOSPC regression proves that native-host logging failures do not corrupt its protocol or kill it. It does not establish why the historical host died. Once the host and broker can start again, the watchdog/reconnect path recovers without a manual extension Reload.
