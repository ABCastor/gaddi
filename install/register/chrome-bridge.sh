#!/bin/bash
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DRY=0
REMOVE=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --remove) REMOVE=1 ;;
    *) echo "Usage: $0 [--dry-run] [--remove]" >&2; exit 2 ;;
  esac
done
node --input-type=module - "$REPO" "$DRY" "$REMOVE" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
const [repo, dry, remove] = process.argv.slice(2);
const dir = path.join(os.homedir(), 'Library/Application Support/Google/Chrome/NativeMessagingHosts');
const filename = path.join(dir, 'com.abcastor.gaddi.bridge.json');
const extension = JSON.parse(fs.readFileSync(path.join(repo, 'extension/manifest.json'), 'utf8'));
const id = [...crypto.createHash('sha256').update(Buffer.from(extension.key, 'base64')).digest('hex').slice(0, 32)]
  .map(c => String.fromCharCode(97 + parseInt(c, 16))).join('');
const manifest = JSON.parse(fs.readFileSync(path.join(repo, 'bridge/com.abcastor.gaddi.bridge.json'), 'utf8'));
const host = path.join(repo, 'bridge/host.sh');
if (manifest.allowed_origins[0] !== `chrome-extension://${id}/`) throw new Error('Extension key and native host origin disagree');
manifest.path = host;
const contents = JSON.stringify(manifest, null, 2) + '\n';
if (remove === '1') {
  if (dry === '1') { console.log(`Would trash native host registration: ${filename}`); process.exit(0); }
  if (fs.existsSync(filename)) {
    // Remove only this registration, through the Bin so it stays recoverable.
    const removed = spawnSync('/usr/bin/trash', [filename], { stdio: 'inherit' });
    if (removed.status !== 0) process.exit(removed.status || 1);
  }
  console.log(`Removed native host registration: ${filename}`);
} else {
  if (dry === '1') {
    console.log(`Would write ${filename}\n${contents}`);
  } else {
    fs.accessSync(host, fs.constants.X_OK);
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(filename) || fs.readFileSync(filename, 'utf8') !== contents) {
      if (fs.existsSync(filename)) fs.copyFileSync(filename, `${filename}.${Date.now()}.bak`, fs.constants.COPYFILE_EXCL);
      fs.writeFileSync(filename, contents, { mode: 0o600 });
    }
    console.log(`Registered native host: ${filename}`);
  }
  console.log(`Manual step: chrome://extensions → Developer mode → Load unpacked → ${path.join(repo, 'extension')}`);
}
NODE
