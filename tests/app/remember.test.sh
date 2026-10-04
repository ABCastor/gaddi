#!/bin/bash
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
STATE="$REPO/tests/.state/app-remember-$$"
mkdir -p "$STATE" "$REPO/app/build/module-cache"
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer /usr/bin/xcrun swiftc -swift-version 5 \
  -module-cache-path "$REPO/app/build/module-cache" -framework AppKit -framework CryptoKit \
  "$REPO/app/Sources/SocketClient.swift" "$REPO/app/Sources/Protocol.swift" \
  "$REPO/app/Sources/ApprovalCard.swift" "$REPO/tests/app/remember.swift" -o "$STATE/remember"
"$STATE/remember" "$STATE/proofs.json"
cd "$REPO"
node --input-type=module - "$STATE/proofs.json" <<'NODE'
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { approvalMessage, signinRevokeMessage, sendRevokeMessage, createProofVerifier } from './daemon/proof.ts';
const file = process.argv[2], fixture = JSON.parse(fs.readFileSync(file, 'utf8'));
const publicKeyPath = path.join(path.dirname(file), 'fake-approver.pub');
fs.writeFileSync(publicKeyPath, fixture.publicKey);
const proofs = createProofVerifier({ publicKeyPath, usedPath: path.join(path.dirname(file), 'used.log') });
const message = approvalMessage('grant', fixture.approval, fixture.grant.ts, true);
assert.throws(() => proofs.verify(fixture.grant, approvalMessage('grant', fixture.approval, fixture.grant.ts)), /verification failed/);
proofs.verify(fixture.grant, message);
proofs.verify(fixture.revoke, signinRevokeMessage(fixture.approval.site, fixture.revoke.ts));
assert.throws(() => proofs.verify(fixture.grant, message), /already used/);
const send = fixture.sendApproval;
const rule = { site: send.site, kind: send.kind, reason: send.reason };
assert.throws(() => proofs.verify(fixture.sendGrant, approvalMessage('grant', { ...send, reason: 'enter-submits:send now' }, fixture.sendGrant.ts, true)), /verification failed/);
assert.throws(() => proofs.verify(fixture.sendGrant, approvalMessage('grant', send, fixture.sendGrant.ts)), /verification failed/);
proofs.verify(fixture.sendGrant, approvalMessage('grant', send, fixture.sendGrant.ts, true));
assert.throws(() => proofs.verify(fixture.sendRevoke, sendRevokeMessage({ ...rule, kind: 'click', reason: 'verb:send' }, fixture.sendRevoke.ts)), /verification failed/);
proofs.verify(fixture.sendRevoke, sendRevokeMessage(rule, fixture.sendRevoke.ts));
console.log('PASS Swift send grant/revoke signatures verify in Node; hold reason, kind and remember choice tampering fail');
console.log('PASS Swift software signatures verify in the production Node verifier; choice tampering and replay are refused');
console.log('== app remember interoperability: 2 passed, 0 failed');
NODE
