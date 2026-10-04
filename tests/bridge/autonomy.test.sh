#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/../.."
node tests/bridge/autonomy.ts
node tests/bridge/autonomy-cli.ts
node tests/bridge/autonomy-falsify.ts
