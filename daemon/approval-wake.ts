import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { isRecord } from '../shared/protocol.ts';

export type ApprovalAppLauncher = (command: string, args: string[], options: { stdio: 'ignore' }) => Pick<ChildProcess, 'on' | 'unref'>;

/** Start the approver in the background only for live pending decisions. The app
 * verifies its own snapshot before presenting, so launch races cannot raise stale UI. */
export function wakeApprovalApp(pending: readonly unknown[], options: {
  launch?: ApprovalAppLauncher;
  launcher?: string;
  now?: number;
  log?: (...args: unknown[]) => void;
} = {}): boolean {
  const now = options.now ?? Date.now();
  if (!pending.some(row => isRecord(row) && row.status === 'pending' && typeof row.id === 'string'
    && /^[A-Za-z0-9_-]{1,128}$/.test(row.id) && typeof row.expiresAt === 'string'
    && Date.parse(row.expiresAt) > now)) return false;
  const log = options.log ?? (() => {});
  try {
    const app = (options.launch ?? spawn)(options.launcher ?? process.env.GADDI_APP_LAUNCHER ?? '/usr/bin/open',
      ['-g', '-b', 'com.abcastor.gaddi'], { stdio: 'ignore' });
    app.on('error', error => log('approval app launch failed:', isRecord(error) ? error.code : undefined));
    app.on('exit', code => { if (code !== null && code !== 0) log('approval app launcher exited:', code); });
    app.unref();
    return true;
  } catch (error) {
    log('approval app launch failed:', isRecord(error) ? error.code : undefined);
    return false;
  }
}
