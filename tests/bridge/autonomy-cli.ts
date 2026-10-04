import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import os from 'node:os';
import path from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { EventEmitter } from 'node:events';
import { isRecord, parseJSON, errorMessage, waitParams } from '../../shared/protocol.ts';
import type { BrokerRequest } from '../../shared/protocol.ts';

// Exercise production CLI argument parsing and outgoing JSON without opening
// an OS socket (the sandbox prohibits listening on a Unix socket).
const socketSource = stripTypeScriptTypes(fs.readFileSync(new URL('../../shared/socket.ts', import.meta.url), 'utf8')).replace(/^import .*;$/gm, '').replace(/^export /gm, '');
const source = stripTypeScriptTypes(fs.readFileSync(new URL('../../cli/gaddi.ts', import.meta.url), 'utf8')).replace(/^#!.*$/m, '').replace(/^import .*;$/gm, '');
async function run(args: string[]) {
  let request: BrokerRequest | undefined, stderr = '';
  let complete!: (code: number) => void;
  const finished = new Promise<number>(resolve => { complete = resolve; });
  const stream = (error = false) => ({ write(text: string, callback?: () => void) { if (error) stderr += text; callback?.(); } });
  const net = { connect() {
    const socket = Object.assign(new EventEmitter(), { setEncoding() {}, destroy() {},
      write(value: string) { request = JSON.parse(value) as BrokerRequest; queueMicrotask(() => socket.emit('data', JSON.stringify({ id: request!.id, result: { typed: true } }) + '\n')); },
    });
    queueMicrotask(() => socket.emit('connect')); return socket;
  } };
  const processDouble = { argv: ['node', 'gaddi', ...args], env: {}, stdout: stream(), stderr: stream(true), exit: complete };
  await vm.runInNewContext(`(async () => { ${socketSource}\n${source}\n })()`, { process: processDouble, net, os, path, isRecord, parseJSON, errorMessage, waitParams, setTimeout, clearTimeout, Buffer });
  const code = await finished;
  return { request, code, stderr };
}
const appended = await run(['type', '7', '@abcdef:1', ' wake up', '--mode', 'append']);
assert.equal(appended.code, 0, 'ASSERT_APPEND_CLI');
assert.equal(appended.request?.method, 'type', 'ASSERT_APPEND_CLI');
assert.deepEqual(appended.request?.params, { caller: 'cli', tab: 7, selector: '@abcdef:1', text: ' wake up', mode: 'append' }, 'ASSERT_APPEND_CLI');
const replaced = await run(['--mode', 'replace', 'type', '7', '#field', 'value']);
assert.equal(replaced.request?.params?.mode, 'replace', 'ASSERT_APPEND_CLI');
const defaultMode = await run(['type', '7', '#field', 'value']);
assert.equal(defaultMode.request?.params?.mode, undefined, 'ASSERT_APPEND_CLI');
for (const args of [['type', '7', '#field', 'text', '--mode', 'bad'], ['look', '--mode', 'append'], ['type', '--mode']]) {
  const invalid = await run(args);
  assert.equal(invalid.code, 2, 'ASSERT_APPEND_CLI'); assert.equal(invalid.request, undefined, 'ASSERT_APPEND_CLI');
}
console.log('PASS ASSERT_APPEND_CLI');
console.log('== autonomy CLI: 6 cases passed, 0 failed');
