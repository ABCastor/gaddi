// Local unpacked installation preparation. Chrome owns loading; this module never edits
// its profile, executes extension code, launches Chrome, or fetches remote packages.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GateError } from './approvals.ts';

const execute = promisify(execFile);
const MAX_ENTRIES = 5000;
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_DEPTH = 32;
const SECRET_DIRS = [
  '.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker', '.password-store', '.config/gcloud', '.config/gh', '.config/op',
  '.claude', '.codex', 'Library/Keychains', 'Library/Application Support/Gaddi',
  'Library/Group Containers/2BUA8C4S2C.com.1password', 'Library/Containers/com.1password.1password', 'Library/Application Support/1Password',
  'Library/Application Support/Google', 'Library/Application Support/Chromium', 'Library/Application Support/BraveSoftware',
  'Library/Application Support/Microsoft Edge', 'Library/Application Support/Arc', 'Library/Application Support/Firefox',
  'Library/Application Support/Vivaldi', 'Library/Application Support/com.operasoftware.Opera',
  'Library/Safari', 'Library/Cookies', 'Library/Containers/com.apple.Safari', 'Library/Mail', 'Library/Messages',
];
const SECRET_NAME = /^(?:\.env(?:\..*)?|\.(?:netrc|npmrc|pypirc|git-credentials|htpasswd|pgpass)|id_(?:rsa|dsa|ecdsa|ed25519).*)$|\.(?:env|pem|key|p8|p12|pfx|jks|keystore|kdbx|keychain|keychain-db|ovpn)$|credential|(?:^|[^a-z])(?:secrets?|tokens?)(?:[^a-z]|$)|service[-_]?account/i;
const FORBIDDEN_SEGMENT = /^(?:Downloads|\.Trash|\.ssh|\.gnupg|.*\.keychain(?:-db)?)$/i;
const inside = (child: string, parent: string) => {
  const relative = path.relative(parent, child);
  return relative === '' || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
};
function refuse(reason: string): never { throw new GateError('denied', `extension install refused: ${reason} (no approval path)`); }

export interface UnpackedExtension {
  path: string;
  name: string;
  version: string;
  manifestVersion: 3;
  fingerprint: string;
  trusted: boolean;
  requiresApproval: boolean;
  hasStaticRules: boolean;
}
export interface InstallValidationOptions {
  // Test isolation only. Broker callers must never supply these values from a request.
  home?: string;
  trustedRoot?: string;
  quarantine?: (file: string) => Promise<boolean>;
}

async function isQuarantined(file: string) {
  // List names only, never xattr values or extension file contents. Fail closed on a
  // missing checker, access error, timeout, or a platform without the macOS checker.
  try {
    const { stdout } = await execute('/usr/bin/xattr', [file], { timeout: 5000, maxBuffer: 65536 });
    return stdout.split('\n').some(name => ['com.apple.quarantine', 'com.apple.metadata:kMDItemWhereFroms'].includes(name.trim()));
  } catch { refuse('download provenance could not be checked'); }
}

function checkPath(candidate: string, home: string) {
  if (!inside(candidate, home)) refuse('only owner-local folders in the home directory are supported');
  const relative = path.relative(home, candidate).replaceAll(path.sep, '/');
  const lower = relative.toLowerCase();
  if (SECRET_DIRS.some(dir => lower === dir.toLowerCase() || lower.startsWith(dir.toLowerCase() + '/')))
    refuse('keys, credentials, app state, and browser profiles are protected');
  if (relative.split('/').some(segment => FORBIDDEN_SEGMENT.test(segment) || SECRET_NAME.test(segment)))
    refuse('downloaded, trashed, or credential paths are not install sources');
}

function same(a: fs.Stats, b: fs.Stats) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs
    && a.ctimeMs === b.ctimeMs && a.mode === b.mode && a.uid === b.uid;
}

