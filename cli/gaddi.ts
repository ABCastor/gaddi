#!/usr/bin/env node
// Thin socket client. Approval launches the app's Touch ID flow; the CLI grants no authority.
import type { BrokerParams, BrokerResult, BrokerRequest } from '../shared/protocol.ts';
import { isRecord, parseJSON, errorMessage, waitParams, FRAME_TOOLS } from '../shared/protocol.ts';
import { redactURLText } from '../shared/url-redaction.ts';
import net from 'node:net';
import { socketRequest, SocketError } from '../shared/socket.ts';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Invariant: locally generated errors and event/reader formatting obey the same URL rule as RPCs.
const output = (value: string) => process.stdout.write(redactURLText(value));
const diagnostic = (value: string) => process.stderr.write(redactURLText(value));

// Drain both streams before an explicit exit: pipes may accept only part of a large write.
const exit = async (code: number): Promise<never> => {
  await new Promise<void>(resolve => process.stdout.write('', () => resolve()));
  await new Promise<void>(resolve => process.stderr.write('', () => resolve()));
  process.exit(code);
};
const die = (message: string, code = 1): never => { throw Object.assign(new Error(message), { exitCode: code }); };
async function main() {
const socket = process.env.GADDI_SOCKET || path.join(os.homedir(), 'Library/Application Support/Gaddi/gaddi.sock');
const usage = `usage: gaddi [--json] [--tab <id>] [--approval <id>] [--why <purpose>] <command>
  tabs | bookmarks [query] | look [tab] [--visible] | read [tab|url] | html [tab] | screenshot [tab] [--full-page]
  open <url> [--foreground] [--group <task>] | goto [tab] <url> | back [tab]
  close <id> [id...] | show <id> | group <task> <id> [id...]
  click [tab] <selector> | click [tab] --at x,y  (the point a screenshot shows, in the tab's own viewport;
      trusted input on what is really there, through a banner and inside an embedded page)
  drag [tab] <x,y> <x,y> [--hold-ms N] | hold [tab] <selector|x,y> <ms>  (the button held down: a drag from one point to
      the other, over N ms, or a press held that long; judged as a click on what it presses and where it lets go;
      also click --at x,y --to x,y and click ... --hold-ms N)
  type [tab] <selector> <text> [--mode replace|append] | type [tab] <password-field> --secret <1Password item>
      (the item's password goes from 1Password into the field; never typed as text, never shown)
  press [tab] <key> | select [tab] <selector> <value> | upload [tab] <selector> <path>
  --frame <id> with look, screenshot, click, type, press, hover, select, scroll, wait or upload acts
      inside a document look listed;
      screenshot crops to it (a challenge picture, answered by pressing --at points); --zoom x,y,w,h
      with screenshot magnifies part of that document, in its own pixels, for a picture too small to read; keys there need
      that document to hold the focus. --at and --frame are alternatives, never both.
  scroll [tab] <dy|selector> [--dx N] [--dy N]  (wheel pixels; with a selector the wheel goes over that element)
  wait [tab] <JSON options>
  signin [tab] [--item <title-or-id>] [--signup | --create '{"title":"...","username":"...","vault":"<vault-id>"}'] [--submit]
  click [tab] <selector> --download <new-file-in-Downloads-or-temp>
  eval [tab] <expression> [--write]  (read-only; --write asks the owner to approve this exact script, which may change the page)
  emulate [tab] <JSON options>
  status | approvals | pending | cancel <id> | audit [n] | events | bridge status
  remote | remote off  (approving some holds from another device: show its state, or turn it off; turning it on needs Touch ID in the Gaddi app)
  extensions [list | reload|enable|disable|uninstall <id|self> | install <folder>]
  approve <id> (opens the app's Touch ID approval sheet)
  The panel can remember sign-ins, eligible sends and uploads per site; Revoke removes a permission.
  --why, GADDI_CHAT and GADDI_PROJECT are shown on the approval card if the command is held.`;
const argv = process.argv.slice(2), args: string[] = [];
let json = false, fullPage = false, foreground = false, visible = false;
let approval: string | undefined, tab: number | undefined, group: string | undefined, item: string | undefined, why: string | undefined;
let mode: 'replace' | 'append' | undefined;
let signup = false, submit = false, write = false, create: BrokerParams['create'], download: string | undefined, fillItem: string | undefined;
let at: { x: number; y: number } | undefined, frame: number | undefined, to: { x: number; y: number } | undefined, holdMs: number | undefined;
// A viewport point as x,y: the place a screenshot shows.
const point = (value: string, flag: string) => {
  const parts = value.split(',').map(part => Number(part.trim()));
  if (parts.length !== 2 || parts.some(part => !Number.isFinite(part) || part < 0)) die(`${flag} needs viewport coordinates as x,y`, 2);
  return { x: parts[0], y: parts[1] };
};
const duration = (value: string | undefined, flag: string) => {
  if (!/^\d+$/.test(value || '') || !Number.isSafeInteger(Number(value))) die(`${flag} needs whole milliseconds`, 2);
  return Number(value);
};
let zoom: { x: number; y: number; width: number; height: number } | undefined;
const wheel: { dx?: number; dy?: number } = {};
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === '--json') json = true;
  else if (arg === '--dx' || arg === '--dy') {
    const value = argv[++i];
    if (!value?.trim() || !Number.isFinite(Number(value))) die(`${arg} needs a number`, 2);
    wheel[arg.slice(2) as 'dx' | 'dy'] = Number(value);
  }
  else if (arg === '--signup') signup = true;
  else if (arg === '--submit') submit = true;
  else if (arg === '--write') write = true;
  else if (arg === '--secret') { fillItem = argv[++i]; if (!fillItem?.trim()) die('--secret needs a 1Password item title or ID', 2); }
  else if (arg === '--create') {
    const value = parseJSON(argv[++i] || 'null');
    if (isRecord(value) && typeof value.title === 'string' && typeof value.username === 'string'
      && typeof value.vault==='string' && Object.keys(value).every(key=>['title','username','vault'].includes(key))) create = {title:value.title,username:value.username,vault:value.vault};
    else die('--create needs JSON with title, username and vault ID, never a password',2);
  }
  else if (arg === '--download') { download = argv[++i]; if (!download) die('--download needs a new file path',2); }
  else if (arg === '--full-page') fullPage = true;
  else if (arg === '--zoom') {
    // A region of the embedded document, in that document's own pixels: x,y,width,height.
    const parts = (argv[++i] || '').split(',').map(part => Number(part.trim()));
    if (parts.length !== 4 || parts.some(part => !Number.isFinite(part) || part < 0)) die('--zoom needs x,y,width,height', 2);
    zoom = { x: parts[0], y: parts[1], width: parts[2], height: parts[3] };
  }
  else if (arg === '--at') {
    const value = argv[++i] || '';
    const parts = value.split(',').map(part => Number(part.trim()));
    if (parts.length !== 2 || parts.some(part => !Number.isFinite(part) || part < 0)) die('--at needs viewport coordinates as x,y', 2);
    at = { x: parts[0], y: parts[1] };
  }
  else if (arg === '--to') to = point(argv[++i] || '', '--to');
  else if (arg === '--hold-ms') holdMs = duration(argv[++i], '--hold-ms');
  else if (arg === '--frame') {
    const value = argv[++i] || '';
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) die('--frame needs a frame id from look', 2);
    frame = Number(value);
  }
  else if (arg === '--visible') visible = true;
  else if (arg === '--foreground') foreground = true;
  else if (arg === '--mode') {
    const value = argv[++i];
    if (value !== 'replace' && value !== 'append') die('--mode must be replace or append', 2);
    mode = value === 'append' ? 'append' : 'replace';
  }
  else if (['--tab', '--approval', '--group', '--item', '--why'].includes(arg)) {
    if (!argv[i + 1]) die(`${arg} needs a value`, 2);
    if (arg === '--tab') tab = Number(argv[++i]);
    else if (arg === '--why') why = argv[++i];
    else if (arg === '--group') group = argv[++i];
    else if (arg === '--item') item = argv[++i]; else approval = argv[++i];
  } else args.push(arg);
}
const cmd = args.shift() ?? '';
if (mode && cmd !== 'type') die('--mode is only supported for type', 2);
if ((signup || create || submit) && cmd !== 'signin') die('--signup, --create and --submit apply only to signin',2);
if (submit && !signup && !create) die('--submit applies to --signup or --create',2);
if (fillItem !== undefined && (cmd !== 'type' || mode)) die('--secret applies only to type, without --mode', 2);
if (download !== undefined && cmd !== 'click') die('--download applies only to click',2);
if (write && cmd !== 'eval') die('--write applies only to eval', 2);
if (at && cmd !== 'click') die('--at applies only to click', 2);
if (to && cmd !== 'click') die('--to applies only to click (or use drag)', 2);
if (holdMs !== undefined && !['click', 'drag'].includes(cmd)) die('--hold-ms applies only to click and drag', 2);
if (at && frame !== undefined) die('--at is a point in the tab, so it takes no --frame', 2);
// The daemon decides what a frame means; the CLI must not narrow the surface it offers, or the
// same capability exists through MCP and not from a shell.
if (frame !== undefined && !FRAME_TOOLS.includes(cmd)) die(`--frame applies to ${FRAME_TOOLS.slice(0, -1).join(', ')} or ${FRAME_TOOLS.at(-1)}`, 2);
if ((wheel.dx !== undefined || wheel.dy !== undefined) && cmd !== 'scroll') die('--dx and --dy are only supported for scroll', 2);
if (cmd === 'approve') {
  if (args.length !== 1 || !/^[a-f0-9]+$/i.test(args[0])) die('gaddi approve <id>', 2);
  // -n delivers arguments through a short-lived forwarding instance when the app is already running.
  const result = spawnSync('open', ['-n', '-b', 'com.abcastor.gaddi', '--args', '--approve', args[0]], { stdio: 'inherit' });
  if (result.error) die(result.error.message);
  await exit(result.status ?? 1);
}
const params: BrokerParams = { caller: process.env.GADDI_CALLER || 'cli' };
if (mode) params.mode = mode;
if (signup) params.signup = true;
if (create) params.create = create;
if (download !== undefined) params.download = download;
if (at) params.at = at;
if (to) params.to = to;
if (holdMs !== undefined) params.holdMs = holdMs;
if (frame !== undefined) params.frameId = frame;
if (process.env.GADDI_HARNESS) params.harness = process.env.GADDI_HARNESS;
if (approval) params.approval = approval;
if (why) params.why = why;
if (process.env.GADDI_CHAT || process.env.GADDI_PROJECT) params.context = { chat: process.env.GADDI_CHAT, project: process.env.GADDI_PROJECT };
const tabCommands = ['look', 'read', 'html', 'screenshot', 'goto', 'back', 'click', 'drag', 'hold', 'hover', 'type', 'press', 'scroll', 'select', 'upload', 'eval', 'emulate', 'wait', 'signin'];
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
  case 'signin': if (item !== undefined) params.item = item; if (submit) params.submit = true; break;
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
  case 'screenshot': params.fullPage = fullPage; if (zoom) params.zoom = zoom; break;
  case 'open': params.url = take('URL'); params.foreground = foreground; if (group !== undefined) params.group = group; break;
  case 'goto': params.url = take('URL'); break;
  case 'click': if (at) { if (args.length) die('click: --at takes no selector', 2); } else params.selector = take('selector'); break;
  // DRAG-HOLD: both are clicks that keep the button down; the broker judges and binds them as clicks.
  case 'drag': method = 'click'; params.at = point(take('start x,y'), 'drag'); params.to = point(take('end x,y'), 'drag'); break;
  case 'hold': {
    method = 'click';
    const target = take('selector or x,y');
    if (/^\d+(?:\.\d+)?,\d+(?:\.\d+)?$/.test(target)) params.at = point(target, 'hold'); else params.selector = target;
    params.holdMs = duration(take('milliseconds'), 'hold');
    break;
  }
  case 'hover': params.selector = take('selector'); break;
  case 'type': params.selector = take('selector');
    if (fillItem !== undefined) { if (args.length) die('type --secret takes no text', 2); params.secret = fillItem; break; }
    params.text = take('text'); params.text += args.length ? ' ' + args.splice(0).join(' ') : ''; break;
  case 'press': params.key = take('key'); break;
  case 'scroll': {
    // A bare number is dy, as before; --dx and --dy alone scroll the page, and with a selector go over it.
    const wheelOnly = args.length === 0 && (wheel.dx !== undefined || wheel.dy !== undefined);
    const value = wheelOnly ? '' : take('dy, selector, --dx or --dy');
    if (value.trim() && Number.isFinite(Number(value))) {
      if (wheel.dy !== undefined) die('scroll: dy given twice; a lone number is a distance, so name the tab with --tab', 2);
      params.dy = Number(value);
    } else if (value) params.selector = value;
    Object.assign(params, wheel);
    break;
  }
  case 'select': params.selector = take('selector'); params.value = take('value'); break;
  case 'upload': params.selector = take('selector'); params.path = take('path'); break;
  case 'eval': params.expression = take('expression'); params.expression += args.length ? ' ' + args.splice(0).join(' ') : ''; if (write) params.write = true; break;
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
  case 'remote': {
    // Status, or off. There is no `on`: turning it on is the user's Touch ID in the Gaddi app, never a command.
    const action = args.length ? take('off') : '';
    if (action === 'off') method = 'remote.disable';
    else if (action === '') method = 'remote.status';
    else die(action === 'on' ? 'gaddi remote: turning it on needs Touch ID in the Gaddi app' : 'gaddi remote [off]', 2);
    break;
  }
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
const rpc = <M extends string>(method: M, arguments_: BrokerParams = {}): Promise<BrokerResult<M>> =>
  socketRequest(socket, { id: 1, method, params: { caller: params.caller, ...(params.harness ? { harness: params.harness } : {}), ...arguments_ } }, 60000);
