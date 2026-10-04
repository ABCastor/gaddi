import type { BrowserContext } from 'playwright-core';
import type { FakeDaemon } from './fake-daemon.ts';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { callsFor } from './extension-types.ts';
import { waitFor } from './fake-daemon.ts';

type Received = { source: string; name: string; type: string; size: number; lastModified: number; sha256: string };
const sha = (bytes: Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');

// The extension side of browser_upload: pieces from the broker, then one attach.
export async function uploadChecks({ context, daemon, url, pass }: {
  context: BrowserContext; daemon: FakeDaemon; url: string; pass: (label: string) => void;
}) {
  const call = callsFor(daemon);
  const send = async (tab: number, selector: string, name: string, type: string, bytes: Buffer,
    { corrupt = false, drop = -1, version }: { corrupt?: boolean; drop?: number; version?: string } = {}) => {
    const id = crypto.randomUUID(), piece = 510 * 1024, chunks = Math.max(1, Math.ceil(bytes.length / piece));
    for (let index = 0; index < chunks; index++) {
      if (index === drop) continue;
      const stored = await daemon.request('chrome.uploadChunk', { upload: { id, index, data: bytes.subarray(index * piece, (index + 1) * piece).toString('base64') } });
      assert.equal(stored.error, undefined, JSON.stringify(stored));
    }
    return daemon.request('chrome.upload', { tab, selector, ...(version ? { version } : {}),
      upload: { id, chunks, name, type, lastModified: 1700000000000, size: bytes.length, sha256: corrupt ? sha(Buffer.from('other')) : sha(bytes) } });
  };

  const tab = (await call('chrome.open', { url: `${url}upload.html` })).id;
  const page = await waitFor(() => context.pages().find(page => page.url() === `${url}upload.html`), 'upload fixture');
  const received = () => page.evaluate(() => (window as unknown as { received: Received[] }).received);
  const arrived = async (count: number) => { await waitFor(async () => (await received()).length >= count, 'page read the file'); return (await received())[count - 1]; };

  const logo = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), crypto.randomBytes(1300 * 1024)]);
  const first = await send(tab, '#logo', 'castor-logo.png', 'image/png', logo);
  assert.equal(first.error, undefined, JSON.stringify(first));
  assert.equal((first.result as { via?: string }).via, 'input');
  assert.deepEqual(await arrived(1), { source: 'logo', name: 'castor-logo.png', type: 'image/png', size: logo.length, lastModified: 1700000000000, sha256: sha(logo) },
    'ASSERT_UPLOAD_INPUT: a 1.3 MB file in three pieces reaches the file field byte for byte');
  pass('upload attaches a 1.3 MB file sent in three pieces to a file field; the page reads identical bytes');

  const avatar = crypto.randomBytes(40 * 1024);
  assert.equal((await send(tab, '#avatar-button', 'avatar.png', 'image/png', avatar)).error, undefined);
  assert.equal((await arrived(2)).source, 'avatar', 'ASSERT_UPLOAD_HIDDEN: the label reaches its hidden file field');
  assert.equal((await arrived(2)).sha256, sha(avatar));
  const notes = Buffer.from('Meeting notes for the upload fixture\n');
  const dropped = await send(tab, '#zone', 'notes.txt', 'text/plain', notes);
  assert.equal((dropped.result as { via?: string }).via, 'drop', `ASSERT_UPLOAD_DROP: ${JSON.stringify(dropped)}`);
  assert.deepEqual(await arrived(3), { source: 'zone', name: 'notes.txt', type: 'text/plain', size: notes.length, lastModified: 1700000000000, sha256: sha(notes) },
    'ASSERT_UPLOAD_DROP: a drop zone with no file field receives the file');
  pass('a label hiding its file field and a pure drop zone both receive the file');

  for (const [label, reply, pattern] of [
    ['accept', await send(tab, '#logo', 'notes.txt', 'text/plain', notes), /accepts only image\/png,\.svg/],
    ['disabled', await send(tab, '#off', 'notes.txt', 'text/plain', notes), /disabled/],
    ['text field', await send(tab, '#name', 'notes.txt', 'text/plain', notes), /not a file field/],
    ['corrupt', await send(tab, '#logo', 'castor-logo.png', 'image/png', logo, { corrupt: true }), /did not arrive intact/],
    ['missing piece', await send(tab, '#logo', 'castor-logo.png', 'image/png', logo, { drop: 1 }), /incomplete/],
  ] as const) assert.match(reply.error?.message || '', pattern, `ASSERT_UPLOAD_REFUSED: ${label} ${JSON.stringify(reply)}`);
  const stale = await send(tab, '#logo', 'castor-logo.png', 'image/png', logo, { version: 'v1-0' });
  assert.equal(stale.error?.code, 'stale', 'ASSERT_UPLOAD_REFUSED: the page version is checked');
  assert.equal((await received()).length, 3, 'ASSERT_UPLOAD_REFUSED: nothing reached the page');
  await call('chrome.close', { tabs: [tab] });
  pass('wrong type, disabled field, corrupted or incomplete data and a stale page are refused before the page sees a file');

  // No debugger involved: works while a password manager's frame is open on the page.
  const foreign = (await call('chrome.open', { url: `${url}foreign.html#upload` })).id;
  const foreignPage = await waitFor(() => context.pages().find(page => page.url() === `${url}foreign.html#upload`), 'foreign upload fixture');
  await foreignPage.evaluate(() => { const el = document.querySelector<HTMLInputElement>('#email')!; el.focus(); el.dispatchEvent(new FocusEvent('focusin', { bubbles: true })); });
  await waitFor(() => foreignPage.frames().some(frame => frame.url().startsWith('chrome-extension://')), 'foreign menu frame committed', 8000);
  assert.equal((await send(foreign, '#attachment', 'avatar.png', 'image/png', avatar)).error, undefined, 'ASSERT_UPLOAD_FOREIGN');
  assert.equal(await foreignPage.evaluate(() => document.querySelector<HTMLInputElement>('#attachment')!.files?.[0]?.name), 'avatar.png', 'ASSERT_UPLOAD_FOREIGN');
  await call('chrome.close', { tabs: [foreign] });
  pass('upload works while another extension\'s frame blocks the debugger');
}
