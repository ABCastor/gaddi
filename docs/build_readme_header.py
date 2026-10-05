#!/usr/bin/env python3
"""Regenerate the README marks from the committed browser geometry and badges."""
from pathlib import Path
import xml.etree.ElementTree as ET

HERE = Path(__file__).resolve().parent / 'media'
STYLE = '.gaddi-focus{animation:focus 7s ease-in-out infinite}.gaddi-mark{transform-origin:82px 74px;animation:mark 7s ease-in-out infinite}.castor{transform-origin:12px 12px;animation:castor 7s ease-in-out infinite}@keyframes focus{0%,12%,70%,100%{transform:translateX(0)}28%,40%{transform:translateX(4px)}}@keyframes mark{0%,30%,70%,100%{transform:rotate(0deg)}44%,54%{transform:rotate(60deg)}}@keyframes castor{0%,30%,70%,100%{transform:rotate(0deg)}44%,54%{transform:rotate(90deg)}}@media(prefers-reduced-motion:reduce){.gaddi-focus,.gaddi-mark,.castor{animation:none}}'


def badge(theme):
    source = ET.parse(HERE / f'signature-badge-{theme}.svg').getroot()
    # Paths and presentation attributes are copied directly from the master.
    return ''.join(ET.tostring(child, encoding='unicode').replace('ns0:', '').replace(':ns0', '') for child in source)


def browser(theme, transform):
    paper, ink, teal = ('#FAF9F4', '#14130F', '#006770') if theme == 'light' else ('#141311', '#E9E6DF', '#00858F')
    source = ET.parse(HERE / f'signature-badge-{theme}.svg').getroot()
    asterisk = next(path.get('d') for path in source if path.get('fill') == '#C4552A')
    return f'<g transform="{transform}"><rect x="16" y="24" width="96" height="80" rx="12" fill="{paper}" stroke="{ink}" stroke-width="8"/><path d="M16 44H112" stroke="{ink}" stroke-width="8"/><circle class="gaddi-focus" cx="46" cy="74" r="15" fill="#006770"/><g class="gaddi-mark"><path d="{asterisk}" fill="#C4552A" transform="translate(64 56) scale(1.5)"/></g></g>'


def positioned_badge(theme, x, y, size):
    return f'<svg x="{x}" y="{y}" width="{size}" height="{size}" viewBox="2.2 2.2 19.6 19.6"><g class="castor">{badge(theme)}</g></svg>'


def main():
    for theme in ('light', 'dark'):
        svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 88" role="img" aria-labelledby="title"><title id="title">Gaddi browser mark</title>'
        svg += f'<style>{STYLE}</style>' + browser(theme, 'translate(3 20) scale(.6)') + positioned_badge(theme, 69, 3, 25.344) + '</svg>\n'
        (HERE / f'header-mark-{theme}.svg').write_text(svg)
    svg = '<svg xmlns="http://www.w3.org/2000/svg" width="112" height="72" viewBox="0 0 112 72" role="img" aria-label="Gaddi browser logo"><title>Gaddi browser logo</title>'
    svg += f'<style>{STYLE}.dark{{display:none}}@media(prefers-color-scheme:dark){{.light{{display:none}}.dark{{display:inline}}}}</style><g transform="translate(14 -2) scale(.85)">'
    for theme in ('light', 'dark'):
        svg += f'<g class="{theme}"><svg viewBox="0 0 112 88" width="112" height="88">' + browser(theme, 'translate(-1.608 -3.328) scale(.672)') + positioned_badge(theme, 80, 0, 28.38528) + '</svg></g>'
    (HERE / 'readme-header.svg').write_text(svg + '</g></svg>\n')
    # One editable source also supplies the extension's static browser icon.
    icon = '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">'
    icon += '<rect x="6" y="6" width="116" height="116" rx="24" fill="#FAF9F4"/>' + browser('light', 'translate(0 0)') + '</svg>\n'
    (HERE / 'extension-icon.svg').write_text(icon)


if __name__ == '__main__':
    main()
