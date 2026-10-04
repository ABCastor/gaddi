#!/usr/bin/env python3
"""Live checks for A (approval picture), B (wait tool, no-effect advice) and C (viewport-only look).

Runs against the live broker in the everyday Chrome, in background tabs it opens and closes.
Leaves ONE held approval pending on purpose, so the picture can be seen in the Gaddi app.
"""
import json, os, subprocess, sys, time
from pathlib import Path

# Serve the local test page ourselves, so this script needs no prior setup.
PAGE_DIR = Path(__file__).with_name('approval-test')
server = subprocess.Popen([sys.executable, '-m', 'http.server', '8792', '--bind', '127.0.0.1'],
                          cwd=PAGE_DIR, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)

ENV = {**os.environ, 'GADDI_CALLER': 'bench'}
HOME = Path.home() / 'Library/Application Support/Gaddi'


def gaddi(*args, tab=None):
    cmd = ['gaddi', '--json'] + ([] if tab is None else ['--tab', str(tab)]) + list(args)
    p = subprocess.run(cmd, capture_output=True, text=True, env=ENV, timeout=60)
    try:
        out = json.loads(p.stdout)
    except json.JSONDecodeError:
        return {'error': {'message': (p.stdout or p.stderr).strip()[:200]}}
    return out.get('result', out)


def open_tab(url):
    r = gaddi('open', url, '--group', 'bench')
    return r['id']


print('== C: viewport-only look on a long page')
big = open_tab('https://en.wikipedia.org/wiki/United_States')
t0 = time.perf_counter(); full = gaddi('look', tab=big); full_ms = round((time.perf_counter() - t0) * 1000)
t0 = time.perf_counter(); vis = gaddi('look', '--visible', tab=big); vis_ms = round((time.perf_counter() - t0) * 1000)
print(f"  full look:    {len(full.get('outline','')):7} outline chars, {len(full.get('text','')):7} text chars, {full_ms} ms")
print(f"  visible look: {len(vis.get('outline','')):7} outline chars, {len(vis.get('text','')):7} text chars, {vis_ms} ms, offscreen={vis.get('offscreen')}")

print('== B1: wait for text that appears later')
gaddi('eval', "setTimeout(() => { const d = document.createElement('div'); d.id='late'; d.textContent='Ready for the agent'; document.body.append(d); }, 900); 'armed'", tab=big)
t0 = time.perf_counter(); w = gaddi('wait', '{"text":"Ready for the agent","timeout":8000}', tab=big)
print(f"  wait text:    {w} (measured {round((time.perf_counter()-t0)*1000)} ms)")
t0 = time.perf_counter(); w2 = gaddi('wait', '{"text":"this text never appears","timeout":1500}', tab=big)
print(f"  wait timeout: {w2} (measured {round((time.perf_counter()-t0)*1000)} ms)")
w3 = gaddi('wait', '{"selector":"#late","gone":true,"timeout":1200}', tab=big)
print(f"  wait gone (still present, expect met false): {w3}")

print('== B2: advice after three actions that change nothing')
for i in range(1, 4):
    r = gaddi('hover', 'h1', tab=big)
    print(f"  hover {i}: changed={r.get('changed')} warning={r.get('warning')}")
gaddi('close', str(big))

print('== A: a held click keeps a picture of the target')
test = open_tab('http://127.0.0.1:8792/')
held = gaddi('click', '#pay', tab=test)
print(f"  click result: {json.dumps(held)[:200]}")
pending = gaddi('approvals').get('pending', [])
mine = [a for a in pending if a.get('tab') == test]
for a in mine:
    path = a.get('imagePath'); box = a.get('box')
    size = Path(path).stat().st_size if path and Path(path).exists() else None
    mode = oct(Path(path).stat().st_mode & 0o777) if path and Path(path).exists() else None
    print(f"  approval {a['id']}: detail={a.get('detail')!r} picture={size} bytes mode={mode} box={box}")
print(f"  test tab {test} left open with its approval pending, for the app panel")
print(f'  (local test server pid {server.pid} stays up for 30 minutes so the page still renders in the panel)')
try:
    server.wait(timeout=1800)
except subprocess.TimeoutExpired:
    server.terminate()
