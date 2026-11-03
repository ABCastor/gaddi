#!/usr/bin/env node
// Display metadata only. No permission decision is emitted unless the harness requires it to rewrite input.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const title = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.trim().slice(0, 400) : undefined;

export function transcriptTitle(file: unknown): string | undefined {
  if (typeof file !== 'string' || !file) return undefined;
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return undefined;
    // Read a bounded tail: titles and summaries can appear after a rename or compaction.
    const start = Math.max(0, stat.size - 8 * 1024 * 1024);
    const bytes = Buffer.alloc(stat.size - start);
    fs.readSync(fd, bytes, 0, bytes.length, start);
    const lines = bytes.toString('utf8').split('\n');
    if (start) lines.shift();
    let custom: string | undefined, summary: string | undefined;
    for (const line of lines) {
      let entry: unknown;
      try { entry = JSON.parse(line); } catch { continue; }
      if (!record(entry)) continue;
      if (entry.type === 'custom-title') custom = title(entry.customTitle) ?? custom;
      if (entry.type === 'summary') summary = title(entry.summary) ?? summary;
    }
    return custom ?? summary;
  } catch { return undefined; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

export function hookOutput(event: unknown, env: Record<string, string | undefined> = process.env, harness = 'claude-code') {
  if (!record(event) || event.hook_event_name !== 'PreToolUse'
    || typeof event.tool_name !== 'string' || !/^mcp__gaddi__browser_[a-z_]+$/.test(event.tool_name) || !record(event.tool_input)) return undefined;
  // Codex transcripts have no stable title field. A launcher can supply GADDI_CHAT instead.
  const chat = title(env.GADDI_CHAT) ?? (harness === 'claude-code' ? transcriptTitle(event.transcript_path) : undefined);
  if (!chat) return undefined;
  const context = record(event.tool_input._context) ? event.tool_input._context : {};
  return { hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    ...(harness === 'codex' ? { permissionDecision: 'allow' } : {}),
    updatedInput: { ...event.tool_input, _context: { ...context, chat } },
  } };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    let input = '';
    for await (const chunk of process.stdin) {
      input += chunk;
      if (input.length > 1024 * 1024) process.exit(0);
    }
    const output = hookOutput(JSON.parse(input), process.env, process.argv[2]);
    if (output) process.stdout.write(JSON.stringify(output) + '\n');
  } catch { /* Missing metadata never prevents the ordinary tool call. */ }
}
