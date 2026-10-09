#!/usr/bin/env bash
# Remote approval's own rules, pure: how a key becomes the trusted one, which requests can ever be answered from
# another device, and what makes one decision valid. The falsification run breaks each rule in a disposable copy
# and wants its check to turn red.
set -euo pipefail
cd "$(dirname "$0")/../.."
node tests/policy/remote.ts normal
node tests/policy/remote.falsify.ts
