import AppKit
import CoreText

/// The approval panel's visual system: Castor's paper, ink and two hues. The warm
/// terracotta is the human (the decision, the mark on the page); the cold teal is the
/// machine (the agent asking). Body text is always ink.
enum Palette {
    private static func tone(_ light: UInt32, _ dark: UInt32) -> NSColor {
        func rgb(_ hex: UInt32) -> NSColor {
            NSColor(srgbRed: CGFloat(hex >> 16 & 0xff) / 255, green: CGFloat(hex >> 8 & 0xff) / 255,
                    blue: CGFloat(hex & 0xff) / 255, alpha: 1)
        }
        return NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? rgb(dark) : rgb(light)
        }
    }
    static let paper = tone(0xFAF9F4, 0x141311)
    static let ink = tone(0x14130F, 0xE9E6DF)
    static let inkSoft = tone(0x54534E, 0xA29F9A)
    static let rule = tone(0xCBCAC5, 0x383633)
    static let ruleStrong = tone(0xA3A29D, 0x585652)
    static let human = tone(0xC4552A, 0xC4552A)
    static let humanPressed = tone(0xA8461F, 0xD7663A)
    static let machine = tone(0x006770, 0x00858F)
    static let washHuman = tone(0xF7EAE2, 0x221914)
    /// Paper that does not follow the theme: it sits on the fixed terracotta, and on
    /// captures of web pages, which are light whatever the Mac is set to.
    static let onWarm = tone(0xFAF9F4, 0xFAF9F4)
}

/// Bundled faces (SIL OFL, notices in Resources/Fonts/OFL.txt). Every face falls back
/// to the system font, so a missing file changes the look, never the function.
enum Typeface {
    static func register(_ directory: URL?) {
        guard let directory, let files = try? FileManager.default.contentsOfDirectory(at: directory,
            includingPropertiesForKeys: nil) else { return }
        for file in files where file.pathExtension == "ttf" {
            CTFontManagerRegisterFontsForURL(file as CFURL, .process, nil)
        }
    }
    private static func face(_ name: String, _ size: CGFloat, _ axes: [UInt32: CGFloat], fallback: NSFont) -> NSFont {
        let variation = Dictionary(uniqueKeysWithValues: axes.map { (NSNumber(value: $0.key), NSNumber(value: Double($0.value))) })
        let descriptor = NSFontDescriptor(fontAttributes: [.name: name,
            NSFontDescriptor.AttributeName(rawValue: kCTFontVariationAttribute as String): variation])
        // A varied instance reports its own generated name, so availability is
        // checked against the registered face rather than the resolved one.
        guard NSFont(name: name, size: size) != nil, let font = NSFont(descriptor: descriptor, size: size) else { return fallback }
        return font
    }
    private static let weight: UInt32 = 0x7767_6874, opticalSize: UInt32 = 0x6f70_737a
    static func heading(_ size: CGFloat) -> NSFont {
        face("Literata-Regular", size, [weight: 520, opticalSize: size], fallback: .systemFont(ofSize: size, weight: .semibold))
    }
    static func interface(_ size: CGFloat, _ value: CGFloat = 400) -> NSFont {
        face("CommissionerThin-Regular", size, [weight: value], fallback: .systemFont(ofSize: size))
    }
    static func figures(_ size: CGFloat) -> NSFont {
        face("MartianMonoSemiExpanded-Regular", size, [weight: 420], fallback: .monospacedDigitSystemFont(ofSize: size, weight: .regular))
    }
}

