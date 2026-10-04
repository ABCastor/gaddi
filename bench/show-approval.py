#!/usr/bin/env python3
"""Wait for the reloaded extension, then hold one test click and open the panel."""
import json, os, subprocess, sys, time
from pathlib import Path
ENV = {**os.environ, 'GADDI_CALLER': 'bench'}
PAGE = Path(__file__).with_name('approval-test')
server = subprocess.Popen([sys.executable, '-m', 'http.server', '8792', '--bind', '127.0.0.1'],
                          cwd=PAGE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)


def gaddi(*args, tab=None):
    cmd = ['gaddi', '--json'] + ([] if tab is None else ['--tab', str(tab)]) + list(args)
    p = subprocess.run(cmd, capture_output=True, text=True, env=ENV, timeout=60)
    try:
        return json.loads(p.stdout, strict=False).get('result', json.loads(p.stdout, strict=False))
    except Exception:
        return {'error': {'message': (p.stdout or p.stderr)[:200]}}


LOG = Path.home() / 'Library/Application Support/Gaddi/bridge.log'
started = time.strftime('%Y-%m-%dT%H:%M:%S', time.gmtime())


def extension_restarted(since):
    """A reload restarts the native host; so does Chrome idling the worker, so the
    capture itself is what finally proves the new code is in."""
    try:
        return any(line.split(' ')[0] > since and 'host-started' in line for line in LOG.read_text().splitlines())
    except OSError:
        return False


deadline = time.time() + 5400
tab = gaddi('open', 'http://127.0.0.1:8792/', '--group', 'approval demo')['id']
while time.time() < deadline:
    if not extension_restarted(started):
        time.sleep(5)
        continue
    started = time.strftime('%Y-%m-%dT%H:%M:%S', time.gmtime())
    held = gaddi('click', '#pay', tab=tab)
    message = held.get('error', {}).get('message', '')
    if 'approve' in message:
        approval = message.split('approve ')[1].split(' ')[0]
        record = next((a for a in gaddi('approvals').get('pending', []) if a['id'] == approval), {})
        image = record.get('imagePath')
        size = Path(image).stat().st_size if image and Path(image).exists() else None
        # The wider capture only exists in the reloaded extension; keep waiting until it does.
        if record.get('box') and size and size > 9000:
            print(f"approval {approval}: picture {size} bytes, box {record['box']}")
            subprocess.run(['gaddi', 'approve', approval], env=ENV, capture_output=True)
            print("panel opened; it expires in 10 minutes")
            break
        gaddi('cancel', approval)
else:
    print('no reload within 90 minutes')
gaddi('close', str(tab))
try:
    server.wait(timeout=900)
except subprocess.TimeoutExpired:
    server.terminate()
