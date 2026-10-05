# README visuals

The logo is the shipping Chrome-extension icon. The browser screenshot and GIF run `demo.py` through the installed Gaddi CLI against the committed `demo.html`. The approval screenshot renders the shipping `ApprovalCard` from that demo's real pending action and page capture; it is an offscreen UI capture with a request-expiry annotation, not a simulated authentication result.

On a Mac with a running Gaddi installation, Xcode, Python 3, [VHS](https://github.com/charmbracelet/vhs) and its dependencies:

```sh
bash docs/media/render.sh
```

The script opens and closes its own background demo tabs and cancels the held action. A new hold can bring the native approval panel forward. Nothing is approved, sent or installed. If the optional broker capture is absent, the renderer uses a screenshot and measured button bounds from the same live tab. The screenshot expiry label is fixed for repeatable output. Review the rendered files before committing them. Browser and UI rendering can vary with Chrome, macOS, fonts and display scale.

The README uses a separate outlined Literata title and a native text introduction. `readme-header.svg` contains the browser logo and standard signature badge. It adapts to light and dark backgrounds and stops under reduced motion. The two `signature-badge-*.svg` files are exact copies of the identity master's transparent logo/castor.svg; the header generator embeds their paths and attributes unchanged.

Regenerate the header and theme-specific marks with `python3 docs/build_readme_header.py`. Regenerate the title with `python3 docs/build_readme_title.py Gaddi --output docs/media/gaddi-title.svg`, using Python with `fonttools[woff]` and [HarfBuzz](https://harfbuzz.github.io/)'s `hb-shape`. The bundled Literata font and its license are in `docs/fonts/`. Older lockups remain standalone assets.
