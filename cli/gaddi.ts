#!/usr/bin/env node
// Thin socket client. Approval launches the app's Touch ID flow; the CLI grants no authority.
import type { BrokerParams, BrokerResult, BrokerRequest } from '../shared/protocol.ts';
import { isRecord, parseJSON, errorMessage, waitParams } from '../shared/protocol.ts';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Drain both streams before an explicit exit: pipes may accept only part of a large write.
const exit = async (code: number): Promise<never> => {
  await new Promise<void>(resolve => process.stdout.write('', () => resolve()));
  await new Promise<void>(resolve => process.stderr.write('', () => resolve()));
  process.exit(code);
};
const die = (message: string, code = 1): never => { throw Object.assign(new Error(message), { exitCode: code }); };
async function main() {
const socket = process.env.GADDI_SOCKET || path.join(os.homedir(), 'Library/Application Support/Gaddi/gaddi.sock');
const usage = `usage: gaddi [--json] [--tab <id>] [--approval <id>] <command>
  tabs | bookmarks [query] | look [tab] [--visible] | read [tab|url] | html [tab] | screenshot [tab] [--full-page]
  open <url> [--foreground] [--group <task>] | goto [tab] <url> | back [tab]
  close <id> [id...] | show <id> | group <task> <id> [id...]
  click|hover [tab] <selector> | type [tab] <selector> <text> [--mode replace|append]
  press [tab] <key> | scroll [tab] <dy|selector> | select [tab] <selector> <value> | upload [tab] <selector> <path>
  wait [tab] <JSON options>
  signin [tab] [--item <title-or-id>]
  eval [tab] <expression> | emulate [tab] <JSON options>
  status | approvals | pending | cancel <id> | audit [n] | events | bridge status
  extensions [list | reload|enable|disable|uninstall <id|self> | install <folder>]
  approve <id> (opens the app's Touch ID approval sheet)`;
const argv = process.argv.slice(2), args: string[] = [];
let json = false, fullPage = false, foreground = false, visible = false;
let approval: string | undefined, tab: number | undefined, group: string | undefined, item: string | undefined;
let mode: 'replace' | 'append' | undefined;
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === '--json') json = true;
  else if (arg === '--full-page') fullPage = true;
  else if (arg === '--visible') visible = true;
  else if (arg === '--foreground') foreground = true;
  else if (arg === '--mode') {
    const value = argv[++i];
    if (value !== 'replace' && value !== 'append') die('--mode must be replace or append', 2);
    mode = value === 'append' ? 'append' : 'replace';
  }
  else if (['--tab', '--approval', '--group', '--item'].includes(arg)) {
    if (!argv[i + 1]) die(`${arg} needs a value`, 2);
    if (arg === '--tab') tab = Number(argv[++i]);
    else if (arg === '--group') group = argv[++i];
    else if (arg === '--item') item = argv[++i]; else approval = argv[++i];
  } else args.push(arg);
}
const cmd = args.shift() ?? '';
if (mode && cmd !== 'type') die('--mode is only supported for type', 2);
if (cmd === 'approve') {
  if (args.length !== 1 || !/^[a-f0-9]+$/i.test(args[0])) die('gaddi approve <id>', 2);
  // -n delivers arguments through a short-lived forwarding instance when the app is already running.
  const result = spawnSync('open', ['-n', '-b', 'com.abcastor.gaddi', '--args', '--approve', args[0]], { stdio: 'inherit' });
  if (result.error) die(result.error.message);
  await exit(result.status ?? 1);
}
const params: BrokerParams = { caller: process.env.GADDI_CALLER || 'cli' };
if (mode) params.mode = mode;
if (process.env.GADDI_HARNESS) params.harness = process.env.GADDI_HARNESS;
if (approval) params.approval = approval;
const tabCommands = ['look', 'read', 'html', 'screenshot', 'goto', 'back', 'click', 'hover', 'type', 'press', 'scroll', 'select', 'upload', 'eval', 'emulate', 'wait', 'signin'];
if (tabCommands.includes(cmd)) {
  // A lone numeric scroll argument is a distance; use --tab to remove ambiguity.
  if (tab === undefined && /^\d+$/.test(args[0] || '') && (args.length > 1 || ['look', 'read', 'html', 'screenshot', 'back', 'signin'].includes(cmd))) tab = Number(args.shift());
  if (tab !== undefined) {
    if (!Number.isSafeInteger(tab) || tab < 0) die('tab must be a nonnegative integer', 2);
    params.tab = tab;
  }
}
const take = (label: string): string => { if (args.length === 0) die(`gaddi ${cmd}: ${label} required`, 2); return args.shift()!; };
if (item !== undefined && cmd !== 'signin') die('--item applies only to signin', 2);
let method = cmd;
switch (cmd) {
  case 'look': if (visible) params.visible = true; break;
  case 'signin': if (item !== undefined) params.item = item; break;
  case 'tabs': case 'html': case 'back': case 'status': break;
  case 'close': case 'show': case 'group': {
    if (tab !== undefined) die(`gaddi ${cmd}: use positional tab IDs`, 2);
    if (cmd === 'group') params.group = take('task');
    if (!args.length || args.length > (cmd === 'show' ? 1 : 100)
      || args.some(id => !/^\d+$/.test(id) || !Number.isSafeInteger(Number(id)))) die(`gaddi ${cmd}: explicit tab IDs required (maximum ${cmd === 'show' ? 1 : 100})`, 2);
    const ids = args.splice(0).map(Number);
    if (cmd === 'show') params.tab = ids[0]; else params.tabs = ids;
    break;
  }
  case 'bookmarks': if (args.length) params.query = args.splice(0).join(' '); break;
  case 'read': if (args.length) params.url = take('URL'); break;
  case 'screenshot': params.fullPage = fullPage; break;
  case 'open': params.url = take('URL'); params.foreground = foreground; if (group !== undefined) params.group = group; break;
  case 'goto': params.url = take('URL'); break;
  case 'click': case 'hover': params.selector = take('selector'); break;
  case 'type': params.selector = take('selector'); params.text = take('text'); params.text += args.length ? ' ' + args.splice(0).join(' ') : ''; break;
  case 'press': params.key = take('key'); break;
  case 'scroll': { const value = take('dy or selector'); if (value.trim() && Number.isFinite(Number(value))) params.dy = Number(value); else params.selector = value; break; }
  case 'select': params.selector = take('selector'); params.value = take('value'); break;
  case 'upload': params.selector = take('selector'); params.path = take('path'); break;
  case 'eval': params.expression = take('expression'); params.expression += args.length ? ' ' + args.splice(0).join(' ') : ''; break;
  case 'wait': {
    const options = parseJSON(take('JSON options'));
    if (!isRecord(options) || Object.keys(options).some(key => !['text', 'selector', 'url', 'gone', 'timeout'].includes(key))) die('wait requires JSON wait options', 2);
    Object.assign(params, waitParams(options as Record<string, unknown>)); break;
  }
  case 'emulate': {
    let options: unknown; try { options = parseJSON(take('JSON options')); } catch { die('emulate requires JSON options', 2); }
    if (!options || typeof options !== 'object' || Array.isArray(options)) die('emulate requires JSON object', 2);
    for (const key of Object.keys(options as object)) if (!['width', 'height', 'mobile', 'colorScheme', 'animationSpeed', 'reset'].includes(key)) die(`unknown emulate option: ${key}`, 2);
    Object.assign(params, options); break;
  }
  case 'approvals': case 'pending': method = 'approvals.list'; break;
  case 'cancel': method = 'approval.cancel'; params.id = take('id'); break;
  case 'audit': method = 'audit.tail'; params.n = args.length ? Number(args.shift()) : 20; break;
  case 'events': method = 'events.subscribe'; break;
  case 'bridge': if (take('status') !== 'status') die('gaddi bridge status', 2); method = 'bridge.status'; break;
  case 'extensions': {
    const operation = args.length ? take('operation') : 'list';
    if (!['list', 'reload', 'enable', 'disable', 'uninstall', 'install'].includes(operation)) die('invalid extension operation', 2);
    params.operation = operation as NonNullable<BrokerParams['operation']>;
    if (operation === 'install') params.path = take('local folder');
    else if (operation !== 'list') params.extensionId = take('extension ID or self');
    break;
  }
  default: die(usage, 2);
}
if (args.length) die(`unexpected arguments: ${args.join(' ')}`, 2);
if (cmd === 'read') {
  const { readBrowser } = await import('../mcp/reader.ts');
  const rpc = <M extends string>(method: M, arguments_: BrokerParams = {}): Promise<BrokerResult<M>> => new Promise((resolve, reject) => {
    const connection = net.connect(socket); let buffer = '', settled = false;
    const done = (error: unknown, value?: unknown) => {
      if (settled) return; settled = true; clearTimeout(timer); connection.destroy();
      if (error) reject(error);
      // Preserve the reader's own result checks and error messages.
      else resolve(value as BrokerResult<M>);
    };
    const timer = setTimeout(() => done(new Error('daemon response timed out')), 60000);
    connection.setEncoding('utf8');
    connection.on('connect', () => connection.write(JSON.stringify({ id: 1, method, params: { caller: params.caller, ...(params.harness ? { harness: params.harness } : {}), ...arguments_ } } satisfies BrokerRequest) + '\n'));
    connection.on('error', error => done(error));
    connection.on('end', () => done(new Error('daemon closed without a response')));
    connection.on('data', data => {
      buffer += data; const end = buffer.indexOf('\n'); if (end < 0) return;
      try { const message = parseJSON(buffer.slice(0, end));
        if (!isRecord(message)) throw new Error('malformed response');
        if (message.error) done(Object.assign(new Error(errorMessage(message.error)), { daemonError: message.error }));
        else done(null, message.result);
      } catch (error) { done(error); }
    });
  });
  try {
    const result = await readBrowser(params, rpc);
    process.stdout.write(JSON.stringify(json ? { result } : result, null, json ? 0 : 2) + '\n');
  } catch (error) {
    const failure = isRecord(error) && isRecord(error.daemonError) ? error.daemonError : { code: 'error', message: errorMessage(error) };
    if (json) process.stdout.write(JSON.stringify({ error: failure }) + '\n'); else process.stderr.write(`gaddi: ${failure.message}\n`);
    await exit(failure.code === 'held' ? 4 : failure.code === 'denied' ? 5 : 1);
  }
  await exit(0);
}
const conn = net.connect(socket); let buffer = '', received = false;
const fail = async (message: string) => { process.stderr.write(message + '\n'); await exit(1); };
const timer = cmd === 'events' ? null : setTimeout(() => fail('gaddi: daemon response timed out'), 60000);
conn.setEncoding('utf8');
conn.on('connect', () => conn.write(JSON.stringify({ id: 1, method, params } satisfies BrokerRequest) + '\n'));
conn.on('error', error => fail(`gaddi: daemon not reachable at ${socket} (${(isRecord(error) ? error.code : undefined) || error.message})`));
conn.on('data', async data => {
  buffer += data; let end;
  while ((end = buffer.indexOf('\n')) >= 0) {
    let message: Record<string, unknown>;
    try { const parsed = parseJSON(buffer.slice(0, end)); if (!isRecord(parsed)) throw new Error('malformed response'); message = parsed; } catch { return await fail('gaddi: malformed response'); }
    buffer = buffer.slice(end + 1);
    if (cmd === 'events' && !message.error) { if (message.event) process.stdout.write(JSON.stringify(message) + '\n'); continue; }
    received = true; if (timer) clearTimeout(timer); conn.destroy();
    if (message.error) {
      const failure = isRecord(message.error) ? message.error : {};
      const code = failure.code === 'held' ? 4 : failure.code === 'denied' ? 5 : 1;
      if (json) process.stdout.write(JSON.stringify({ error: message.error }) + '\n');
      else process.stderr.write(`gaddi: ${failure.message}\n`);
      await exit(code);
    }
    process.stdout.write((cmd === 'screenshot' && !json ? (isRecord(message.result) ? message.result.path : undefined)
      : JSON.stringify(json ? { result: message.result } : message.result, null, json ? 0 : 2)) + '\n');
    await exit(0);
  }
});
conn.on('end', async () => { if (cmd === 'events') await exit(0); if (!received) await fail('gaddi: connection closed without a response'); });
}
await main().catch(async (error: unknown) => { process.stderr.write(errorMessage(error) + '\n'); await exit(isRecord(error) && typeof error.exitCode === 'number' ? error.exitCode : 1); });
