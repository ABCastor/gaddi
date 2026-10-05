#!/usr/bin/env python3
"""Build an outlined product title with the Literata signature asterisk.

Usage: python3 docs/build_readme_title.py "Product name" [--font FONT] [--output SVG]
Requires Python 3.9+, fonttools[woff] and HarfBuzz's hb-shape on PATH.
The bundled font defaults to docs/fonts/literata.woff2. Crossfeed's descriptor
uses its quieter 400-weight treatment; other product names use weight 560.
"""
from io import BytesIO
import argparse
import json
import math
from pathlib import Path
import subprocess
from xml.sax.saxutils import escape

from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.roundingPen import RoundingPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

HERE = Path(__file__).resolve().parent
DEFAULT_FONT = HERE / 'fonts/literata.woff2'
if not DEFAULT_FONT.is_file():
    DEFAULT_FONT = HERE.parent / 'fonts/literata.woff2'
SIZE = 34
HEIGHT = 40
TRACKING = -.055 * SIZE
STAR_GAP = .1 * SIZE
OPSZ = 72
THEME = ':root{--ink:#14130f;--quiet:#4d493f}@media(prefers-color-scheme:dark){:root{--ink:#e9e6df;--quiet:#bdb8b0}}'


def number(value):
    return f'{value:.3f}'.rstrip('0').rstrip('.') or '0'


def segment(text, weight, start, base_font, font_bytes, tracking):
    locations = {'wght': weight, 'opsz': OPSZ}
    font = instantiateVariableFont(base_font, locations, inplace=False)
    glyphs = font.getGlyphSet()
    order = font.getGlyphOrder()
    shaped = json.loads(subprocess.check_output([
        'hb-shape', '--variations=' + ','.join(f'{k}={v}' for k, v in locations.items()),
        '--no-glyph-names', '--output-format=json', '/dev/stdin', text,
    ], input=font_bytes))
    records = []
    scale = SIZE / base_font['head'].unitsPerEm
    x = start
    for glyph in shaped:
        name = order[glyph['g']]
        transform = (scale, 0, 0, -scale,
                     x + glyph['dx'] * scale, -glyph['dy'] * scale)
        pen = BoundsPen(glyphs)
        glyphs[name].draw(TransformPen(pen, transform))
        records.append((glyphs, name, transform, pen.bounds))
        x += glyph['ax'] * scale + tracking
    return records, x


def build(label, font_path):
    font = TTFont(font_path, recalcTimestamp=False)
    font.flavor = None
    stream = BytesIO()
    font.save(stream)
    groups = []
    x = 0
    parts = [(label, 560, 'var(--ink)', TRACKING)]
    if label.startswith('Crossfeed '):
        parts = [('Crossfeed ', 560, 'var(--ink)', TRACKING),
                 (label[len('Crossfeed '):], 400, 'var(--quiet)', TRACKING)]
    parts.append(('*', 560, '#c4552a', 0))
    for text, weight, color, tracking in parts:
        if text == '*':
            x += STAR_GAP
        records, x = segment(text, weight, x, font, stream.getvalue(), tracking)
        groups.append((color, records))
    bounds = [record[3] for _, records in groups for record in records if record[3]]
    left = min(b[0] for b in bounds)
    top = min(b[1] for b in bounds)
    right = max(b[2] for b in bounds)
    bottom = max(b[3] for b in bounds)
    shift_x = 2 - left
    baseline = HEIGHT / 2 - (top + bottom) / 2
    width = math.ceil(right + shift_x + 2)
    paths = []
    for color, records in groups:
        pen = SVGPathPen(None, ntos=number)
        for glyphs, name, transform, _ in records:
            xx, xy, yx, yy, tx, ty = transform
            target = RoundingPen(pen, roundFunc=lambda v: round(v, 3))
            glyphs[name].draw(TransformPen(target, (xx, xy, yx, yy, tx + shift_x, ty + baseline)))
        paths.append(f'<path fill="{color}" d="{pen.getCommands()}"/>')
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{HEIGHT}" '
            f'viewBox="0 0 {width} {HEIGHT}" role="img" aria-labelledby="title">'
            f'<title id="title">{escape(label + chr(42))}</title><style>{THEME}</style>'
            + ''.join(paths) + '</svg>\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('title', help='Product name without the signature asterisk')
    parser.add_argument('--font', type=Path, default=DEFAULT_FONT)
    parser.add_argument('--output', type=Path, default=HERE / 'readme-title.svg')
    parser.add_argument('--stdout', action='store_true', help='Print SVG without writing the title image')
    args = parser.parse_args()
    svg = build(args.title, args.font)
    if args.stdout:
        print(svg, end='')
    else:
        args.output.write_text(svg, encoding='utf-8')
        print(f'{args.output.name}: {len(svg.encode())} bytes')


if __name__ == '__main__':
    main()
