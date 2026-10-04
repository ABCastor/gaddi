#!/usr/bin/env node
// install/register/edit.ts — the one editor behind the register scripts. Computes the new content of one
// harness config file, prints the exact change as a diff, and (unless --dry-run) backs the file up next to
// itself as <file>.bak-<ts> and writes atomically. Idempotent: a second run prints "no change" and touches nothing.
//
// usage: node edit.ts <kind> <file> --node <nodeBin> --server <server.mjs> --harness <name> --tools <a,b,c> [--dry-run] [--remove]
// kinds: claude-json | claude-settings | desktop-json | codex-toml | opencode-jsonc

import fs from 'node:fs';
import { parseJSON } from '../../shared/protocol.ts';

// Config editors historically accept object-valued fields, including arrays.
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

const argv = process.argv.slice(2);
const [kind, file] = argv;
const opt = (name: string, dflt: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const DRY = argv.includes('--dry-run');
const REMOVE = argv.includes('--remove');
const NODE = opt('--node', process.execPath);
const SERVER = opt('--server', '');
const HARNESS = opt('--harness', 'unknown');
const OMNIREAD = opt('--omniread', '');
const ENV = { GADDI_HARNESS: HARNESS, ...(OMNIREAD ? { OMNIREAD_BIN: OMNIREAD } : {}) };
const TOOLS = (opt('--tools', '') || '').split(',').filter(Boolean);
const NAME = 'gaddi';

if (!kind || !file) { console.error('usage: edit.ts <kind> <file> --node .. --server .. --harness .. --tools .. [--dry-run] [--remove]'); process.exit(2); }
if (!fs.existsSync(file)) { console.error(`edit: ${file} does not exist; nothing to ${REMOVE ? 'remove from' : 'register in'} (create it through the harness first)`); process.exit(REMOVE ? 0 : 1); }

const original = fs.readFileSync(file, 'utf8');
const editors: Record<string, (raw: string) => string> = { 'claude-json': claudeJson, 'claude-settings': claudeSettings, 'desktop-json': desktopJson, 'codex-toml': codexToml, 'opencode-jsonc': opencodeJsonc };
const editor = editors[kind];
if (!editor) { console.error(`edit: unknown kind ${kind}`); process.exit(2); }

const next = editor(original);
verify(kind, next);

if (next === original) {
  console.log(`no change: ${file} (${REMOVE ? 'nothing of ours present' : 'already registered'})`);
  process.exit(0);
}
console.log(`${DRY ? 'would change' : 'changing'}: ${file}`);
printDiff(original, next);
if (DRY) { console.log('dry-run: nothing written'); process.exit(0); }
const bak = `${file}.bak-${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}`;
fs.copyFileSync(file, bak);
fs.chmodSync(bak, fs.statSync(file).mode & 0o7777); // the backup holds the same secrets: same mode as the original
const tmp = `${file}.tmp-${process.pid}`;
fs.writeFileSync(tmp, next, { mode: fs.statSync(file).mode & 0o7777 });
fs.renameSync(tmp, file);
console.log(`wrote ${file} (backup ${bak})`);

// ---------------------------------------------------------------- JSON (Claude Code, Claude Desktop)
function serverEntry(withType: boolean) {
  const e = withType ? { type: 'stdio' } : {};
  return { ...e, command: NODE, args: [SERVER], env: ENV };
}
function rewriteJson(raw: string, fn: (obj: Record<string, unknown>) => void) {
  const obj = parseJSON(raw);
  if (!isObject(obj)) throw new Error('config must be an object');
  fn(obj);
  return JSON.stringify(obj, null, 2) + (raw.endsWith('\n') ? '\n' : '');
}
function claudeJson(raw: string) { return mcpServersJson(raw, true); }
function desktopJson(raw: string) { return mcpServersJson(raw, false); }
function mcpServersJson(raw: string, withType: boolean) {
  return rewriteJson(raw, obj => {
    if (REMOVE) { if (isObject(obj.mcpServers)) delete obj.mcpServers[NAME]; return; }
    const servers = isObject(obj.mcpServers) ? obj.mcpServers : {};
    obj.mcpServers = servers;
    servers[NAME] = serverEntry(withType);
  });
}
function claudeSettings(raw: string) {
  const prefix = `mcp__${NAME}__`;
  return rewriteJson(raw, obj => {
    const permissions = isObject(obj.permissions) ? obj.permissions : {};
    obj.permissions = permissions;
    const allow: unknown[] = Array.isArray(permissions.allow) ? permissions.allow : [];
    const kept = allow.filter(x => !(typeof x === 'string' && x.startsWith(prefix)));
    permissions.allow = REMOVE ? kept : kept.concat([...new Set(TOOLS.map(t => prefix + t))].sort());
  });
}

// ---------------------------------------------------------------- TOML (Codex)
function tomlStr(s: unknown) { return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'; }
function codexBlock() {
  // Invariant: broker gates remain the approval boundary. Codex 0.153 "auto" can still prompt
  // for write tools and fail headless; "approve" permits the broker to decide every action.
  const perTool = TOOLS.flatMap(t => [`[mcp_servers.${NAME}.tools.${t}]`, 'approval_mode = "approve"', '']);
  return [`[mcp_servers.${NAME}]`, `command = ${tomlStr(NODE)}`, `args = [${tomlStr(SERVER)}]`, 'default_tools_approval_mode = "approve"', '', `[mcp_servers.${NAME}.env]`, ...Object.entries(ENV).map(([key, value]) => `${key} = ${tomlStr(value)}`), '', ...perTool].join('\n');
}
// Remove every table whose header is [mcp_servers.gaddi] or [mcp_servers.gaddi.<sub>]:
// the block runs from its header through the last non-blank line before the next [header] or EOF,
// plus the single blank line that separates it from what precedes it.
function stripCodexBlocks(raw: string) {
  const lines = raw.split('\n');
  const isHeader = (l: string) => /^\s*\[/.test(l);
  const isOurs = (l: string) => new RegExp(`^\\s*\\[mcp_servers\\.${NAME.replace(/[-]/g, '\\-')}(\\.[^\\]]*)?\\]\\s*(#.*)?$`).test(l);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!isOurs(lines[i])) { out.push(lines[i]); continue; }
    let j = i + 1;
    while (j < lines.length && !isHeader(lines[j])) j++;
    let end = j; // exclusive
    while (end > i + 1 && lines[end - 1].trim() === '') end--;
    if (out.length && out[out.length - 1].trim() === '') out.pop();
    i = end - 1;
  }
  return out.join('\n');
}
function codexToml(raw: string) {
  const stripped = stripCodexBlocks(raw);
  if (REMOVE) return stripped;
  const base = stripped.endsWith('\n') ? stripped : stripped + '\n';
  return base + '\n' + codexBlock();
}

// ---------------------------------------------------------------- JSONC (OpenCode)
export function stripJsonc(src: string) {
  let out = '', i = 0, inStr = false;
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (inStr) { out += c; if (c === '\\') { out += n; i += 2; continue; } if (c === '"') inStr = false; i++; continue; }
    if (c === '"') { inStr = true; out += c; i++; continue; }
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    out += c; i++;
  }
  return out;
}
function jsonStr(s: unknown) { return JSON.stringify(String(s)); }
function opencodeEntryLines(ind: string, unit: string, trailingComma: boolean) {
  const i1 = ind + unit, i2 = i1 + unit;
  return [
    `${i1}"${NAME}": {`,
    `${i2}"type": "local",`,
    `${i2}"command": [${jsonStr(NODE)}, ${jsonStr(SERVER)}],`,
    `${i2}"environment": ${JSON.stringify(ENV)},`,
    `${i2}"enabled": true`,
    `${i1}}${trailingComma ? ',' : ''}`,
  ];
}
function opencodeJsonc(raw: string) {
  const nl = raw.includes('\r\n') ? '\r\n' : '\n';
  let lines = raw.split(nl);
  const unit = (lines.find(l => /^\s+\S/.test(l)) || '  x').match(/^\s+/)![0];
  const mcpRe = /^(\s*)"mcp"\s*:\s*\{\s*(\}\s*,?)?\s*$/;
  let mcpIdx = lines.findIndex(l => mcpRe.test(l));

  // remove an existing entry (ours) inside the mcp object
  const entryRe = new RegExp(`^\\s*"${NAME}"\\s*:\\s*\\{`);
  if (mcpIdx >= 0) {
    const start = lines.findIndex((l, k) => k > mcpIdx && entryRe.test(l));
    if (start >= 0) {
      let depth = 0, end = start;
      for (let k = start; k < lines.length; k++) {
        const bare = lines[k].replace(/"(?:[^"\\]|\\.)*"/g, '');
        depth += (bare.match(/\{/g) || []).length - (bare.match(/\}/g) || []).length;
        if (depth === 0) { end = k; break; }
      }
      const hadComma = /\},?\s*$/.test(lines[end]) && lines[end].trim().endsWith(',');
      lines.splice(start, end - start + 1);
      // if ours was the last entry, the previous entry must not keep a dangling comma
      if (!hadComma) {
        let p = start - 1;
        while (p > mcpIdx && lines[p].trim() === '') p--;
        if (p > mcpIdx && lines[p].trim().endsWith(',')) lines[p] = lines[p].replace(/,(\s*)$/, '$1');
      }
      // an mcp object left empty collapses to one line
      let q = start; while (q < lines.length && lines[q].trim() === '') q++;
      if (q < lines.length && /^\s*\}/.test(lines[q]) && q === mcpIdx + 1) {
        const m = lines[mcpIdx].match(mcpRe)!;
        lines.splice(mcpIdx, 2, `${m[1]}"mcp": {}${lines[q].trim().endsWith(',') ? ',' : ''}`);
      }
    }
  }
  if (REMOVE) return lines.join(nl);

  mcpIdx = lines.findIndex(l => mcpRe.test(l));
  if (mcpIdx >= 0) {
    const m = lines[mcpIdx].match(mcpRe)!;
    const ind = m[1];
    if (m[2]) { // "mcp": {} or "mcp": {},
      const comma = m[2].includes(',');
      lines.splice(mcpIdx, 1, `${ind}"mcp": {`, ...opencodeEntryLines(ind, unit, false), `${ind}}${comma ? ',' : ''}`);
    } else {
      // first entry, trailing comma: an existing entry follows (an open brace with nothing after it means the object is non-empty)
      let q = mcpIdx + 1; while (q < lines.length && lines[q].trim() === '') q++;
      const objectEmpty = q < lines.length && /^\s*\}/.test(lines[q]);
      lines.splice(mcpIdx + 1, 0, ...opencodeEntryLines(ind, unit, !objectEmpty));
    }
    return lines.join(nl);
  }
  // no "mcp" key: insert after "$schema" (or after the opening brace)
  let anchor = lines.findIndex(l => /^\s*"\$schema"\s*:/.test(l));
  if (anchor < 0) anchor = lines.findIndex(l => l.trim() === '{');
  if (anchor < 0) throw new Error('opencode.jsonc: no place to insert "mcp" (no "$schema" line and no opening brace line)');
  const ind = (lines[anchor].match(/^\s*/) || [''])[0] || unit;
  const isBrace = lines[anchor].trim() === '{';
  const keyInd = isBrace ? unit : ind;
  const block = [`${keyInd}"mcp": {`, ...opencodeEntryLines(keyInd, unit, false), `${keyInd}},`];
  if (!isBrace && !lines[anchor].trim().endsWith(',')) { lines[anchor] = lines[anchor].replace(/\s*$/, ','); block[block.length - 1] = `${keyInd}}`; }
  lines.splice(anchor + 1, 0, ...block);
  return lines.join(nl);
}

