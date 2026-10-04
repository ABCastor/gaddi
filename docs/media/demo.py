#!/usr/bin/env python3
"""Run the README example through Gaddi, against a disposable local page."""
import functools
import http.server
import json
import os
from pathlib import Path
import subprocess
import shutil
import threading
import time

ROOT = Path(__file__).resolve().parents[2]
class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_args): pass
handler = functools.partial(QuietHandler, directory=str(ROOT))
server = http.server.ThreadingHTTPServer(('127.0.0.1', 8794), handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
ENV = {**os.environ, 'GADDI_CALLER': 'Demo agent'}
def call(*args):
    p = subprocess.run(['gaddi', '--json', *map(str, args)], capture_output=True, text=True, env=ENV, timeout=35)
    return json.loads(p.stdout)
def result(*args):
    message = call(*args)
    if 'error' in message: raise RuntimeError(message['error']['message'])
    return message['result']
def step(command, explanation):
    print('\n$ '+command, flush=True)
    time.sleep(.65)
    print(explanation, flush=True)
    time.sleep(1.1)
tab = None
approval = None
try:
    opened = result('open', 'http://127.0.0.1:8794/docs/media/demo.html', '--group', 'Demo agent')
    tab = opened['id']
    result('emulate', tab, '{"width":960,"height":640}')
    step('gaddi open ' + chr(92) + '\n  http://127.0.0.1:8794/docs/media/demo.html ' + chr(92) + '\n  --group "Demo agent"', f'Opened background tab {tab}.')
    result('look', tab)
    step(f'gaddi look {tab}', 'textbox "Search notes"     button "Search"\nbutton "Publish local note"')
    result('type', tab, '#query', 'browser automation')
    step(f'gaddi type {tab} \'#query\' \'browser automation\'', 'Typed into the existing Chrome tab.')
    result('click', tab, '#search')
    page = result('look', tab)
    assert '1 note found for browser automation' in page['text']
    step(f'gaddi click {tab} \'#search\'', '1 note found for browser automation')
    held = call('click', tab, '#publish')
    approval = held.get('error', {}).get('approval', {}).get('id')
    assert held.get('error', {}).get('code') == 'held', held
    pending = result('approvals')['pending']
    approval = next(a['id'] for a in pending if a.get('tab') == tab)
    page = result('look', tab)
    assert result('eval', tab, "document.getElementById('note-status').textContent")['value'] == 'Note status: draft'
    step(f'gaddi click {tab} \'#publish\'', 'Held. Approve with Touch ID in the Gaddi panel to allow this click.')
    if os.environ.get('GADDI_DEMO_CAPTURE') == '1':
        result('eval', tab, 'window.scrollTo(0,0)')
        media = ROOT/'docs/media'
        shot = result('screenshot', tab)
        subprocess.run(['/usr/bin/sips', '-s', 'format', 'png', shot['path'], '--out', str(media/'browser.png')], check=True, stdout=subprocess.DEVNULL)
        item = next(a for a in result('approvals')['pending'] if a['id'] == approval)
        image = ROOT/'tests/.state/readme-target.jpg'
        if item.get('imagePath'):
            shutil.copyfile(item['imagePath'], image)
        else:
            # Optional broker captures may be absent; render the same card from
            # a real screenshot and the measured target in this live demo tab.
            geometry = result('eval', tab, "(() => {const b=document.getElementById('publish').getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height,viewport:innerWidth}})()")['value']
            shutil.copyfile(shot['path'], image)
            dimensions = subprocess.check_output(['/usr/bin/sips', '-g', 'pixelWidth', str(image)], text=True)
            width = int(dimensions.rsplit('pixelWidth:', 1)[1].strip())
            scale = width/geometry.pop('viewport')
            item['box'] = {key: value*scale for key, value in geometry.items()}
            print('Optional capture absent; rendering the UI example from the live screenshot and measured target.', flush=True)
        item['imagePath'] = str(image)
        (ROOT/'tests/.state/readme-approval.json').write_text(json.dumps(item))
        print('Saved browser capture and isolated approval input.', flush=True)
    time.sleep(2)
finally:
    if approval: call('cancel', approval)
    if tab: call('close', tab)
    server.shutdown()
