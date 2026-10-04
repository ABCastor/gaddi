import type { BrokerParams, BrokerRPC, HTMLPage, TextPage } from '../shared/protocol.ts';
import { isRecord } from '../shared/protocol.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pageResult } from './map.ts';

const execute = promisify(execFile);
// OMNIREAD_BIN selects an explicit executable; otherwise resolve omniread on PATH.
export const DEFAULT_OMNIREAD = 'omniread';

export async function readHTML(page: Pick<HTMLPage, 'url' | 'html' | 'truncated'>, fallback: () => Promise<Pick<TextPage, 'url' | 'text'>>, bin = process.env.OMNIREAD_BIN || DEFAULT_OMNIREAD) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gaddi-read-'));
  try {
    const file = path.join(dir, 'page.html');
    // Invariant: logged-in HTML stays in an user-only temporary directory; page data
    // is passed as argv/file bytes, never interpolated into a shell command.
    await fs.writeFile(file, page.html, { mode: 0o600 });
    let stdout;
    try {
      ({ stdout } = await execute(bin, ['extract', '--html', file, '--url', page.url, '--json'], {
        timeout: 60000, maxBuffer: 32 * 1024 * 1024,
      }));
    } catch (e) {
      const code = isRecord(e) ? e.code : undefined;
      if (code !== 'ENOENT') throw new Error(`OmniRead extraction failed (${code || 'execution error'}); no extracted result available`);
      const r = await fallback();
      return pageResult(r.url, r.text, 'OmniRead unavailable: extractor missing; falling back to page text (no section index or read_more handle).');
    }
    // Preserve the extractor's complete envelope, including markdown, section index,
    // completeness and handle, inside the same untrusted boundary as page text.
    let result: unknown;
    try { result = JSON.parse(stdout); }
    catch { throw new Error('OmniRead returned invalid JSON'); }
    return pageResult(page.url, JSON.stringify(result, null, 2), [
      page.truncated ? 'Source HTML was truncated by the daemon.' : '',
    ].filter(Boolean).join('\n'));
  } finally {
    await fs.rm(dir, { recursive: true, force: true }); // Only this call's scratch HTML.
  }
}

// Shared by stdio MCP and the CLI; rpc retains structured broker errors such as HELD.
export async function readBrowser(args: BrokerParams, rpc: BrokerRPC) {
  if (args.tab !== undefined && args.url !== undefined) throw new Error('Provide tab or url, not both');
  if (args.approval !== undefined && args.url === undefined) throw new Error('approval requires a URL retry');
  let target = args.tab, temporary: number | undefined;
  try {
    if (args.url !== undefined) {
      const opened = await rpc('open', { url: args.url, foreground: false, ...(args.approval ? { approval: args.approval } : {}) });
      // Cleanup targets this call's temporary tab. A held open creates none.
      if (!Number.isSafeInteger(opened?.id) || (opened.id ?? -1) < 0) throw new Error('open returned no usable tab ID');
      target = temporary = opened.id;
    }
    const page = await rpc('html', target === undefined ? {} : { tab: target });
    if (!Number.isSafeInteger(page?.tab) || page.tab < 0) throw new Error('html returned no usable tab ID');
    // Pin fallback to the HTML's tab even if the human changes the active tab during extraction.
    const result = await readHTML(page, () => rpc('look', { tab: page.tab }));
    const safe = await rpc('output.redact', { text: result.content[0].text });
    if (typeof safe !== 'string') throw new Error('broker returned invalid redacted text');
    result.content[0].text = safe;
    return result;
  } finally {
    if (temporary !== undefined) {
      const cleanup = await rpc('close', { tabs: [temporary] });
      if (!cleanup.closed?.includes(temporary)) throw new Error(`Temporary tab ${temporary} cleanup failed: ${
        cleanup.failed?.find(item => item.tab === temporary)?.reason || 'close did not confirm removal'}`);
    }
  }
}
