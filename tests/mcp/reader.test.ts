import { hasErrorCode, isRecord, parseJSON } from '../../shared/protocol.ts';
// Extractor contract and scratch cleanup, independent of browser/socket availability.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readHTML, DEFAULT_OMNIREAD } from '../../mcp/reader.ts';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-reader-test-'));
const page = { url: 'https://fixture.example/a?literal=$(not-a-command)', html: '<html><body><article><h1>MCP fixture</h1><p>Local article content is data for the extractor.</p></article></body></html>' };
const txt = (r: Awaited<ReturnType<typeof readHTML>>) => r.content[0].text;
const wrappedJSON = (r: Awaited<ReturnType<typeof readHTML>>) => parseJSON(txt(r).split('\n').slice(2, -1).join('\n'));
try {
  const fallback = await readHTML(page, async () => ({ url: page.url, text: 'fallback fixture' }), path.join(dir, 'missing'));
  assert.match(txt(fallback), /OmniRead unavailable: extractor missing; falling back to page text/);
  assert.match(txt(fallback), /\[untrusted page content from .*\]\nfallback fixture\n\[end of page content\]/);
  console.log('PASS reader-missing-extractor-fallback');

  const bin = path.join(dir, 'extractor with spaces');
  const receipt = path.join(dir, 'receipt.json');
  const envelope = { handle: 'fixture-handle', read_more: { handle: 'fixture-handle' }, result: { content: '# Fixture markdown', outline: { sections: [{ anchor: 'fixture', title: 'Fixture' }] } } };
  const script = `#!${process.execPath}\nconst fs = require('node:fs');\nconst args = process.argv.slice(2);\nconst file = args[2];\nfs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({args, html:fs.readFileSync(file,'utf8'), mode:fs.statSync(file).mode & 0o777, dirMode:fs.statSync(require('node:path').dirname(file)).mode & 0o777}));\nprocess.stdout.write(${JSON.stringify(JSON.stringify(envelope))});\n`;
  await fs.writeFile(bin, script, { mode: 0o700 });
  const extracted = await readHTML(page, () => { throw Error('unexpected fallback'); }, bin);
  assert.deepEqual(wrappedJSON(extracted), envelope);
  const seen = parseJSON(await fs.readFile(receipt, 'utf8'));
  assert.ok(isRecord(seen) && Array.isArray(seen.args)); assert.equal(typeof seen.args[2], 'string');
  assert.deepEqual(seen.args, ['extract', '--html', seen.args[2], '--url', page.url, '--json']);
  assert.equal(seen.html, page.html);
  assert.equal(seen.mode, 0o600); assert.equal(seen.dirMode, 0o700);
  await assert.rejects(fs.stat(path.dirname(seen.args[2])), { code: 'ENOENT' });
  console.log('PASS reader-preserves-markdown-sections-handle-and-literal-argv');
  console.log('PASS reader-private-html-cleaned-after-success');

  await fs.writeFile(bin, script.replace(`process.stdout.write(${JSON.stringify(JSON.stringify(envelope))})`, `process.stdout.write('bad json')`));
  await assert.rejects(readHTML(page, () => { throw Error('unexpected fallback'); }, bin), /OmniRead returned invalid JSON/);
  const broken = parseJSON(await fs.readFile(receipt, 'utf8'));
  assert.ok(isRecord(broken) && Array.isArray(broken.args)); assert.equal(typeof broken.args[2], 'string');
  await assert.rejects(fs.stat(path.dirname(broken.args[2])), { code: 'ENOENT' });
  console.log('PASS reader-invalid-json-errors-and-cleans-html');
  await fs.writeFile(bin, script + '\nprocess.exit(7);\n');
  await assert.rejects(readHTML(page, () => { throw Error('unexpected fallback'); }, bin), /OmniRead extraction failed \(7\)/);
  console.log('PASS reader-extractor-failure-is-not-missing-fallback');

  let installed = process.env.OMNIREAD_BIN || DEFAULT_OMNIREAD;
  if (!installed.includes('/')) {
    for (const entry of (process.env.PATH || '').split(path.delimiter)) {
      const candidate = path.join(entry, installed);
      try { await fs.access(candidate, fs.constants.X_OK); installed = candidate; break; } catch {}
    }
  }
  try {
    await fs.access(installed);
    const real = wrappedJSON(await readHTML(page, () => { throw Error('unexpected fallback'); }, installed));
    assert.ok(isRecord(real) && isRecord(real.result) && isRecord(real.result.outline));
    assert.equal(typeof real.handle, 'string');
    assert.equal(typeof real.result.content, 'string');
    assert.ok(Array.isArray(real.result.outline.sections));
    console.log('PASS reader-installed-omniread-markdown-sections-handle');
  } catch (e) {
    if (!hasErrorCode(e, 'ENOENT')) throw e;
    console.log('SKIP reader-installed-omniread missing; fallback verified');
  }
} finally { await fs.rm(dir, { recursive: true, force: true }); }
