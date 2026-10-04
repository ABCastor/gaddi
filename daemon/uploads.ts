// daemon/uploads.ts — which local file an agent may attach to a page, read once by the broker.
// Invariant: the extension and the page never name a path. The broker resolves the real path,
// refuses secret stores, and reads the bytes through the same descriptor it checked.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { GateError } from './approvals.ts';

const UPLOAD_LIMIT = 20 * 1024 * 1024;
// Chrome caps a native message to the extension at 1 MiB; base64 adds a third. A multiple
// of 3 bytes, so the extension can join the base64 pieces as they are.
export const UPLOAD_CHUNK = 510 * 1024;
export interface UploadFile { name: string; type: string; lastModified: number; bytes: Buffer; sha256: string }

// Relative to the home folder, compared case-insensitively (APFS default).
const PROTECTED_DIRS = [
  '.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker', '.password-store', '.config/gcloud', '.config/gh', '.config/op',
  '.claude', '.codex', 'Library/Keychains', 'Library/Application Support/Gaddi',
  // 1Password
  'Library/Group Containers/2BUA8C4S2C.com.1password', 'Library/Containers/com.1password.1password', 'Library/Application Support/1Password',
  // Browser profiles: cookies, saved passwords, sessions
  'Library/Application Support/Google/Chrome', 'Library/Application Support/Google/Chrome Beta', 'Library/Application Support/Google/Chrome Canary',
  'Library/Application Support/Chromium', 'Library/Application Support/BraveSoftware', 'Library/Application Support/Microsoft Edge',
  'Library/Application Support/Arc', 'Library/Application Support/Firefox', 'Library/Application Support/Vivaldi', 'Library/Application Support/com.operasoftware.Opera',
  'Library/Safari', 'Library/Cookies', 'Library/Containers/com.apple.Safari', 'Library/Mail', 'Library/Messages',
];
const PROTECTED_SEGMENTS = /^(?:\.ssh|\.gnupg|.*\.keychain(?:-db)?)$/i;
const PROTECTED_NAMES = [
  /^\.env(?:\..*)?$/i, /\.env$/i, /^\.(?:netrc|npmrc|pypirc|git-credentials|htpasswd|pgpass)$/i, /^id_(?:rsa|dsa|ecdsa|ed25519)/i,
  /\.(?:pem|key|p8|p12|pfx|jks|keystore|kdbx|keychain|keychain-db|ovpn)$/i,
  /credential/i, /(?:^|[^a-z])(?:secrets?|tokens?)(?:[^a-z]|$)/i, /service[-_]?account/i,
];
const TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon',
  heic: 'image/heic', avif: 'image/avif', bmp: 'image/bmp', pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv',
  json: 'application/json', xml: 'application/xml', zip: 'application/zip', mp4: 'video/mp4', mov: 'video/quicktime', mp3: 'audio/mpeg',
  wav: 'audio/wav', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
const refuse = (reason: string): never => { throw new GateError('denied', `upload refused: ${reason} (no approval path)`); };
const inside = (child: string, parent: string) => {
  const relative = path.relative(parent.toLowerCase(), child.toLowerCase());
  return relative === '' || !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
};
function real(value: string) { try { return fs.realpathSync(value); } catch { return path.resolve(value); } }

export function readUpload(requested: unknown, { home = os.homedir(), temp = [os.tmpdir(), '/tmp'] }: { home?: string; temp?: string[] } = {}): UploadFile {
  if (typeof requested !== 'string' || !requested.trim()) throw new Error('path required');
  const expanded = requested.startsWith('~/') ? path.join(home, requested.slice(2)) : requested;
  if (!path.isAbsolute(expanded)) refuse('give an absolute path or one starting with ~/');
  let target: string;
  try { target = fs.realpathSync(expanded); } catch { throw new Error(`upload: no such file: ${path.basename(expanded)}`); }
  const homeReal = real(home);
  // Invariant: only the person's own files, resolved through every link, and never a secret store.
  if (!inside(target, homeReal) && !temp.map(real).some(root => inside(target, root))) refuse('only files in your home folder or a temporary folder');
  for (const candidate of new Set([path.resolve(expanded), target])) {
    const relative = inside(candidate, homeReal) ? path.relative(homeReal, candidate) : candidate;
    const lower = relative.toLowerCase();
    const dir = PROTECTED_DIRS.find(dir => lower === dir.toLowerCase() || lower.startsWith(dir.toLowerCase() + path.sep));
    if (dir) refuse(`${dir} holds keys, passwords or browser data`);
    if (candidate.split(path.sep).some(segment => PROTECTED_SEGMENTS.test(segment))) refuse('that folder holds keys or passwords');
    const name = path.basename(candidate);
    if (PROTECTED_NAMES.some(pattern => pattern.test(name))) refuse(`${name} looks like a key, token or credentials file`);
  }
  let fd: number | undefined;
  try {
    // Open what was checked: no final symlink, then confirm the path still resolves there.
    try { fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); } catch { refuse('the file changed while it was checked'); }
    const stat = fs.fstatSync(fd!);
    if (stat.isDirectory()) refuse('a folder cannot be uploaded; choose a file');
    if (!stat.isFile()) refuse('only regular files');
    if (stat.size > UPLOAD_LIMIT) refuse(`files over ${UPLOAD_LIMIT / 1024 / 1024} MB`);
    if (real(expanded) !== target) refuse('the file changed while it was checked');
    const bytes = Buffer.alloc(stat.size);
    for (let offset = 0; offset < stat.size;) {
      const read = fs.readSync(fd!, bytes, offset, stat.size - offset, offset);
      if (!read) refuse('the file changed while it was read');
      offset += read;
    }
    const name = path.basename(expanded);
    return { name, type: TYPES[path.extname(name).slice(1).toLowerCase()] || 'application/octet-stream',
      lastModified: Math.round(stat.mtimeMs), bytes, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