export async function validateUnpackedExtension(requested: unknown,
  { home = os.homedir(), quarantine = isQuarantined, trustedRoot = process.env.GADDI_EXTENSION_TRUST_ROOT }: InstallValidationOptions = {}): Promise<UnpackedExtension> {
  if (typeof requested !== 'string' || !requested.trim() || requested.includes('\0')) refuse('an absolute local folder is required');
  const expanded = requested.startsWith('~/') ? path.join(home, requested.slice(2)) : requested;
  if (!path.isAbsolute(expanded) || /[\r\n]/.test(expanded)) refuse('an absolute local folder is required; URLs and packages are unsupported');
  let homeReal: string, canonical: string;
  try { homeReal = fs.realpathSync(home); canonical = fs.realpathSync(expanded); }
  catch { refuse('the local folder does not exist or cannot be resolved'); }
  checkPath(path.resolve(expanded), homeReal!);
  checkPath(canonical!, homeReal!);
  if (path.resolve(expanded) !== canonical!) refuse('the source folder path must not pass through symbolic links');
  const uid = process.getuid?.();
  if (uid === undefined) refuse('owner identity could not be checked');
  const metadata = new Map<string, fs.Stats>();
  const checked = new Set<string>();
  async function inspect(file: string) {
    checkPath(file, homeReal!);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(file); } catch { refuse('the folder changed during validation'); }
    if (stat!.isSymbolicLink()) refuse('symbolic links within the extension tree are unsupported');
    if (stat!.uid !== uid || (stat!.mode & 0o022) !== 0) refuse('content must be owned by you and not writable by other users');
    if (!stat!.isFile() && !stat!.isDirectory()) refuse('only regular files and folders are allowed');
    if (!checked.has(file)) {
      if (await quarantine(file)) refuse('a folder or file carries a download quarantine marker');
      checked.add(file);
    }
    metadata.set(file, stat!);
    return stat!;
  }
  // Check ancestors as well: quarantine on an enclosing downloaded folder is evidence
  // even when none of its children retain the marker. Do not trust a writable parent.
  for (let parent = canonical!; inside(parent, homeReal!); parent = path.dirname(parent)) {
    await inspect(parent);
    if (parent === homeReal!) break;
  }
  if (!fs.lstatSync(canonical!).isDirectory()) refuse('select an unpacked extension folder, not a package or file');
  const hash = crypto.createHash('sha256');
  let entries = 0, bytes = 0;
  let manifestBytes: Buffer | undefined;
  const directoryEntries = new Map<string, string[]>();
  async function walk(folder: string, depth: number) {
    if (depth > MAX_DEPTH) refuse('extension folders are nested too deeply');
    const names = fs.readdirSync(folder).sort();
    directoryEntries.set(folder, names);
    for (const name of names) {
      if (++entries > MAX_ENTRIES) refuse('extension tree is too large; select its built extension folder');
      const file = path.join(folder, name);
      const stat = await inspect(file);
      const relative = path.relative(canonical!, file).replaceAll(path.sep, '/');
      if (stat.isDirectory()) {
        hash.update(JSON.stringify(['directory', relative]) + '\n');
        await walk(file, depth + 1);
      } else {
        bytes += stat.size;
        if (bytes > MAX_BYTES) refuse('extension files exceed the 64 MB validation limit');
        let fd: number | undefined;
        try {
          fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
          const before = fs.fstatSync(fd);
          if (!same(stat, before) || !before.isFile() || fs.realpathSync(file) !== file) refuse('the extension changed during validation');
          const content = fs.readFileSync(fd);
          if (!same(before, fs.fstatSync(fd)) || content.length !== stat.size) refuse('the extension changed during validation');
          hash.update(JSON.stringify(['file', relative, content.length]) + '\n');
          hash.update(content);
          if (relative === 'manifest.json') manifestBytes = content;
        } catch (error) {
          if (error instanceof GateError) throw error;
          refuse('the extension could not be read safely');
        } finally { if (fd !== undefined) fs.closeSync(fd); }
      }
    }
  }
  await walk(canonical!, 0);
  // Recheck after asynchronous provenance checks and reads. This does not authorize
  // future changes: the broker must validate again when consuming an approval.
  for (const [file, before] of metadata) {
    let after: fs.Stats;
    try { after = fs.lstatSync(file); } catch { refuse('the extension changed during validation'); }
    if (!same(before, after!)) refuse('the extension changed during validation');
  }
  for (const [folder, names] of directoryEntries)
    if (JSON.stringify(fs.readdirSync(folder).sort()) !== JSON.stringify(names)) refuse('the extension changed during validation');
  if (fs.realpathSync(expanded) !== canonical!) refuse('the folder path changed during validation');
  if (!manifestBytes) refuse('manifest.json is required in the selected folder');
  let manifest: unknown;
  try { manifest = JSON.parse(manifestBytes.toString('utf8')); } catch { refuse('manifest.json must contain valid JSON'); }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) refuse('manifest.json must describe an extension');
  const m = manifest as Record<string, unknown>;
  if (m.manifest_version !== 3) refuse('only supported Manifest V3 extensions can be loaded');
  if ('key' in m) refuse('stable extension keys require owner Load unpacked; use reload for an already installed stable-key extension');
  if (typeof m.name !== 'string' || !m.name.trim() || m.name.length > 256 || /[\x00-\x1f\x7f]/.test(m.name)) refuse('manifest name is invalid');
  if (typeof m.version !== 'string' || !/^(?:0|[1-9]\d{0,4})(?:\.(?:0|[1-9]\d{0,4})){0,3}$/.test(m.version)
    || m.version.split('.').some(part => Number(part) > 65535) || m.version.split('.').every(part => Number(part) === 0)) refuse('manifest version is invalid');
  // Trust is owner-configured at startup, never inferred from a personal folder name.
  // Missing, relative or symlinked roots grant no unattended installation authority.
  let trusted = false;
  if (trustedRoot && path.isAbsolute(trustedRoot)) {
    try {
      const root = fs.realpathSync(trustedRoot);
      trusted = root === path.resolve(trustedRoot) && inside(root, homeReal!)
        && canonical! !== root && inside(canonical!, root);
    } catch { /* An unavailable trust root keeps installation held. */ }
  }
  const rules = m.declarative_net_request;
  const resources = rules && typeof rules === 'object' && !Array.isArray(rules)
    ? (rules as Record<string, unknown>).rule_resources : undefined;
  const hasStaticRules = Array.isArray(resources) && resources.length > 0;
  return { path: canonical!, name: m.name, version: m.version, manifestVersion: 3, fingerprint: hash.digest('hex'), trusted, requiresApproval: !trusted, hasStaticRules };
}

