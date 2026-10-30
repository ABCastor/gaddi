#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
node tests/redaction/urls.test.ts
node tests/redaction/broker.test.ts

# Independent negative control: retain credential-match redaction but remove URL redaction
# from the real broker's shared output sink in a disposable source fixture.
mutant=$(mktemp -d "$PWD/tests/.state/url-redaction-mutant-XXXXXX")
node --input-type=module - "$mutant" <<'JS'
import fs from 'node:fs';
import path from 'node:path';
const root = process.argv[2];
for (const name of ['daemon', 'shared', 'policy']) fs.cpSync(name, path.join(root, name), { recursive: true });
fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ type: 'module' }));
const file = path.join(root, 'daemon/daemon.ts'), source = fs.readFileSync(file, 'utf8');
const before = 'redactURLs(signinSecrets.redact(value, undefined, false))';
if (source.split(before).length !== 2) throw Error('URL redaction mutation point missing');
fs.writeFileSync(file, source.replace(before, 'signinSecrets.redact(value, undefined, false)'));
JS
set +e
node tests/redaction/broker.test.ts "$mutant/daemon/daemon.mjs" > "$mutant/result.log" 2>&1
code=$?
set -e
if [[ "$code" == 1 ]] && grep -q '^FAIL .*ASSERT_URL_REDACTION' "$mutant/result.log" && grep -q '^== URL redaction:' "$mutant/result.log"; then
  echo 'FALSIFIED URL redaction (removing the broker output sanitizer leaks the synthetic callback)'
else
  echo "FAIL URL redaction falsification (exit $code)"
  exit 1
fi
