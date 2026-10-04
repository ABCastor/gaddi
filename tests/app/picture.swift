import AppKit

@main struct PictureChecks {
    static func main() throws {
        _ = NSApplication.shared
        var passed = 0
        func check(_ condition: Bool, _ label: String) {
            guard condition else { fputs("FAIL \(label)\n", stderr); exit(1) }
            passed += 1; print("PASS \(label)")
        }
        let directory = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
        let path = directory.appendingPathComponent("fixture.jpg")
        let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 400, pixelsHigh: 200,
            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
            colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        for y in 0..<200 { for x in 0..<400 {
            let target = x >= 40 && x < 120 && y >= 30 && y < 80
            let offset = y * bitmap.bytesPerRow + x * 4
            bitmap.bitmapData![offset] = 0
            bitmap.bitmapData![offset + 1] = target ? 255 : 0
            bitmap.bitmapData![offset + 2] = target ? 0 : 255
            bitmap.bitmapData![offset + 3] = 255
        } }
        try bitmap.representation(using: .jpeg, properties: [.compressionFactor: 0.9])!.write(to: path)
        var object: JSONObject = ["id": "picture", "kind": "click", "detail": "Pay", "imagePath": path.path,
            "box": ["x": 40, "y": 30, "width": 80, "height": 50]]
        guard let view = ApprovalPictureView(Approval(object)!) else { fatalError("valid JPEG rejected") }
        for (width, height) in [(400, 200), (200, 160), (600, 200)] {
            view.frame = NSRect(x: 0, y: 0, width: width, height: height)
            let rendered = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height,
                bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
            let context = NSGraphicsContext(bitmapImageRep: rendered)!
            NSGraphicsContext.saveGraphicsState()
            context.cgContext.translateBy(x: 0, y: CGFloat(height))
            context.cgContext.scaleBy(x: 1, y: -1)
            NSGraphicsContext.current = NSGraphicsContext(cgContext: context.cgContext, flipped: true)
            view.draw(view.bounds)
            NSGraphicsContext.restoreGraphicsState()
            try rendered.representation(using: .png, properties: [:])!.write(to: directory.appendingPathComponent("render-\(width).png"))
            guard let frames = view.targetFrame(in: view.bounds) else { fatalError("no target frame") }
            func color(_ x: Double, _ y: Double) -> NSColor {
                rendered.colorAt(x: Int(x), y: Int(y))!.usingColorSpace(.sRGB)!
            }
            let target = color(frames.target.midX, frames.target.midY)
            check(target.greenComponent > 0.7 && target.redComponent < 0.3,
                  "the target keeps the page's own colours at \(width)px")
            let ring = frames.target.insetBy(dx: -ApprovalPictureView.ringOffset, dy: -ApprovalPictureView.ringOffset)
            let mark = color(ring.minX, frames.target.midY)
            check(mark.redComponent > 0.6 && mark.greenComponent < 0.45 && mark.blueComponent < 0.3,
                  "the app draws its warm mark around the target at \(width)px")
            let halo = color(ring.minX - 2.6, frames.target.midY)
            check(halo.redComponent > 0.85 && halo.greenComponent > 0.85 && halo.blueComponent > 0.85,
                  "a light halo separates the mark from the page at \(width)px")
            let surround = color(frames.image.midX + frames.image.width * 0.35, frames.image.midY)
            check(surround.blueComponent > 0.7 && surround.blueComponent - surround.redComponent > 0.3,
                  "the page around the target stays readable, quieted at \(width)px")
        }
        object.removeValue(forKey: "box")
        check(ApprovalPictureView(Approval(object)!) == nil, "missing box uses old panel")
        object["box"] = ["x": 390, "y": 0, "width": 20, "height": 10]
        check(ApprovalPictureView(Approval(object)!) == nil, "out-of-image box uses old panel")
        object["box"] = ["x": 40, "y": 30, "width": 80, "height": 50]
        object["imagePath"] = directory.appendingPathComponent("missing.jpg").path
        check(ApprovalPictureView(Approval(object)!) == nil, "missing image uses old panel")
        let broken = directory.appendingPathComponent("broken.jpg")
        try Data([0xff, 0xd8, 0, 0]).write(to: broken); object["imagePath"] = broken.path
        check(ApprovalPictureView(Approval(object)!) == nil, "unreadable image uses old panel")
        print("== app picture: \(passed) passed, 0 failed")
    }
}