export function needsUnpackedInstall(extension: UnpackedExtension) {
  return {
    status: 'needs_you' as const,
    installed: false,
    ...extension,
    reason: 'Chrome requires its Load unpacked picker. Gaddi has validated this local folder but has not installed it.',
    steps: [
      'In your existing Chrome, open chrome://extensions.',
      'Enable Developer mode, then click Load unpacked.',
      `In the folder picker press Command+Shift+G, paste ${extension.path}, press Return, then Select.`,
      `Check that ${extension.name} (${extension.version}) appears enabled without errors, then run browser_extensions list to verify it.`,
    ],
  };
}

type InstallSocket = Pick<WebSocket, 'addEventListener' | 'removeEventListener' | 'send' | 'close' | 'readyState'>;
export interface UnpackedInstallOptions extends InstallValidationOptions {
  // Internal test seams only. The public tool accepts neither endpoints nor methods.
  enabled?: boolean;
  timeoutMs?: number;
  connect?: (endpoint: string) => InstallSocket;
  stateRoot?: string;
}

interface LoadedFolder { path: string; loadedPath: string; sourcePath: string; snapshot: boolean; validatedSourceFingerprint: string; contentFingerprint?: string }
type InstalledExtension = LoadedFolder & { status: 'installed'; installed: true; id: string; name: string; version: string };

function privateDirectory(folder: string) {
  const uid = process.getuid?.();
  const stat = fs.lstatSync(folder);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o077) !== 0
    || fs.realpathSync(folder) !== folder) refuse('the private extension snapshot directory is untrusted');
}

function snapshotFingerprint(folder: string, freeze = false) {
  const hash = crypto.createHash('sha256');
  let entries = 0, bytes = 0;
  function walk(current: string, depth: number) {
    if (depth > MAX_DEPTH) refuse('snapshot folders are nested too deeply');
    privateDirectory(current);
    for (const name of fs.readdirSync(current).sort()) {
      if (++entries > MAX_ENTRIES) refuse('snapshot tree exceeds validation limits');
      const file = path.join(current, name), relative = path.relative(folder, file).replaceAll(path.sep, '/');
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) refuse('the extension snapshot contains untrusted content');
      if (stat.isDirectory()) {
        hash.update(JSON.stringify(['directory', relative]) + '\n'); walk(file, depth + 1);
      } else {
        if (!stat.isFile() || (bytes += stat.size) > MAX_BYTES) refuse('snapshot files exceed validation limits');
        let fd: number | undefined;
        try {
          fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
          const content = fs.readFileSync(fd);
          if (!same(stat, fs.fstatSync(fd)) || content.length !== stat.size) refuse('the extension snapshot changed while checked');
          hash.update(JSON.stringify(['file', relative, content.length]) + '\n'); hash.update(content);
        } finally { if (fd !== undefined) fs.closeSync(fd); }
        if (freeze) fs.chmodSync(file, 0o400);
        else if ((stat.mode & 0o777) !== 0o400) refuse('the retained extension snapshot must be read-only');
      }
    }
    if (freeze) fs.chmodSync(current, 0o500);
    else if ((fs.lstatSync(current).mode & 0o777) !== 0o500) refuse('the retained extension snapshot must be read-only');
  }
  walk(folder, 0);
  return hash.digest('hex');
}

