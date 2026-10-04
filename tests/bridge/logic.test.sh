#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/../.."
node tests/bridge/logic.ts
node tests/bridge/debugger-falsify.ts
