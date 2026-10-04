#!/usr/bin/env bash
# tests/run-all.sh — runs every tests/**/*.test.sh, one verdict line per suite, exit non-zero if any fails.
# Suites are self-contained (each spawns what it needs on tests/.state); their full output lands in
# tests/.state/logs/<suite>.log. Ends by checking nothing of the test state is still running.
set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOGS="$REPO/tests/.state/logs"
mkdir -p "$LOGS"
FAILED=0; N=0; OK=0; SKIPPED=0

while IFS= read -r t; do
  N=$((N+1))
  name="${t#"$REPO/tests/"}"; name="${name%.test.sh}"
  # Fake-only runs avoid Chrome for Testing and real Secure Enclave key creation.
  if [[ "${GADDI_TEST_FAKE_ONLY:-0}" == 1 && ( "$name" == bridge/extension || "$name" == bridge/restart || "$name" == signin/browser || "$name" == app/key-store ) ]]; then
    SKIPPED=$((SKIPPED+1))
    echo "SKIP $name (GADDI_TEST_FAKE_ONLY=1: browser and Secure Enclave execution prohibited)"
    continue
  fi
  log="$LOGS/${name//\//_}.log"
  start=$(date +%s)
  bash "$t" >"$log" 2>&1; code=$?
  if [[ $code -eq 0 ]]; then
    OK=$((OK+1))
    summary=$(grep -E '^(FALSIFIED|== .*: [0-9]+ passed)' "$log" | tr '\n' ';' | sed 's/;$//')
    echo "PASS $name ($(( $(date +%s) - start ))s) $summary"
  elif [[ $code -eq 77 ]]; then
    SKIPPED=$((SKIPPED+1))
    echo "SKIP $name ($(grep '^SKIP ' "$log" | head -n 1))"
  else
    FAILED=1
    echo "FAIL $name ($(( $(date +%s) - start ))s) see $log"
    grep -E '^(FAIL|FALSIFIED|== )' "$log" | sed 's/^/    /'
  fi
done < <(find "$REPO/tests" -name '*.test.sh' -not -path '*/.state*' -not -path '*/node_modules/*' | sort)

left=$(pgrep -fl 'tests/\.state' 2>"$LOGS/process-probe.log"); probe=$?
# A launcher can mention test paths in its command text. Its ancestors are still
# running this suite, not leftovers; keep every matching child/unrelated process.
ancestors=" $$ "
ancestor=$PPID
while [[ "$ancestor" =~ ^[0-9]+$ && "$ancestor" -gt 1 ]]; do
  ancestors+="$ancestor "
  ancestor=$(ps -o ppid= -p "$ancestor" 2>>"$LOGS/process-probe.log") || break
  ancestor=${ancestor//[[:space:]]/}
done
# pgrep can print multiline prompt arguments. Only a PID/command row containing
# a test path identifies a process; the subsequent prose is not another process.
left=$(awk -v ancestors="$ancestors" '$1 ~ /^[0-9]+$/ && /tests\/\.state/ && !index(ancestors, " " $1 " ")' <<< "$left")
if [[ $probe -gt 1 || -s "$LOGS/process-probe.log" ]]; then
  echo 'SKIP leftover process check: process inspection unavailable; run this check in a terminal with process access'
elif [[ -n "$left" ]]; then
  echo "FAIL leftover processes still carry tests/.state:"; echo "$left" | sed 's/^/    /'; FAILED=1
else
  echo "PASS no leftover test processes (runner ancestors excluded)"
fi
echo "== $OK/$N suites passed"
if [[ $SKIPPED -gt 0 ]]; then echo "== $SKIPPED suites skipped (prerequisites unavailable)"; fi
exit $FAILED
