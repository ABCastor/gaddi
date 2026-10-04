#!/usr/bin/env bash
# Registration and configuration updates against synthetic configs only.
set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REG="$REPO/install/register"
WORK="$REPO/tests/.state-mcp/register-$$"
ROOT="$WORK/root"; ORIG="$WORK/orig"; MID="$WORK/mid"
# all.sh also installs the app/bridge; native-host registration is outside these fixtures.
# Invariant: this test invokes only the four copy-aware harness editors, never installers.
register_harnesses() {
  local harness rc=0
  for harness in claude-code claude-desktop codex opencode; do
    bash "$REG/$harness.sh" "$@" || rc=1
  done
  return "$rc"
}
FAILED=0
pass() { echo "PASS $1 ${2:-}"; }
fail() { echo "FAIL $1 ${2:-}"; FAILED=1; }
trap 'rm -rf "$WORK"' EXIT   # scratch copies of config files: removed, never trashed

REL=( ".claude.json" ".claude/settings.json" "Library/Application Support/Claude/claude_desktop_config.json" ".codex/config.toml" ".config/opencode/opencode.jsonc" )
python3 - "$ROOT" <<'PYSETUP'
import json, pathlib, sys
root = pathlib.Path(sys.argv[1])
files = {
    '.claude.json': {'mcpServers': {'other': {'command': 'fixture'}}, 'keep': True},
    '.claude/settings.json': {'permissions': {'allow': ['Read']}, 'keep': True},
    'Library/Application Support/Claude/claude_desktop_config.json': {'mcpServers': {'other': {'command': 'fixture'}}},
    '.config/opencode/opencode.jsonc': {'mcp': {'other': {'type': 'local', 'command': ['fixture']}}, 'model': 'fixture/model'},
}
for name, value in files.items():
    file = root / name
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(json.dumps(value, indent=2) + '\n')
file = root / '.codex/config.toml'
file.parent.mkdir(parents=True, exist_ok=True)
file.write_text('model = "fixture"\n\n[mcp_servers.other]\ncommand = "fixture"\n')
PYSETUP
for r in "${REL[@]}"; do
  mkdir -p "$ORIG/$(dirname "$r")" "$MID/$(dirname "$r")"
  cp "$ROOT/$r" "$ORIG/$r"
