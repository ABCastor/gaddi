# Installation

Run registration from the checkout after `npm ci`. The [main README](../README.md#install) lists prerequisites and commands. Every registration script accepts `--dry-run`, `--remove`, or both. Antigravity requires its `agy` command on PATH.

| Component | Installed location |
|---|---|
| Broker | `~/Library/LaunchAgents/com.abcastor.gaddi.plist` |
| CLI | `~/.local/bin/gaddi`, linked to `cli/gaddi` |
| Approval app | `~/Applications/Gaddi.app`, launched on demand |
| Native host | `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.abcastor.gaddi.bridge.json` |
| Broker state | `~/Library/Application Support/Gaddi` |

The broker and native host point to this checkout. Register again if you move it. CLI registration refuses to overwrite an unrelated command. The app is replaced in place when rebuilt.

Harness scripts register the MCP server as `gaddi`. Claude Code gets generated tool permissions; Codex gets approval settings for each tool. The broker still checks every action. Claude Desktop must be closed before registration because it rewrites settings from memory. After restarting an agent, check `browser_status`, `browser_tabs` and a harmless `browser_look`. `gaddi audit` shows the calling agent and addresses without query strings; typed text and page contents are excluded.

## Policy

Create `policy.json` in the state directory to override [the default policy](../policy/policy.default.json), then restart the broker. For example:

```json
{
  "hold": { "url_patterns": ["/checkout", "/account/erase"] },
  "deny": { "eval_patterns": ["deleteAllRecords\\s*\\("] }
}
```

Objects merge recursively. Arrays replace their defaults, except `deny.eval_patterns`, which adds to the built-in password patterns. Keep the default entries when replacing an array if you still want those rules. Patterns are case-insensitive JavaScript regular expressions and are checked by the broker before evaluation reaches Chrome. A match is denied with no approval path.

All fields are optional. Supported sections are `hold` (`verbs`, `url_patterns`, `keys`, and `uploads`, a boolean that is `true` by default so every file upload waits for approval), `deny` (`verbs_on_hosts`, `type_into`, `eval_patterns`) and `approvals` (`ttl_minutes`, a positive number). Key rules require `url` and `keys`; host rules require `host` and `verbs`. Unknown fields, wrong types, invalid regular expressions and unreadable or malformed files prevent startup with an error naming the overlay. With no overlay, only the defaults apply.

`GADDI_HOME` changes the broker state directory. `GADDI_SOCKET` overrides its socket, normally `~/Library/Application Support/Gaddi/gaddi.sock`; set the same value for clients and the native host. `GADDI_APPROVER_PUB` selects the public key trusted by the broker. `GADDI_NODE` selects Node during registration. `OMNIREAD_BIN` selects an optional extractor; otherwise registration records `omniread` when it finds the command on PATH.

## Remove

Run each registration script you used with `--remove --dry-run`, then `--remove`. For an installation using every component:

```sh
bash install/register/all.sh --remove --dry-run
bash install/register/all.sh --remove
```

Remove the unpacked extension in `chrome://extensions` too. Removal preserves broker state, keys, audit records and screenshots.
