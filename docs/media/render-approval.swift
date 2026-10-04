import AppKit

// Annotate the request expiry on the shipping approval card from the disposable demo's real pending action.
final class ExpiryAnnotation: NSView {
    var target = NSPoint.zero
    override func draw(_ dirtyRect: NSRect) {
        let labelY = bounds.height - 36
        ("Request expires at 13:10" as NSString).draw(at: NSPoint(x: 32, y: labelY),
            withAttributes: [.font: Typeface.interface(14), .foregroundColor: Palette.ink])
    }
}

@main struct ReadmeCapture {
    static func main() throws {
        _ = NSApplication.shared
        let args = CommandLine.arguments
        let data = try Data(contentsOf: URL(fileURLWithPath: args[1]))
        guard var object = try JSONSerialization.jsonObject(with: data) as? JSONObject else { fatalError("Invalid fixture") }
        // Fix the expiry label so a regenerated screenshot does not change with the clock.
        object["expiresAt"] = ISO8601DateFormatter().date(from: "2026-01-01T12:10:00Z")!.timeIntervalSince1970 * 1000
        guard let approval = Approval(object), approval.imagePath != nil, approval.box != nil else { fatalError("Approval capture missing") }
        Typeface.register(URL(fileURLWithPath: args[2], isDirectory: true))
        let appearance = NSAppearance(named: .aqua)!
        let card = ApprovalCard(approval, enabled: true) { _ in }
        card.appearance = appearance
        card.widthAnchor.constraint(equalToConstant: 528).isActive = true
        card.frame = NSRect(x: 32, y: 32, width: 528, height: card.fittingSize.height)
        card.layoutSubtreeIfNeeded()
        let page = NSView(frame: NSRect(x: 0, y: 0, width: 592, height: card.frame.height + 116))
        page.appearance = appearance; page.wantsLayer = true; page.addSubview(card)
        page.layoutSubtreeIfNeeded()
        card.setFrameSize(NSSize(width: 528, height: card.fittingSize.height))
        page.setFrameSize(NSSize(width: 592, height: card.frame.height + 116))
        func descendants(_ view: NSView) -> [NSView] { view.subviews.flatMap { [$0] + descendants($0) } }
        if let deadline = descendants(card).compactMap({ $0 as? NSTextField }).first(where: { $0.stringValue.hasPrefix("until ") }) {
            let overlay = ExpiryAnnotation(frame: page.bounds)
            overlay.target = deadline.convert(NSPoint(x: deadline.bounds.maxX + 5, y: deadline.bounds.midY), to: page)
            page.addSubview(overlay)
        }
        let shot = page.bitmapImageRepForCachingDisplay(in: page.bounds)!
        appearance.performAsCurrentDrawingAppearance {
            page.layer?.backgroundColor = Palette.paper.cgColor
            page.cacheDisplay(in: page.bounds, to: shot)
        }
        try shot.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: args[3]))
        print("Rendered the current ApprovalCard, \(shot.pixelsWide)x\(shot.pixelsHigh).")
    }
}
