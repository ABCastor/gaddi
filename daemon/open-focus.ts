import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isRecord } from '../shared/protocol.ts';

const execute = promisify(execFile);
type Application = { asn: string; bundle: string };
type Run = (args: string[]) => Promise<string>;
const run: Run = async args => (await execute('/usr/bin/lsappinfo', args,
  { timeout: 1000, maxBuffer: 64 * 1024, encoding: 'utf8' })).stdout;

// Use Launch Services' process identity, not an app name or a launch/reopen event.
export function macOpenFocus(platform = process.platform, command: Run = run) {
  return {
    async front(): Promise<Application | undefined> {
      if (platform !== 'darwin') return;
      const asn = (await command(['front'])).trim();
      if (!/^ASN:0x[\da-f]+-0x[\da-f]+:?$/i.test(asn)) return;
      const info = await command(['info', '-only', 'bundleid', asn]);
      const bundle = /"?(?:CFBundleIdentifier|bundleid)"?\s*=\s*"([^"]+)"/i.exec(info)?.[1];
      return bundle ? { asn, bundle } : undefined;
    },
    async activate(app: Application) { await command(['setfront', app.asn]); },
  };
}

export async function preserveOpenFocus<T>(open: () => Promise<T>, focus = macOpenFocus()): Promise<T> {
  const before = await focus.front().catch(() => undefined);
  let created = false;
  try {
    const result = await open();
    created = isRecord(result) && result.windowCreated === true;
    return result;
  } catch (error) {
    created = isRecord(error) && error.windowCreated === true;
    throw error;
  } finally {
    if (created && before && before.bundle !== 'com.google.Chrome') {
      // A user who switched to another app during the call keeps that choice.
      const after = await focus.front().catch(() => undefined);
      if (after?.bundle === 'com.google.Chrome' && after.asn !== before.asn)
        await focus.activate(before).catch(() => {});
    }
  }
}