function prepareLoadedFolder(extension: UnpackedExtension, options: UnpackedInstallOptions): LoadedFolder {
  const base = { sourcePath: extension.path, validatedSourceFingerprint: extension.fingerprint };
  // Owner repositories deliberately load their live development tree. They are
  // unheld and therefore carry no claim of immutable approved code bytes.
  if (!extension.requiresApproval) return { ...base, path: extension.path, loadedPath: extension.path, snapshot: false };
  const home = options.home ?? os.homedir();
  const stateRoot = path.resolve(options.stateRoot ?? process.env.GADDI_HOME ?? path.join(home, 'Library/Application Support/Gaddi'));
  const homeReal = fs.realpathSync(home);
  if (!inside(stateRoot, homeReal)) refuse('extension snapshots must remain in owner-local Gaddi state');
  for (let folder = stateRoot; inside(folder, homeReal); folder = path.dirname(folder)) {
    if (fs.existsSync(folder)) {
      const stat = fs.lstatSync(folder);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0)
        refuse('extension snapshot state has an untrusted parent');
    }
    if (folder === homeReal) break;
  }
  // No profile edits. These retained folders belong exclusively to Gaddi, since
  // Chrome continues to read an unpacked extension from its loaded directory.
  fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  // Existing Gaddi state may be 0755 from registration. The private cache below
  // needs 0700; the app's existing state root only needs to exclude other writers.
  const stateStat = fs.lstatSync(stateRoot);
  if (!stateStat.isDirectory() || stateStat.isSymbolicLink() || stateStat.uid !== process.getuid?.()
    || (stateStat.mode & 0o022) !== 0 || fs.realpathSync(stateRoot) !== stateRoot)
    refuse('the Gaddi extension snapshot state directory is untrusted');
  const cache = path.join(stateRoot, 'extension-installs');
  fs.mkdirSync(cache, { mode: 0o700, recursive: true }); privateDirectory(cache);
  const target = path.join(cache, extension.fingerprint);
  if (fs.existsSync(target)) {
    if (snapshotFingerprint(target) !== extension.fingerprint) refuse('retained extension snapshot does not match approved code');
    return { ...base, path: target, loadedPath: target, snapshot: true, contentFingerprint: extension.fingerprint };
  }
  const temporary = fs.mkdtempSync(path.join(cache, '.building-'));
  fs.chmodSync(temporary, 0o700);
  let copiedEntries = 0, copiedBytes = 0;
  function copy(source: string, destination: string, depth: number) {
    if (depth > MAX_DEPTH) refuse('extension folders are nested too deeply');
    const sourceStat = fs.lstatSync(source);
    if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink() || fs.realpathSync(source) !== source) refuse('source changed during snapshot');
    for (const name of fs.readdirSync(source).sort()) {
      if (++copiedEntries > MAX_ENTRIES) refuse('source changed beyond snapshot validation limits');
      const from = path.join(source, name), to = path.join(destination, name), stat = fs.lstatSync(from);
      checkPath(from, homeReal);
      if (stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0) refuse('source changed during snapshot');
      if (stat.isDirectory()) { fs.mkdirSync(to, { mode: 0o700 }); copy(from, to, depth + 1); }
      else {
        if (!stat.isFile() || (copiedBytes += stat.size) > MAX_BYTES) refuse('source changed during snapshot');
        let fd: number | undefined;
        try {
          fd = fs.openSync(from, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
          const content = fs.readFileSync(fd);
          if (!same(stat, fs.fstatSync(fd)) || content.length !== stat.size || fs.realpathSync(from) !== from) refuse('source changed during snapshot');
          fs.writeFileSync(to, content, { flag: 'wx', mode: 0o600 });
        } finally { if (fd !== undefined) fs.closeSync(fd); }
      }
    }
  }
  let promoted = false;
  try {
    copy(extension.path, temporary, 0);
    if (snapshotFingerprint(temporary, true) !== extension.fingerprint) throw new GateError('approval-invalid', 'extension changed while its approved snapshot was prepared; request installation again');
    fs.renameSync(temporary, target); promoted = true;
    if (snapshotFingerprint(target) !== extension.fingerprint) refuse('extension snapshot did not retain its approved bytes');
    return { ...base, path: target, loadedPath: target, snapshot: true, contentFingerprint: extension.fingerprint };
  } finally {
    // Only our unpromoted build scratch is removed. Retained Chrome-loaded snapshots
    // are never overwritten, removed, or evicted by this installation path.
    if (!promoted) {
      function writable(folder: string) {
        fs.chmodSync(folder, 0o700);
        for (const entry of fs.readdirSync(folder, { withFileTypes: true })) if (entry.isDirectory()) writable(path.join(folder, entry.name));
      }
      writable(temporary); fs.rmSync(temporary, { recursive: true, force: true });
    }
  }
}

