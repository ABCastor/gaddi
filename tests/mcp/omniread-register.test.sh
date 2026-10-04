#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
node tests/mcp/omniread-register.ts
