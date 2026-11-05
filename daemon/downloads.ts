import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GateError } from './approvals.ts';
import type { PolicyCheck } from './policy.ts';

// DOWNLOAD-CAPTURE: capturing a page's own export adds no hold unless the owner's policy sets
// hold.downloads to true. This only decides whether the capture itself asks; the click keeps its
// own deny/hold, and downloadTarget, the size cap, the same-site and top-document checks always apply.
export function checkDownload(policy: {off:boolean; hold:{downloads?:boolean}}): PolicyCheck {
  return !policy.off && policy.hold.downloads === true ? {outcome:'hold',reason:'capture a page-generated download'} : {outcome:'allow'};
}

export const DOWNLOAD_LIMIT = 20 * 1024 * 1024;
const inside = (child: string, root: string) => child.startsWith(root + path.sep);
const refused = (): never => { throw new GateError('denied', 'Download requires a new file in an existing folder under ~/Downloads or the temporary folder; no links, hidden names or overwrites'); };
// DOWNLOAD: a page supplies bytes, never a local path. Confine new files to inert
// download/temp storage; never turn a page export into an application or key-store write.
export function downloadTarget(value: unknown, { home = os.homedir(), temp = [os.tmpdir(), '/tmp'] }: { home?: string; temp?: string[] } = {}): string {
  if (typeof value !== 'string' || !value.trim()) return refused();
  const expanded = value.startsWith('~/') ? path.join(home,value.slice(2)) : value;
  if (!path.isAbsolute(expanded)) return refused();
  const target = path.resolve(expanded), parent = path.dirname(target), name = path.basename(target);
  if (name.startsWith('.') || /[\x00-\x1f]/.test(name)) return refused();
  let realParent: string;
  try { realParent = fs.realpathSync(parent); } catch { return refused(); }
  const roots = [path.join(home,'Downloads'), ...temp].flatMap(root => {
    try { return [{lexical:path.resolve(root),canonical:fs.realpathSync(root)}]; } catch { return []; }
  });
  // Permit macOS's /tmp and /var aliases and the canonical path returned earlier,
  // not a symlink inserted below an allowed root between approval and saving.
  const root = roots.find(root => parent===root.lexical || inside(parent,root.lexical)
    || parent===root.canonical || inside(parent,root.canonical));
  if (!root) return refused();
  const lexical = parent===root.lexical || inside(parent,root.lexical);
  const expected = lexical ? path.join(root.canonical,path.relative(root.lexical,parent)) : parent;
  if (expected!==realParent) return refused();
  const canonical = path.join(realParent,name);
  try { fs.lstatSync(canonical); return refused(); } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
  }
  return canonical;
}
export function saveDownload(target: string, bytes: Buffer): void {
  if (bytes.length > DOWNLOAD_LIMIT) throw new Error('Download exceeds 20 MB');
  // O_EXCL also refuses a final symlink and preserves any file created since approval.
  const fd = fs.openSync(target,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
  try {
    if(fs.realpathSync(target)!==target) throw new Error('Download destination changed before writing');
    fs.writeFileSync(fd,bytes); fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}
