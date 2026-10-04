# README visuals

The logo is the shipping Chrome-extension icon. The browser screenshot and GIF run `demo.py` through the installed Gaddi CLI against the committed `demo.html`. The approval screenshot renders the shipping `ApprovalCard` from that demo's real pending action and page capture; it is an offscreen UI capture with a request-expiry annotation, not a simulated authentication result.

On a Mac with a running Gaddi installation, Xcode, Python 3, [VHS](https://github.com/charmbracelet/vhs) and its dependencies:

```sh
bash docs/media/render.sh
```

The script opens and closes its own background demo tabs and cancels the held action. A new hold can bring the native approval panel forward. Nothing is approved, sent or installed. If the optional broker capture is absent, the renderer uses a screenshot and measured button bounds from the same live tab. The screenshot expiry label is fixed for repeatable output. Review the rendered files before committing them. Browser and UI rendering can vary with Chrome, macOS, fonts and display scale.

The README lockup uses the app icon and outlined Literata lettering. Its SVG motion rests between cycles and stops when reduced motion is requested. Literata and its license are included in `app/Fonts/`.