/// A flat, rounded button in the panel's palette. It stays an NSButton, so keyboard
/// focus, accessibility and actions behave like any other button.
final class PanelButton: NSButton {
    enum Kind { case primary, secondary, quiet }
    private let kind: Kind
    private var handler: (() -> Void)?
    private var hovering = false { didSet { needsDisplay = true } }
    init(_ title: String, kind: Kind, symbol: String? = nil, action: @escaping () -> Void) {
        self.kind = kind; handler = action
        super.init(frame: .zero)
        self.title = title; isBordered = false; target = self; self.action = #selector(invoke)
        focusRingType = .exterior
        if let symbol, let image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil) {
            self.image = image.withSymbolConfiguration(.init(pointSize: 14, weight: .medium)); imagePosition = .imageLeading
        }
        font = Typeface.interface(14, kind == .primary ? 600 : 500)
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeInActiveApp, .inVisibleRect],
                                       owner: self, userInfo: nil))
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }
    @objc private func invoke() { handler?() }
    override func mouseEntered(with event: NSEvent) { hovering = true }
    override func mouseExited(with event: NSEvent) { hovering = false }
    override var intrinsicContentSize: NSSize {
        let label = (title as NSString).size(withAttributes: [.font: font as Any])
        let icon: CGFloat = image == nil ? 0 : 22
        return NSSize(width: ceil(label.width + icon + (kind == .quiet ? 4 : 36)), height: kind == .quiet ? 22 : 38)
    }
    private var shape: NSBezierPath { NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: 9, yRadius: 9) }
    override func draw(_ dirtyRect: NSRect) {
        let pressed = isHighlighted
        let text: NSColor
        switch kind {
        case .primary:
            (pressed || hovering ? Palette.humanPressed : Palette.human).setFill(); shape.fill()
            text = Palette.onWarm
        case .secondary:
            (pressed ? Palette.rule : hovering ? Palette.washHuman : Palette.paper).setFill(); shape.fill()
            Palette.ruleStrong.setStroke(); shape.lineWidth = 1; shape.stroke()
            text = Palette.ink
        case .quiet:
            text = hovering || pressed ? Palette.ink : Palette.machine
        }
        let alpha: CGFloat = isEnabled ? 1 : 0.45
        let attributes: [NSAttributedString.Key: Any] = [.font: font as Any, .foregroundColor: text.withAlphaComponent(alpha)]
        let label = NSAttributedString(string: title, attributes: attributes)
        let size = label.size()
        var x = (bounds.width - size.width) / 2
        if let image {
            let tinted = NSImage(size: image.size, flipped: false) { rect in
                image.draw(in: rect); text.withAlphaComponent(alpha).set(); rect.fill(using: .sourceAtop); return true
            }
            x += 11
            tinted.draw(in: NSRect(x: x - 22, y: (bounds.height - image.size.height) / 2, width: image.size.width, height: image.size.height))
        }
        label.draw(at: NSPoint(x: x, y: (bounds.height - size.height) / 2))
    }
    override func drawFocusRingMask() { shape.fill() }
    override var focusRingMaskBounds: NSRect { bounds }
}