// ---------------------------------------------------------------- verify + diff
function verify(kind: string, content: string) {
  if (kind === 'codex-toml') {
    const n = (content.match(new RegExp(`^\\[mcp_servers\\.${NAME}\\]\\s*$`, 'gm')) || []).length;
    if (n !== (REMOVE ? 0 : 1)) throw new Error(`toml: expected ${REMOVE ? 0 : 1} [mcp_servers.${NAME}] header, found ${n}`);
    return;
  }
  const obj = parseJSON(kind === 'opencode-jsonc' ? stripJsonc(content) : content);
  const entry = isObject(obj) && isObject(obj.mcp) ? obj.mcp[NAME] : undefined;
  if (kind === 'opencode-jsonc' && !REMOVE && !(isObject(entry) && entry.type === 'local')) throw new Error('jsonc: entry not found after edit');
  if (kind === 'opencode-jsonc' && REMOVE && entry) throw new Error('jsonc: entry still present after remove');
}
function printDiff(a: string, b: string) {
  const A = a.split('\n'), B = b.split('\n');
  let s = 0; while (s < A.length && s < B.length && A[s] === B[s]) s++;
  let e = 0; while (e < A.length - s && e < B.length - s && A[A.length - 1 - e] === B[B.length - 1 - e]) e++;
  const ctx = 2;
  const out = [];
  // context and removed lines come from the user's file: mask anything secret-shaped before printing
  for (let i = Math.max(0, s - ctx); i < s; i++) out.push('  ' + redact(A[i]));
  for (let i = s; i < A.length - e; i++) out.push('- ' + redact(A[i]));
  for (let i = s; i < B.length - e; i++) out.push('+ ' + B[i]);
  for (let i = A.length - e; i < Math.min(A.length, A.length - e + ctx); i++) out.push('  ' + redact(A[i]));
  console.log(`@@ line ${s + 1}: -${A.length - e - s} +${B.length - e - s}`);
  console.log(out.join('\n'));
}
function redact(line: string) {
  return line
    .replace(/("(?:[^"]*(?:authorization|token|secret|password|passwd|api[_-]?key|bearer|cookie|sha256)[^"]*)"\s*:\s*)"[^"]*"/gi, '$1"<redacted>"')
    .replace(/(\b[A-Za-z_]*(?:TOKEN|SECRET|PASSWORD|KEY|SHA256S?)[A-Za-z_]*\s*=\s*)(["'])[^"']*\2/g, '$1$2<redacted>$2')
    .replace(/\bBearer\s+\S+/g, 'Bearer <redacted>')
    .replace(/(?<![\/\w-])[A-Za-z0-9_-]{32,}(?![\/\w-])/g, m => (/^[A-Z0-9_]+$/.test(m) || !/\d/.test(m)) ? m : '<redacted>');
}