function consentEndpoint(home: string) {
  const homeReal = fs.realpathSync(home);
  const profile = path.join(homeReal, 'Library', 'Application Support', 'Google', 'Chrome');
  const file = path.join(profile, 'DevToolsActivePort');
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error('owner identity unavailable');
  for (let current = file; inside(current, homeReal); current = path.dirname(current)) {
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o022) !== 0
      || current !== file && !stat.isDirectory()) throw new Error('untrusted Chrome endpoint file');
    if (current === homeReal) break;
  }
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size > 1024 || before.uid !== uid || (before.mode & 0o022) !== 0
      || !same(before, fs.lstatSync(file)) || fs.realpathSync(file) !== file) throw new Error('untrusted Chrome endpoint file');
    const text = fs.readFileSync(fd, 'utf8');
    if (!same(before, fs.fstatSync(fd))) throw new Error('Chrome endpoint changed');
    const lines = text.trim().split('\n').map(line => line.trim());
    if (lines.length !== 2 || !/^[1-9]\d{0,4}$/.test(lines[0]!) || Number(lines[0]) > 65535
      || !/^\/devtools\/browser(?:\/[a-f0-9-]{36})?$/.test(lines[1]!)) throw new Error('invalid Chrome endpoint');
    // Chrome154's consent server accepts this fixed path, showing an owner dialog.
    // Never use the UUID: doing so could connect to the older flag-based server and
    // bypass Chrome's per-connection approval. Never accept a caller-provided URL.
    return `ws://127.0.0.1:${lines[0]}/devtools/browser`;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function sameExtension(current: UnpackedExtension, expected: UnpackedExtension) {
  return current.path === expected.path && current.fingerprint === expected.fingerprint
    && current.name === expected.name && current.version === expected.version && current.trusted === expected.trusted
    && current.hasStaticRules === expected.hasStaticRules;
}