/// Coordinates come from the broker in JPEG pixels, with a top-left origin.
/// Only the raster is loaded from disk; the app draws the target outline itself,
/// so nothing the page renders can move or fake the mark.
final class ApprovalPictureView: NSView {
    private let picture: NSImage
    private let pixels: NSSize
    private let box: ApprovalBox
    override var isFlipped: Bool { true }
    init?(_ approval: Approval) {
        guard let path = approval.imagePath, let box = approval.box,
              let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
              data.starts(with: [0xff, 0xd8]), let bitmap = NSBitmapImageRep(data: data), let raster = bitmap.cgImage,
              raster.width > 0, raster.height > 0,
              box.x + box.width <= Double(raster.width), box.y + box.height <= Double(raster.height) else { return nil }
        pixels = NSSize(width: raster.width, height: raster.height)
        picture = NSImage(cgImage: raster, size: pixels); self.box = box
        super.init(frame: .zero)
        setAccessibilityLabel("Page capture with the action target outlined")
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }
    override var intrinsicContentSize: NSSize { NSSize(width: NSView.noIntrinsicMetric, height: min(360, pixels.height)) }
    /// Follow the capture's aspect ratio at the available card width, up to the
    /// panel's height budget. A wide capture must not reserve an empty tall slot.
    func constrainHeight() {
        let aspect = heightAnchor.constraint(equalTo: widthAnchor, multiplier: pixels.height / pixels.width)
        aspect.priority = .defaultHigh
        NSLayoutConstraint.activate([aspect, heightAnchor.constraint(lessThanOrEqualToConstant: intrinsicContentSize.height)])
    }
    /// The target's rectangle in view coordinates, for drawing and for tests.
    func targetFrame(in bounds: NSRect) -> (image: NSRect, target: NSRect)? {
        let scale = min(bounds.width / pixels.width, bounds.height / pixels.height)
        guard scale > 0 else { return nil }
        let image = NSRect(x: (bounds.width - pixels.width * scale) / 2, y: (bounds.height - pixels.height * scale) / 2,
                           width: pixels.width * scale, height: pixels.height * scale)
        let target = NSRect(x: image.minX + box.x * scale, y: image.minY + box.y * scale,
                            width: box.width * scale, height: box.height * scale)
        return (image, target)
    }
    static let ringOffset: CGFloat = 6
    override func draw(_ dirtyRect: NSRect) {
        guard let (image, target) = targetFrame(in: bounds) else { return }
        NSGraphicsContext.saveGraphicsState()
        let frame = NSBezierPath(roundedRect: image, xRadius: 10, yRadius: 10)
        frame.addClip()
        picture.draw(in: image, from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
        // Quiet the page around the target so the eye lands where the click will.
        let ring = target.insetBy(dx: -Self.ringOffset, dy: -Self.ringOffset)
        let veil = NSBezierPath(rect: image)
        veil.append(NSBezierPath(roundedRect: ring, xRadius: 8, yRadius: 8)); veil.windingRule = .evenOdd
        Palette.onWarm.withAlphaComponent(0.55).setFill(); veil.fill()
        let mark = NSBezierPath(roundedRect: ring, xRadius: 8, yRadius: 8)
        Palette.onWarm.setStroke(); mark.lineWidth = 7; mark.stroke()
        Palette.human.setStroke(); mark.lineWidth = 2.5; mark.stroke()
        NSGraphicsContext.restoreGraphicsState()
        Palette.rule.setStroke(); frame.lineWidth = 1; frame.stroke()
    }
}

/// Plain words for what the broker holds. The raw reason stays available to
/// accessibility and to anyone reading the audit, never hidden.
enum ApprovalWords {
    private static func clickParts(_ detail: String) -> (name: String, destination: String?) {
        if let separator = detail.range(of: " -> ") {
            return (String(detail[..<separator.lowerBound]).trimmingCharacters(in: .whitespacesAndNewlines),
                    String(detail[separator.upperBound...]))
        }
        // Also recognize a detail whose leading whitespace has been trimmed.
        if detail.hasPrefix("-> ") { return ("", String(detail.dropFirst(3))) }
        return (detail.trimmingCharacters(in: .whitespacesAndNewlines), nil)
    }
    static func title(_ approval: Approval) -> (verb: String, object: String) {
        let name = clickParts(approval.detail).name
        switch approval.kind {
        case "signin": return ("sign in with", "“\(name)”")
        case "click": return ("click", name.isEmpty ? "an unnamed control" : "“\(name)”")
        case "press": return ("press", name.isEmpty ? "a key" : name)
        case "open": return ("open", "a new tab")
        case "goto": return ("navigate", "this tab")
        case "eval": return ("run", "a script")
        case "extension.disable": return ("disable extension", "“\(name)”")
        case "extension.uninstall": return ("remove extension", "“\(name)”")
        case "extension.install": return ("install extension", "“\(name)”")
        default: return (approval.kind, "“\(name)”")
        }
    }
    static func destination(_ approval: Approval) -> String? {
        guard approval.kind == "click", let destination = clickParts(approval.detail).destination else { return nil }
        return host(destination)
    }
    static func place(_ approval: Approval) -> String {
        if approval.kind.hasPrefix("extension.") { return "in Chrome" }
        if approval.canRemember, let site = approval.site { return "on \(site)" }
        if ["open", "goto"].contains(approval.kind) { return "to \(host(approval.detail))" }
        let source = "on \(host(approval.url))"
        return destination(approval).map { "\(source), which leads to \($0)" } ?? source
    }
    static func host(_ text: String) -> String {
        guard let url = URL(string: text), let host = url.host else { return text }
        let port = url.port.map { ":\($0)" } ?? ""
        let path = url.path.count > 1 ? url.path : ""
        return host.replacingOccurrences(of: "www.", with: "") + port + path
    }
    static func reason(_ reason: String) -> String {
        func after(_ prefix: String) -> String? { reason.hasPrefix(prefix) ? String(reason.dropFirst(prefix.count)) : nil }
        if let word = after("verb:") { return "Held because its name contains “\(word)”." }
        if let word = after("enter-submits:") { return "Held because Enter would activate a button or link with “\(word)” in its name." }
        if after("url-pattern:") != nil { return "Held because this address is on the protected list." }
        if let key = after("key:") { return "Held because \(key.components(separatedBy: " on ").first ?? key) is guarded on this site." }
        return "Held because this action needs your approval."
    }
}

/// One held action: what the agent wants, where, what it looks like, and the decision.
final class ApprovalCard: NSStackView {
    init(_ approval: Approval, enabled: Bool, decide: @escaping (String) -> Void) {
        super.init(frame: .zero)
        orientation = .vertical; alignment = .leading; spacing = 0
        let words = ApprovalWords.title(approval)
        let headingFont = Typeface.heading(22)
        let title = NSMutableAttributedString(string: approval.caller, attributes: [
            .font: headingFont, .foregroundColor: Palette.machine])
        title.append(NSAttributedString(string: " wants to \(words.verb) \(words.object)", attributes: [
            .font: headingFont, .foregroundColor: Palette.ink]))
        let paragraph = NSMutableParagraphStyle()
        // AppKit rounds a fractional multiline height down, which can leave its
        // final line unpainted. Keep the existing leading on a whole-point grid.
        paragraph.minimumLineHeight = ceil((headingFont.ascender - headingFont.descender + headingFont.leading) * 1.08)
        paragraph.maximumLineHeight = paragraph.minimumLineHeight
        title.addAttribute(.paragraphStyle, value: paragraph, range: NSRange(location: 0, length: title.length))
        let heading = NSTextField(wrappingLabelWithString: ""); heading.attributedStringValue = title
        heading.lineBreakMode = .byWordWrapping; heading.maximumNumberOfLines = 0; heading.isSelectable = true
        heading.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        let place = NSAttributedString(string: ApprovalWords.place(approval), attributes: [
            .font: Typeface.interface(13), .foregroundColor: Palette.inkSoft])
        let where_ = NSTextField(wrappingLabelWithString: ""); where_.attributedStringValue = place
        where_.lineBreakMode = .byWordWrapping; where_.maximumNumberOfLines = 0; where_.isSelectable = true
        where_.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let until = NSTextField(labelWithString: approval.expiresAt.map { "until \(displayTime($0))" } ?? "")
        until.font = Typeface.figures(12); until.textColor = Palette.inkSoft
        until.setContentHuggingPriority(.required, for: .horizontal)
        let meta = NSStackView(views: [where_, until]); meta.distribution = .fill; meta.spacing = 16; meta.alignment = .top

        let because = NSTextField(wrappingLabelWithString: ApprovalWords.reason(approval.reason))
        because.font = Typeface.interface(13); because.textColor = Palette.inkSoft
        because.setAccessibilityHelp(approval.reason)

        let deny = PanelButton("Deny", kind: .secondary) { decide("deny") }
        let approve = PanelButton(approval.canRemember ? "Allow once" : "Approve with Touch ID", kind: .primary, symbol: "touchid") { decide("grant") }
        deny.isEnabled = enabled; approve.isEnabled = enabled
        let spacer = NSView(); spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        let actions = NSStackView(views: [spacer, deny, approve]); actions.spacing = 10

        addArrangedSubview(heading); setCustomSpacing(6, after: heading)
        addArrangedSubview(meta); setCustomSpacing(18, after: meta)
        if let picture = ApprovalPictureView(approval) {
            addArrangedSubview(picture); setCustomSpacing(12, after: picture)
            picture.widthAnchor.constraint(equalTo: widthAnchor).isActive = true
            picture.constrainHeight()
        }
        addArrangedSubview(because); setCustomSpacing(22, after: because)
        addArrangedSubview(actions)
        if approval.canRemember {
            // The image-bearing NSButton extends one point below its alignment rectangle.
            edgeInsets = NSEdgeInsets(top: 0, left: 0, bottom: 1, right: 0)
            let remember = PanelButton("Always allow on this site", kind: .primary, symbol: "touchid") { decide("remember") }
            remember.isEnabled = enabled && approval.site != nil
            let row = NSStackView(views: [NSView(), remember]); row.spacing = 10
            setCustomSpacing(10, after: actions); addArrangedSubview(row)
            row.widthAnchor.constraint(equalTo: widthAnchor).isActive = true
        }
        for view in [heading, meta, because, actions] { view.widthAnchor.constraint(equalTo: widthAnchor).isActive = true }
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }
}

final class RememberedSigninList: NSStackView {
    init(_ sites: [String], enabled: Bool, revoke: @escaping (String) -> Void) {
        super.init(frame: .zero)
        orientation = .vertical; alignment = .leading; spacing = 12
        let heading = NSTextField(labelWithString: "Remembered sign-ins")
        heading.font = Typeface.heading(18); heading.textColor = Palette.ink
        addArrangedSubview(heading)
        let explanation = NSTextField(wrappingLabelWithString: sites.isEmpty
            ? "No sites are remembered. Sign-ins wait for your approval."
            : "Sign-ins on these exact sites run without asking. Revoke to require approval again.")
        explanation.font = Typeface.interface(13); explanation.textColor = Palette.inkSoft
        addArrangedSubview(explanation)
        explanation.widthAnchor.constraint(equalTo: widthAnchor).isActive = true
        for site in sites {
            let label = NSTextField(wrappingLabelWithString: site)
            label.font = Typeface.interface(13); label.textColor = Palette.ink; label.isSelectable = true
            label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
            let button = PanelButton("Revoke", kind: .secondary) { revoke(site) }
            button.isEnabled = enabled
            let row = NSStackView(views: [label, button]); row.spacing = 12; row.alignment = .centerY
            addArrangedSubview(row); row.widthAnchor.constraint(equalTo: widthAnchor).isActive = true
        }
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }
}

final class RememberedSendList: NSStackView {
    init(_ rules: [SendPermission], enabled: Bool, revoke: @escaping (SendPermission) -> Void) {
        super.init(frame: .zero)
        orientation = .vertical; alignment = .leading; spacing = 12
        let heading = NSTextField(labelWithString: "Remembered sends")
        heading.font = Typeface.heading(18); heading.textColor = Palette.ink
        addArrangedSubview(heading)
        let explanation = NSTextField(wrappingLabelWithString: rules.isEmpty
            ? "No sends are remembered. Sending waits for your approval."
            : "Only these send actions on these exact sites run without asking. Revoke to require approval again.")
        explanation.font = Typeface.interface(13); explanation.textColor = Palette.inkSoft
        addArrangedSubview(explanation)
        explanation.widthAnchor.constraint(equalTo: widthAnchor).isActive = true
        for rule in rules {
            let label = NSTextField(wrappingLabelWithString: "\(rule.site)\n\(rule.label) (\(rule.reason.components(separatedBy: ":").last ?? "send"))")
            label.font = Typeface.interface(13); label.textColor = Palette.ink; label.isSelectable = true
            label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
            let button = PanelButton("Revoke", kind: .secondary) { revoke(rule) }
            button.isEnabled = enabled
            let row = NSStackView(views: [label, button]); row.spacing = 12; row.alignment = .centerY
            addArrangedSubview(row); row.widthAnchor.constraint(equalTo: widthAnchor).isActive = true
        }
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }
}

/// The same pending-action body serves the live panel and the offscreen harness.
final class ApprovalList: NSStackView {
    init(_ approvals: [Approval], enabled: Bool, decide: @escaping (Approval, String) -> Void) {
        super.init(frame: .zero)
        orientation = .vertical; alignment = .leading; spacing = 28
        func add(_ view: NSView) {
            addArrangedSubview(view)
            view.widthAnchor.constraint(equalTo: widthAnchor).isActive = true
        }
        if approvals.isEmpty {
            let empty = NSTextField(wrappingLabelWithString: "Nothing is waiting for you. Actions that need your approval appear here.")
            empty.font = Typeface.interface(14); empty.textColor = Palette.inkSoft; add(empty)
        }
        for (index, approval) in approvals.enumerated() {
            if index > 0 { add(PanelRule()) }
            add(ApprovalCard(approval, enabled: enabled && !approval.expired) { decide(approval, $0) })
        }
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }
}

/// The menu-bar mark: the browser window an agent works in, with the agent's dot
/// inside it. Drawn as a template so macOS tints it for the menu bar it lands in.
enum StatusMark {
    static func image() -> NSImage {
        let size = NSSize(width: 18, height: 16)
        let mark = NSImage(size: size, flipped: false) { _ in
            let window = NSBezierPath(roundedRect: NSRect(x: 1.5, y: 1.5, width: 15, height: 13), xRadius: 3, yRadius: 3)
            window.lineWidth = 1.4
            NSColor.black.setStroke(); window.stroke()
            let bar = NSBezierPath()
            bar.move(to: NSPoint(x: 1.8, y: 11)); bar.line(to: NSPoint(x: 16.2, y: 11))
            bar.lineWidth = 1.2; bar.stroke()
            NSBezierPath(ovalIn: NSRect(x: 7, y: 4.4, width: 4.2, height: 4.2)).fill()
            return true
        }
        mark.isTemplate = true
        mark.accessibilityDescription = "Gaddi"
        return mark
    }
}

/// A calm line of state (disconnected, key missing, an error) above the approvals.
final class PanelNote: NSTextField {
    init(_ text: String) {
        super.init(frame: .zero)
        stringValue = text; isEditable = false; isSelectable = true; isBordered = false
        drawsBackground = true; backgroundColor = Palette.washHuman
        font = Typeface.interface(13); textColor = Palette.ink
        lineBreakMode = .byWordWrapping; cell?.wraps = true
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }
}

/// The ruled separator between two held actions.
final class PanelRule: NSBox {
    init() {
        super.init(frame: .zero)
        boxType = .custom; borderWidth = 0; fillColor = Palette.rule
        heightAnchor.constraint(equalToConstant: 1).isActive = true
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }
}
