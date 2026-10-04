#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
node tests/signin/broker.test.ts
