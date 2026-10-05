#!/usr/bin/env python3
"""Check release metadata and reproduce the header from its source badges."""
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import sys
import tempfile
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[2]
MEDIA = ROOT / 'docs/media'
NS = '{http://www.w3.org/2000/svg}'


def main():
    sys.dont_write_bytecode = True
    package = json.loads((ROOT / 'package.json').read_text())
    lock = json.loads((ROOT / 'package-lock.json').read_text())
    assert package['license'] == lock['packages']['']['license'] == 'Apache-2.0', 'license metadata differs'
    assert 'Version 2.0, January 2004' in (ROOT / 'LICENSE').read_text(), 'Apache license missing'
    assert 'Mozilla Public License' in (ROOT / 'docs/licenses/MPL-2.0.txt').read_text(), 'PSL license missing'
    assert (ROOT / 'docs/licenses/MIT-previous.txt').read_text().startswith('MIT License'), 'previous MIT notice missing'
    readme = (ROOT / 'README.md').read_text()
    assert '[Apache-2.0](LICENSE)' in readme and '[NOTICE](NOTICE)' in readme, 'README license boundary missing'
    assert 'https://github.com/ABCastor/omniread' in readme, 'extractor link missing'
    assert 'gaddi-title.svg' in readme and 'readme-header.svg' in readme, 'separate title and mark missing'
    for theme in ('light', 'dark'):
        source = ET.parse(MEDIA / f'signature-badge-{theme}.svg').getroot()
        assert hashlib.sha256((MEDIA / f'signature-badge-{theme}.svg').read_bytes()).hexdigest() == 'cfcb09d8fe68d8728d2d5e3f8e531ea9a58d65211640fd6e4f521b4cf139d1e2', 'badge differs from canonical logo/castor.svg'
        assert source.get('viewBox') == '2.2 2.2 19.6 19.6', 'canonical badge viewport differs'
    spec = importlib.util.spec_from_file_location('header', ROOT / 'docs/build_readme_header.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    with tempfile.TemporaryDirectory(prefix='gaddi-packaging-') as directory:
        module.HERE = Path(directory)
        for theme in ('light', 'dark'):
            shutil.copyfile(MEDIA / f'signature-badge-{theme}.svg', module.HERE / f'signature-badge-{theme}.svg')
        module.main()
        for name in ('readme-header.svg', 'header-mark-light.svg', 'header-mark-dark.svg', 'extension-icon.svg'):
            assert (MEDIA / name).read_bytes() == (module.HERE / name).read_bytes(), f'{name} differs from its source'
    print('PASS packaging: licenses, README links and reproducible canonical-badge headers')


if __name__ == '__main__':
    main()
