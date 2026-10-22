// Disposable owner-home lookup for extension fixtures on any volume.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function useFixtureOwnerHome(directory: string) {
  const root = fs.realpathSync(fileURLToPath(new URL('../.state/', import.meta.url)));
  const home = fs.realpathSync(directory), relative = path.relative(root, home);
  const stat = fs.lstatSync(home);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)
    || !stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
    throw new Error('owner home must be a private child of tests/.state');
  const previous = Object.getOwnPropertyDescriptor(os, 'homedir');
  if (!previous || typeof previous.value !== 'function') throw new Error('owner-home lookup is unavailable');
  Object.defineProperty(os, 'homedir', { ...previous, value: () => home });
  return () => { Object.defineProperty(os, 'homedir', previous); };
}

const configured = process.env.GADDI_TEST_OWNER_HOME;
if (configured !== undefined) useFixtureOwnerHome(configured);
