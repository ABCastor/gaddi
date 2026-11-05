import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadPolicy } from '../../daemon/policy.ts';
import { checkDownload } from '../../daemon/downloads.ts';
// DOWNLOAD-CAPTURE: no hold by default; hold.downloads in the user's policy.json turns it on.
const home = fs.mkdtempSync(path.join(os.tmpdir(),'gaddi-download-policy-'));
const overlay = path.join(home,'policy.json');
const write = (value: unknown) => fs.writeFileSync(overlay, JSON.stringify(value));
try {
  assert.equal(checkDownload(loadPolicy({ overlay, off: false })).outcome, 'allow', 'ASSERT_DOWNLOAD_DEFAULT_NO_HOLD');
  // A user overlay with no hold section gets the default too.
  write({ deny: { type_into: [] }, uploads: { remember: [] }, zones: { sites: [] }, approvals: { ttl_minutes: 10 } });
  const existing = loadPolicy({ overlay, off: false });
  assert.equal(existing.sources.at(-1), overlay);
  assert.equal(checkDownload(existing).outcome, 'allow', 'ASSERT_DOWNLOAD_EXISTING_OVERLAY_NO_HOLD');
  write({ hold: { downloads: true } });
  const holding = loadPolicy({ overlay, off: false });
  assert.equal(checkDownload(holding).outcome, 'hold', 'ASSERT_DOWNLOAD_OPT_IN_HOLD');
  assert.equal(holding.hold.uploads, true, 'a partial hold overlay keeps the other defaults');
  assert.ok(holding.hold.verbs.includes('delete'), 'a partial hold overlay keeps the hold verbs');
  assert.equal(checkDownload(loadPolicy({ overlay, off: true })).outcome, 'allow', 'test-only policy off allows');
  write({ hold: { downloads: false } });
  assert.equal(checkDownload(loadPolicy({ overlay, off: false })).outcome, 'allow');
  for (const downloads of ['yes', 1, null]) {
    write({ hold: { downloads } });
    assert.throws(() => loadPolicy({ overlay, off: false }), /Invalid policy overlay/, 'ASSERT_DOWNLOAD_POLICY_INVALID');
  }
  console.log('PASS download hold: off by default (also for an existing overlay), the policy switch restores it, invalid values refused');
} finally { fs.rmSync(home,{recursive:true,force:true}); }
