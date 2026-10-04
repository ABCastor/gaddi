#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/../.."
node tests/bridge/framing.ts
