#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
mkdir -p tests/.state
node tests/bridge/render-browser.ts
