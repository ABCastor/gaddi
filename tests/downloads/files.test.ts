import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { downloadTarget, saveDownload } from '../../daemon/downloads.ts';
const home = fs.mkdtempSync(path.join(os.tmpdir(),'gaddi-download-files-'));
try {
  const downloads = path.join(home,'Downloads'); fs.mkdirSync(downloads);
  const target = downloadTarget(path.join(downloads,'export.zip'),{home,temp:[]});
  const bytes = Buffer.from('fixture page-generated ZIP bytes');
  saveDownload(target,bytes);
  assert.deepEqual(fs.readFileSync(target),bytes); assert.equal(fs.statSync(target).mode&0o777,0o600);
  assert.throws(()=>downloadTarget(target,{home,temp:[]}));
  assert.throws(()=>saveDownload(target,Buffer.from('overwrite')));
  assert.deepEqual(fs.readFileSync(target),bytes,'never overwrite an existing file');
  fs.symlinkSync(home,path.join(downloads,'escape'));
  for(const bad of [path.join(home,'LaunchAgents','export'),path.join(downloads,'escape','new'),path.join(downloads,'.env')])
    assert.throws(()=>downloadTarget(bad,{home,temp:[]}));
  assert.throws(()=>saveDownload(path.join(downloads,'large'),Buffer.alloc(20*1024*1024+1)));
  assert.ok(!fs.existsSync(path.join(downloads,'large')));
  console.log('PASS page download writes bounded bytes privately, no overwrite or path escape');
} finally { fs.rmSync(home,{recursive:true,force:true}); }
