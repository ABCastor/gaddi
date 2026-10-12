#!/usr/bin/env bash
# A bound Unix socket is not yet a listening broker. Force that gap on restart.
set -euo pipefail
cd "$(dirname "$0")/../.."
mkdir -p tests/.state
# NODE_OPTIONS quoting must also work in checkouts whose paths contain spaces.
PRELOAD=$(node --input-type=module -e 'import { pathToFileURL } from "node:url"; import path from "node:path"; process.stdout.write(pathToFileURL(path.resolve("tests/fixtures/delay-bind.ts")).href);')
NODE_OPTIONS="${NODE_OPTIONS:-} --import=$PRELOAD" node tests/fixtures/broker-checks.ts remote-approver delayed-bind
echo '== broker readiness: delayed-bind restart completed, 0 failed'