// Call only after the broker's policy/approval gate. Owner setup is opt-in through
// GADDI_EXTENSION_INSTALL=1 plus chrome://inspect/#remote-debugging. The transport
// remains private to this fixed command and closes immediately after its response.
export async function installUnpackedExtension(extension: UnpackedExtension, options: UnpackedInstallOptions = {}) {
  const { home = os.homedir(), enabled = process.env.GADDI_EXTENSION_INSTALL === '1',
    timeoutMs = 45000, connect = (endpoint: string) => new WebSocket(endpoint) } = options;
  let loaded: LoadedFolder | undefined;
  const fallback = (reason: string, uncertain = false) => ({
    ...needsUnpackedInstall(loaded ? { ...extension, path: loaded.path } : extension),
    ...(loaded ?? { sourcePath: extension.path, snapshot: false, validatedSourceFingerprint: extension.fingerprint }),
    installed: uncertain ? null : false,
    reason,
    ...(uncertain ? { steps: ['Run browser_extensions list and check chrome://extensions before retrying: Chrome may already have loaded this extension.'] } : {}),
  });
  if (extension.requiresApproval && extension.hasStaticRules)
    return fallback('This extension declares static network rules. Chrome writes generated rules metadata inside its extension directory, which is incompatible with an approved read-only snapshot. The owner must use Load unpacked for this source.');
  if (!enabled) return fallback('Automatic local installation is off. Use Chrome Load unpacked, or the owner can enable the consent-based installer in Gaddi configuration.');
  let endpoint: string;
  try { endpoint = consentEndpoint(home); }
  catch { return fallback('Chrome consent-based debugging is unavailable or its endpoint file is untrusted. In Chrome 149+, the owner can enable chrome://inspect/#remote-debugging; otherwise use Load unpacked.'); }
  const before = await validateUnpackedExtension(extension.path, options);
  if (!sameExtension(before, extension)) throw new GateError('approval-invalid', 'extension folder changed; request installation again');
  let socket: InstallSocket;
  try { socket = connect(endpoint); }
  catch { return fallback('Chrome debugging connection could not be opened. Use Load unpacked, or check the owner-enabled Chrome debugging setting.'); }
  return new Promise<ReturnType<typeof fallback> | InstalledExtension>((resolve, reject) => {
    let settled = false, sent = false;
    const timer = setTimeout(() => finish(fallback(sent
      ? 'Chrome did not confirm installation before timeout. Check the extension list before retrying.'
      : 'Chrome connection approval was not completed before timeout. Approve the Chrome connection dialog or use Load unpacked.', sent)), timeoutMs);
    function cleanup() {
      clearTimeout(timer);
      socket.removeEventListener('open', opened);
      socket.removeEventListener('message', message);
      socket.removeEventListener('error', failed);
      socket.removeEventListener('close', failed);
      try { socket.close(); } catch { /* A failed handshake may already be closed. */ }
    }
    function finish(result: ReturnType<typeof fallback> | InstalledExtension) {
      if (settled) return;
      settled = true; cleanup(); resolve(result);
    }
    function failed() {
      finish(fallback(sent ? 'Chrome disconnected without confirming installation. Check the extension list before retrying.'
        : 'Chrome connection was unavailable or denied. Approve its connection dialog or use Load unpacked.', sent));
    }
    async function opened() {
      try {
        // The owner may take time to approve Chrome's dialog. Bind the eventual load
        // to the exact approved bytes, checking again after that wait, before send.
        const current = await validateUnpackedExtension(extension.path, options);
        if (!sameExtension(current, extension)) throw new GateError('approval-invalid', 'extension folder changed while Chrome approval was pending; request installation again');
        if (settled) return;
        if (consentEndpoint(home) !== endpoint) throw new Error('Chrome endpoint changed');
        loaded = prepareLoadedFolder(current, options);
        sent = true;
        socket.send(JSON.stringify({ id: 1, method: 'Extensions.loadUnpacked', params: { path: loaded.path } }));
      } catch (error) {
        if (settled) return;
        if (error instanceof GateError) { settled = true; cleanup(); reject(error); }
        else finish(fallback('Chrome endpoint changed or the request could not be sent. Check Chrome setup and retry.', sent));
      }
    }
    function message(event: Event) {
      if (settled || !sent) return;
      const data = (event as MessageEvent).data;
      if (typeof data !== 'string' || data.length > 65536) { finish(fallback('Chrome returned an invalid installation confirmation. Check the extension list before retrying.', true)); return; }
      let reply: unknown;
      try { reply = JSON.parse(data); } catch { finish(fallback('Chrome returned an invalid installation confirmation. Check the extension list before retrying.', true)); return; }
      if (!reply || typeof reply !== 'object') return;
      const r = reply as Record<string, unknown>;
      if (r.id !== 1) return; // Ignore unrelated Chrome events.
      if (r.error) { finish(fallback('Chrome refused to load this folder. Check chrome://extensions for its error, or use Load unpacked.')); return; }
      const result = r.result as Record<string, unknown> | undefined;
      if (!result || typeof result.id !== 'string' || !/^[a-p]{32}$/.test(result.id)) {
        finish(fallback('Chrome returned no valid extension identity. Check the extension list before retrying.', true)); return;
      }
      finish({ status: 'installed', installed: true, id: result.id, ...loaded!, name: extension.name, version: extension.version });
    }
    socket.addEventListener('open', opened);
    socket.addEventListener('message', message);
    socket.addEventListener('error', failed);
    socket.addEventListener('close', failed);
  });
}
