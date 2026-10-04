#!/usr/bin/env python3
"""Live Gaddi benchmark: one fixed task in a background tab of the everyday Chrome, via the gaddi CLI.

Same commands before and after a change (CSS selectors, never version-specific refs), so the
comparison isolates Gaddi. Records wall time per step, the typed-field result, and the look size.
Usage: live-bench.py <label>   -> writes results/<label>.json and prints a summary.
"""
import json, subprocess, sys, time
from pathlib import Path

LABEL = sys.argv[1] if len(sys.argv) > 1 else 'run'
OUT = Path(__file__).with_name('results'); OUT.mkdir(exist_ok=True)
URL = 'https://en.wikipedia.org/w/index.php?search=hello&title=Special%3ASearch&ns0=1&fulltext=1'
ENV = {'GADDI_CALLER': 'bench'}
steps, tab = [], None


def gaddi(name, *args, timeout=40):
    cmd = ['gaddi', '--json'] + ([] if tab is None else ['--tab', str(tab)]) + list(args)
    t0 = time.perf_counter()
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout,
                       env={**__import__('os').environ, **ENV})
    ms = round((time.perf_counter() - t0) * 1000)
    try:
        out = json.loads(p.stdout) if p.stdout.strip() else None
        if isinstance(out, dict) and 'result' in out:
            out = out['result']
    except json.JSONDecodeError:
        out = p.stdout.strip()[:300]
    steps.append({'step': name, 'ms': ms, 'ok': p.returncode == 0,
                  'error': (p.stderr.strip() or None) if p.returncode else None,
                  'result': out if name not in ('look',) else None})
    return p.returncode == 0, out


def wait_url(name, prev, limit=5.0):
    t0 = time.perf_counter(); url = prev
    while time.perf_counter() - t0 < limit:
        r = subprocess.run(['gaddi', '--json', 'tabs'], capture_output=True, text=True, env={**__import__('os').environ, **ENV})
        tabs = json.loads(r.stdout)['result']['tabs']
        url = next((t['url'] for t in tabs if t['id'] == tab), None)
        if url and url != prev:
            break
        time.sleep(0.05)
    changed = url != prev
    steps.append({'step': name, 'ms': round((time.perf_counter() - t0) * 1000), 'ok': changed, 'error': None if changed else 'address did not change', 'result': url})
    return url


start = time.perf_counter()
ok, opened = gaddi('open', 'open', URL, '--group', 'bench')
tab = opened['id'] if ok and isinstance(opened, dict) else None
if tab is None:
    sys.exit(f'open failed: {steps[-1]}')
try:
    ok, look = gaddi('look', 'look')
    outline = (look or {}).get('outline', '') if isinstance(look, dict) else ''
    look_chars = len(outline)
    gaddi('arm listeners', 'eval', "window.__ev=[]; for (const t of ['mousedown','click','keydown','mouseover']) document.addEventListener(t, e => window.__ev.push(t), true); 'armed'")
    gaddi('click field', 'click', '#ooui-php-1')
    _, fev = gaddi('events after click', 'eval', "({ev: window.__ev.join(','), focused: document.activeElement.id})")
    gaddi('type Zurich', 'type', '#ooui-php-1', 'Zurich')
    _, v = gaddi('read value', 'eval', "document.getElementById('ooui-php-1').value")
    typed_value = v.get('value') if isinstance(v, dict) else v
    gaddi('hover heading', 'hover', 'h1')
    gaddi('scroll wheel', 'scroll', '400')
    gaddi('scroll to footer', 'scroll', '#footer')
    gaddi('scroll to field', 'scroll', '#ooui-php-1')
    gaddi('focus field', 'click', '#ooui-php-1')
    gaddi('press Enter', 'press', 'Enter')
    after_enter = wait_url('enter navigates', URL)
    gaddi('wait results', 'eval', "new Promise(r => { const t = Date.now(); (function f() { if (document.readyState === 'complete' && document.querySelector('.mw-search-results')) r(Date.now() - t); else setTimeout(f, 50); })(); })")
    gaddi('click result', 'click', '.mw-search-results > li:first-child .mw-search-result-heading a')
    wait_url('click navigates', after_enter)
    _, where = gaddi('read url', 'eval', 'location.href')
finally:
    tab_id, tab = tab, None
    gaddi('close', 'close', str(tab_id))
total = round((time.perf_counter() - start) * 1000)
result = {'focus_click_events': fev.get('value') if isinstance(fev, dict) else fev, 'label': LABEL, 'at': time.strftime('%Y-%m-%dT%H:%M:%S%z'), 'total_ms': total,
          'typed_value': typed_value, 'look_outline_chars': look_chars,
          'final_url': where.get('value') if isinstance(where, dict) else where, 'steps': steps}
(OUT / f'{LABEL}.json').write_text(json.dumps(result, indent=1))
print(f"{LABEL}: total {total} ms · typed value {typed_value!r} · outline {look_chars} chars · click reached page: {result['focus_click_events']}")
for s in steps:
    print(f"  {s['step']:18} {s['ms']:6} ms {'ok' if s['ok'] else 'FAIL ' + str(s['error'])[:90]}")
