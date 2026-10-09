#!/usr/bin/env bash
# Session grant rules, pure: parsing, scope, the table of what can be waived, the store.
# The falsification run breaks each rule in a disposable copy and wants its check to turn red.
set -euo pipefail
cd "$(dirname "$0")/../.."
node tests/policy/grants.ts normal
node tests/policy/grants.falsify.ts