done
chmod 600 "$ROOT/.claude.json" "$ORIG/.claude.json"   # at least one file with a private mode, so modes-kept can fail
export GADDI_CONFIG_ROOT="$ROOT"
export GADDI_LSAPPINFO=/usr/bin/true # Synthetic app-not-running detector; never inspect the live Desktop.
# Normalize synthetic fixtures before the preservation checks.
register_harnesses --remove >/dev/null 2>&1 || true
find "$ROOT" -name "*.bak-*" -delete 2>/dev/null || true
for r in "${REL[@]}"; do cp "$ROOT/$r" "$ORIG/$r"; done
same() { cmp -s "$1" "$2"; }
nbak() { find "$ROOT" -name '*.bak-*' | wc -l | tr -d ' '; }
# js <expr>: node one-liner with helpers strip() and read(); prints the expression
js() { node --input-type=module -e "
import fs from 'node:fs';
const strip = (src) => { let out='',i=0,s=false; while(i<src.length){const c=src[i],n=src[i+1]; if(s){out+=c; if(c==='\\\\'){out+=n;i+=2;continue;} if(c==='\"')s=false;i++;continue;} if(c==='\"'){s=true;out+=c;i++;continue;} if(c==='/'&&n==='/'){while(i<src.length&&src[i]!=='\n')i++;continue;} if(c==='/'&&n==='*'){i+=2;while(i<src.length&&!(src[i]==='*'&&src[i+1]==='/'))i++;i+=2;continue;} out+=c;i++;} return out; };
const read = (f, jsonc) => JSON.parse(jsonc ? strip(fs.readFileSync(f,'utf8')) : fs.readFileSync(f,'utf8'));
const eq = (a,b) => JSON.stringify(a)===JSON.stringify(b);
const canon = v => Array.isArray(v) ? v.map(canon) : (v && typeof v==='object') ? Object.fromEntries(Object.keys(v).sort().map(k=>[k,canon(v[k])])) : v;
const deq = (a,b) => JSON.stringify(canon(a))===JSON.stringify(canon(b));
process.stdout.write(String($1));
"; }

# 1. dry-run: nothing changes, no backups
out=$(register_harnesses --dry-run 2>&1); rc=$?
ok=1; for r in "${REL[@]}"; do same "$ROOT/$r" "$ORIG/$r" || ok=0; done
if (( rc == 0 && ok == 1 )) && [[ "$(nbak)" == "0" ]] && grep -q 'dry-run: nothing written' <<<"$out" && [[ $(grep -c '^would change:' <<<"$out") == 5 ]]; then pass dry-run-touches-nothing "5 files would change, 0 written, 0 backups"; else fail dry-run-touches-nothing "rc=$rc identical=$ok backups=$(nbak)"; echo "$out" | head -40; fi

# 2. real run against the copies
out=$(register_harnesses 2>&1); rc=$?
(( rc == 0 )) && pass register-run "four harness scripts exit 0" || { fail register-run "exit $rc"; echo "$out" | tail -20; }
[[ "$(nbak)" == "5" ]] && pass backups-made "5 .bak-<ts> files next to the edited files" || fail backups-made "found $(nbak)"
modes_ok=yes
for r in "${REL[@]}"; do
  m0=$(stat -f%Lp "$ORIG/$r"); m1=$(stat -f%Lp "$ROOT/$r"); mb=$(stat -f%Lp "$(ls "$ROOT/$r".bak-* | head -1)")
  [[ "$m0" == "$m1" && "$m0" == "$mb" ]] || { modes_ok=no; echo "  mode drift on $r: orig=$m0 new=$m1 bak=$mb"; }
done
[[ "$modes_ok" == "yes" ]] && pass modes-kept "rewritten files and backups keep the original mode (incl. the 0600 one)" || fail modes-kept
for r in "${REL[@]}"; do cp "$ROOT/$r" "$MID/$r"; done

# claude.json: parses, prior keys kept, entry present
r=$(js "(()=>{const a=read('$ORIG/.claude.json'),b=read('$ROOT/.claude.json');const e=b.mcpServers['gaddi'];delete b.mcpServers['gaddi'];return [eq(a,b), !!e && e.type==='stdio' && e.args[0].endsWith('/mcp/server.mjs') && e.env.GADDI_HARNESS==='claude-code'].join(' ')})()")
[[ "$r" == "true true" ]] && pass claude-json "prior content identical after removing our entry; entry well-formed" || fail claude-json "$r"
# settings.json: parses, allow gained exactly the tool names, everything else identical
r=$(js "(()=>{const a=read('$ORIG/.claude/settings.json'),b=read('$ROOT/.claude/settings.json');const ours=b.permissions.allow.filter(x=>x.startsWith('mcp__gaddi__'));b.permissions.allow=b.permissions.allow.filter(x=>!x.startsWith('mcp__gaddi__'));const sorted=eq(ours,[...ours].sort())&&new Set(ours).size===ours.length;return [eq(a,b), ours.length, sorted].join(' ')})()")
ntools=$(node "$REPO/mcp/server.mjs" --list-tools | wc -l | tr -d ' ')
[[ "$ntools" == "25" ]] || fail exact-tool-count "$ntools"
[[ "$r" == "true $ntools true" ]] && pass claude-settings "allow gained $ntools sorted unique rules; rest identical" || fail claude-settings "$r (expected true $ntools true)"
# desktop: other kept, entry present
r=$(js "(()=>{const a=read('$ORIG/Library/Application Support/Claude/claude_desktop_config.json'),b=read('$ROOT/Library/Application Support/Claude/claude_desktop_config.json');const e=b.mcpServers['gaddi'];delete b.mcpServers['gaddi'];return [eq(a,b), !!b.mcpServers.other, !!e && e.env.GADDI_HARNESS==='claude-desktop'].join(' ')})()")
[[ "$r" == "true true true" ]] && pass claude-desktop "other kept; entry present; rest identical" || fail claude-desktop "$r"
# toml: exactly one header, original is a byte-for-byte prefix
n=$(grep -c '^\[mcp_servers\.gaddi\]$' "$ROOT/.codex/config.toml"); ne=$(grep -c '^\[mcp_servers\.gaddi\.env\]$' "$ROOT/.codex/config.toml")
osz=$(stat -f%z "$ORIG/.codex/config.toml")
prefix_ok=no; head -c "$osz" "$ROOT/.codex/config.toml" | cmp -s - "$ORIG/.codex/config.toml" && prefix_ok=yes
if [[ "$n" == "1" && "$ne" == "1" && "$prefix_ok" == "yes" ]] && grep -q '^GADDI_HARNESS = "codex"$' "$ROOT/.codex/config.toml"; then pass codex-toml "1 [mcp_servers.gaddi] + 1 .env table appended; first $osz bytes identical"; else fail codex-toml "headers=$n env=$ne prefix-identical=$prefix_ok"; fi
# jsonc: parses after comment strip, other kept, entry well-formed, rest identical
r=$(js "(()=>{const a=read('$ORIG/.config/opencode/opencode.jsonc',true),b=read('$ROOT/.config/opencode/opencode.jsonc',true);const e=b.mcp['gaddi'];delete b.mcp['gaddi'];return [eq(a,b), !!b.mcp.other, !!e && e.type==='local' && e.command.length===2 && e.environment.GADDI_HARNESS==='opencode' && e.enabled===true].join(' ')})()")
[[ "$r" == "true true true" ]] && pass opencode-jsonc "parses after comment strip; other kept; entry well-formed; rest identical" || fail opencode-jsonc "$r"

# 3. second run: nothing changes, no new backups
out=$(register_harnesses 2>&1); rc=$?
ok=1; for r in "${REL[@]}"; do same "$ROOT/$r" "$MID/$r" || ok=0; done
if (( rc == 0 && ok == 1 )) && [[ "$(nbak)" == "5" ]] && [[ $(grep -c '^no change:' <<<"$out") == 5 ]]; then pass idempotent "second run: 5 'no change' lines, files byte-identical, still 5 backups"; else fail idempotent "rc=$rc identical=$ok backups=$(nbak) nochange=$(grep -c '^no change:' <<<"$out")"; fi

# 4. remove: originals restored byte-for-byte
out=$(register_harnesses --remove 2>&1); rc=$?
ok=1; for r in "${REL[@]}"; do same "$ROOT/$r" "$ORIG/$r" || { ok=0; echo "  differs after --remove: $r"; diff <(cat "$ORIG/$r") <(cat "$ROOT/$r") | head -5; }; done
if (( rc == 0 && ok == 1 )) && [[ "$(nbak)" == "10" ]]; then pass remove-restores "all 5 files byte-identical to the originals; 10 backups kept"; else fail remove-restores "rc=$rc identical=$ok backups=$(nbak)"; fi
# 5. remove again: no-op
out=$(register_harnesses --remove 2>&1); rc=$?
(( rc == 0 )) && [[ $(grep -c '^no change:' <<<"$out") == 5 ]] && pass remove-idempotent "second --remove: 5 'no change' lines" || fail remove-idempotent "rc=$rc"


# 6. jsonc editor on synthetic files the real config cannot exercise: real comments, an empty "mcp", no "mcp" key
syn_case() { # <name> <content>  (each case in its own root; the whole $WORK goes at exit)
  local name="$1" root="$WORK/syn-$1" f
  mkdir -p "$root/.config/opencode"; f="$root/.config/opencode/opencode.jsonc"
  printf '%s' "$2" > "$f"; cp "$f" "$f.orig"
  local o1 o2 ok
  o1=$(GADDI_CONFIG_ROOT="$root" bash "$REG/opencode.sh" 2>&1) || { fail "jsonc-$name" "add failed: $(tail -3 <<<"$o1")"; return; }
  ok=$(js "(()=>{const b=read('$f',true);const e=b.mcp&&b.mcp['gaddi'];return !!e&&e.type==='local'&&e.environment.GADDI_HARNESS==='opencode'})()")
  local comments_kept=yes; [[ "$2" == *"// keep me"* ]] && ! grep -q '// keep me' "$f" && comments_kept=no
  o2=$(GADDI_CONFIG_ROOT="$root" bash "$REG/opencode.sh" 2>&1); local idem=no; grep -q '^no change:' <<<"$o2" && idem=yes
  GADDI_CONFIG_ROOT="$root" bash "$REG/opencode.sh" --remove >/dev/null 2>&1 || true
  # byte-for-byte restore when "mcp" pre-existed; when it did not, --remove leaves "mcp": {} (same meaning, the editor cannot know the key was absent)
  local restored=no
  if cmp -s "$f" "$f.orig"; then restored=bytes
  elif [[ "$(js "(()=>{const a=read('$f.orig',true),b=read('$f',true);a.mcp=a.mcp||{};b.mcp=b.mcp||{};return deq(a,b)})()")" == "true" ]]; then restored=semantic; fi
  if [[ "$ok" == "true" && "$comments_kept" == "yes" && "$idem" == "yes" && "$restored" != "no" ]]; then pass "jsonc-$name" "entry parsed, comments kept, idempotent, --remove restores ($restored)"; else fail "jsonc-$name" "entry=$ok comments=$comments_kept idempotent=$idem restored=$restored"; fi
}
syn_case with-comments $'{\n  // keep me: top comment\n  "$schema": "https://opencode.ai/config.json", /* keep me too */\n  "mcp": {\n    // keep me: inside mcp\n    "other": { "type": "remote", "url": "https://x.example/mcp" }\n  },\n  "model": "a/b" // keep me: trailing\n}\n'
syn_case empty-mcp $'{\n  "$schema": "https://opencode.ai/config.json",\n  "mcp": {},\n  "model": "a/b"\n}\n'
syn_case no-mcp-key $'{\n  "$schema": "https://opencode.ai/config.json",\n  "model": "a/b"\n}\n'
syn_case no-mcp-no-schema $'{\n  "model": "a/b"\n}\n'

# Registration replaces obsolete tool rules while preserving unrelated entries.
UPDATED="$WORK/update"
mkdir -p "$UPDATED"
cp -R "$MID/." "$UPDATED/"
python3 - "$UPDATED" <<'PYUPDATE'
import json, pathlib, sys
root = pathlib.Path(sys.argv[1])
p = root / '.claude/settings.json'
x = json.loads(p.read_text())
x['permissions']['allow'] += ['mcp__gaddi__chrome_tabs', 'mcp__gaddi__browser_watch']
p.write_text(json.dumps(x, indent=2) + '\n')
p = root / '.codex/config.toml'
p.write_text(p.read_text().replace('approval_mode = "approve"', 'approval_mode = "auto"'))
with p.open('a') as f:
    f.write('\n[mcp_servers.gaddi.tools.chrome_tabs]\napproval_mode = "ask"\n\n[mcp_servers.gaddi.tools.browser_watch]\napproval_mode = "ask"\n')
PYUPDATE
if GADDI_CONFIG_ROOT="$UPDATED" register_harnesses > "$WORK/update.log" 2>&1; then
  node "$REPO/mcp/server.mjs" --list-tools > "$WORK/tools"
  if python3 - "$UPDATED" "$WORK/tools" <<'PYVERIFY'
import json, pathlib, re, sys
root, names = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]).read_text().splitlines()
assert len(names) == 25
assert 'browser_signin' in names
assert 'browser_wait' in names
settings = json.loads((root / '.claude/settings.json').read_text())
ours = [s for s in settings['permissions']['allow'] if s.startswith('mcp__gaddi__')]
assert sorted(ours) == sorted('mcp__gaddi__' + name for name in names)
assert 'Read' in settings['permissions']['allow']
toml = (root / '.codex/config.toml').read_text()
headers = re.findall(r'^\[mcp_servers\.gaddi\.tools\.([^]]+)\]\n([^[]*)', toml, re.M)
assert sorted(name for name, _ in headers) == sorted(names)
assert all('approval_mode = "approve"' in body for _, body in headers)
assert 'default_tools_approval_mode = "approve"' in toml
assert 'approval_mode = "auto"' not in toml
assert '[mcp_servers.other]\ncommand = "fixture"' in toml
assert 'chrome_tabs' not in toml and 'browser_watch' not in toml
PYVERIFY
  then pass update-tool-rules "25 Claude rules and 25 Codex approve tables; auto replaced; obsolete rules removed; unrelated entries kept"
  else fail update-tool-rules "registered config mismatch"; fi
else fail update-tool-rules "editor failure"; cat "$WORK/update.log"; fi
cp "$UPDATED/.codex/config.toml" "$WORK/codex-approved.toml"
if GADDI_CONFIG_ROOT="$UPDATED" bash "$REG/codex.sh" > "$WORK/approve-repeat.log" 2>&1 && cmp -s "$UPDATED/.codex/config.toml" "$WORK/codex-approved.toml" && grep -q '^no change:' "$WORK/approve-repeat.log"; then
  pass codex-approve-idempotent 'repeat registration leaves config byte-identical'
else fail codex-approve-idempotent; cat "$WORK/approve-repeat.log"; fi
if (( FAILED == 0 )); then echo '== MCP register: all checks passed, 0 failed'; fi
exit $FAILED