if (cmd !== 'events') {
  try {
    const result = cmd === 'read' ? await (await import('../mcp/reader.ts')).readBrowser(params, rpc) : await rpc(method, params);
    output((cmd === 'screenshot' && !json ? (isRecord(result) ? result.path : undefined)
      : JSON.stringify(json ? { result } : result, null, json ? 0 : 2)) + '\n');
  } catch (error) {
    const failure = error instanceof SocketError && isRecord(error.raw) ? error.raw : { code: 'error', message: errorMessage(error) };
    if (json) output(JSON.stringify({ error: failure }) + '\n'); else diagnostic(`gaddi: ${failure.message}\n`);
    await exit(failure.code === 'held' ? 4 : failure.code === 'denied' ? 5 : 1);
  }
  await exit(0);
}
const conn = net.connect(socket); let buffer = '';
const fail = async (message: string) => { diagnostic(message + '\n'); await exit(1); };
conn.setEncoding('utf8');
conn.on('connect', () => conn.write(JSON.stringify({ id: 1, method, params } satisfies BrokerRequest) + '\n'));
conn.on('error', error => fail(`gaddi: daemon not reachable at ${socket} (${(isRecord(error) ? error.code : undefined) || error.message})`));
conn.on('data', async data => {
  buffer += data; let end;
  while ((end = buffer.indexOf('\n')) >= 0) {
    let message: Record<string, unknown>;
    try { const parsed = parseJSON(buffer.slice(0, end)); if (!isRecord(parsed)) throw new Error('malformed response'); message = parsed; } catch { return await fail('gaddi: malformed response'); }
    buffer = buffer.slice(end + 1);
    if (!message.error) { if (message.event) output(JSON.stringify(message) + '\n'); continue; }
    const failure = isRecord(message.error) ? message.error : {};
    if (json) output(JSON.stringify({ error: message.error }) + '\n'); else diagnostic(`gaddi: ${failure.message}\n`);
    await exit(failure.code === 'held' ? 4 : failure.code === 'denied' ? 5 : 1);
  }
});
conn.on('end', async () => { await exit(0); });
}
await main().catch(async (error: unknown) => { diagnostic(errorMessage(error) + '\n'); await exit(isRecord(error) && typeof error.exitCode === 'number' ? error.exitCode : 1); });
