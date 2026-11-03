# Chat titles on approval cards

Gaddi accepts `_context.chat` per MCP call and `GADDI_CHAT` in the MCP adapter's environment. Pi's `gaddi-context` extension supplies per-call context. The broker cleans these words and freezes them on the first held request. They are display only, never authorization or a chat identity.

## Claude Code

Merge this object into `~/.claude/settings.json`, keeping existing hook entries. Replace `/absolute/path/to/gaddi` with the installation checkout. Restart Claude Code after installation.

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "^mcp__gaddi__browser_.*$",
      "hooks": [{
        "type": "command",
        "command": "node /absolute/path/to/gaddi/integrations/chat-context.ts claude-code",
        "timeout": 5
      }]
    }]
  }
}
```

The hook reads the provided `transcript_path`. It prefers the latest `custom-title` record's `customTitle`, then the latest `summary` record's `summary`. `GADDI_CHAT`, if set in the hook environment, overrides transcript discovery. The read is bounded to the last 8 MiB. Transcript formats are not a stable harness contract: missing titles, inaccessible files and malformed lines leave the call unchanged, using Gaddi's existing harness/project fallback. It never uses page text, tool output or a user message as a title. A title outside the bounded tail can be supplied through `GADDI_CHAT`.

The hook preserves all tool arguments and context fields except the display chat title. It emits no permission decision in Claude Code, so normal harness permission checks continue.

## Codex

Codex supports MCP `PreToolUse` argument rewriting. Its transcript does not promise a stable title field. Supply the actual chat title from the launcher as `GADDI_CHAT` in the adapter environment, alongside `GADDI_HARNESS=codex`; restart that adapter when changing its title. Do not set one global title for several conversations.

A launcher that supplies `GADDI_CHAT` to the hook process can instead merge the same JSON above into `~/.codex/hooks.json`, replacing `claude-code` with `codex`. Review and trust it through `/hooks`. The Codex mode supplies the `permissionDecision: "allow"` required for `updatedInput`; this is a harness tool-call decision only. Gaddi still performs every broker policy check and requires the same signed approvals. Without a title it emits nothing. This hook does not discover titles stored privately by a host application such as T3.

For a fixed adapter environment in `~/.codex/config.toml`:

```toml
[mcp_servers.gaddi.env]
GADDI_HARNESS = "codex"
GADDI_CHAT = "The title of this one chat"
```

Keep existing environment entries. Prefer launcher-supplied per-chat values over a static configuration shared by chats.

Contracts: [Claude Code hooks](https://code.claude.com/docs/en/hooks#pretooluse), [Codex hooks](https://developers.openai.com/codex/hooks). Run `bash tests/integrations/chat-context.test.sh` for synthetic hook/transcript and approval-record checks. Installation is manual; this repository does not edit harness settings.
