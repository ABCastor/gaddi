#!/usr/bin/env node
// Run on macOS with sharp available to Node (for example through NODE_PATH).
// The extension vector is the shared editable browser mark. Rebuild it first
// with build_readme_header.py when changing the canonical Castor geometry.
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const sharp = createRequire(import.meta.url)('sharp');
const docs = dirname(fileURLToPath(import.meta.url));
const source = await readFile(join(docs, 'media/extension-icon.svg'));
await writeFile(join(docs, 'media/native-app-icon.svg'), source);
const scratch = await mkdtemp(join(tmpdir(), 'gaddi-native-icon-'));
const iconset = join(scratch, 'Gaddi.iconset');
await mkdir(iconset);
const chunks = [];
const types = [['ic04', 'ic11'], ['ic05', 'ic12'], ['ic07', 'ic13'], ['ic08', 'ic14'], ['ic09', 'ic10']];
let index = 0;
for (const size of [16, 32, 128, 256, 512]) {
  for (const scale of [1, 2]) {
    const pixels = size * scale;
    const name = `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`;
    const rendered = sharp(source, { density: pixels / 128 * 72 })
      .resize(pixels, pixels);
    const png = await rendered.png().toBuffer();
    await writeFile(join(iconset, name), png);
    let member = png;
    // Apple's small 1x members use premultiplied ARGB, not PNG. Encode the
    // channel planes directly so a PNG conversion cannot premultiply twice.
    if (scale === 1 && size <= 32) {
      const rgba = await sharp(png).ensureAlpha().raw().toBuffer();
      const planes = [Buffer.from('ARGB')];
      for (const channel of [3, 0, 1, 2]) {
        for (let start = 0; start < pixels * pixels; start += 128) {
          const count = Math.min(128, pixels * pixels - start);
          const literal = Buffer.alloc(count + 1);
          literal[0] = count - 1;
          for (let pixel = 0; pixel < count; pixel++) {
            const offset = (start + pixel) * 4;
            literal[pixel + 1] = channel === 3 ? rgba[offset + 3]
              : Math.round(rgba[offset + channel] * rgba[offset + 3] / 255);
          }
          planes.push(literal);
        }
      }
      member = Buffer.concat(planes);
    }
    const header = Buffer.alloc(8);
    header.write(types[index][scale - 1]);
    header.writeUInt32BE(member.length + 8, 4);
    chunks.push(header, member);
  }
  index += 1;
}
const output = join(docs, '../app/Gaddi.icns');
const header = Buffer.alloc(8);
header.write('icns');
header.writeUInt32BE(8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0), 4);
await writeFile(output, Buffer.concat([header, ...chunks]));
execFileSync('/usr/bin/iconutil', ['-c', 'iconset', output, '-o', join(scratch, 'roundtrip.iconset')]);
console.log(`Native icon generated: ${output}`);
console.log(`Rendered iconset retained: ${iconset}`);
