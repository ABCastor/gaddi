import AppKit

/// Renders the approval card offscreen in both appearances and checks what a reader
/// would see: the bundled faces resolve, the ground is paper, the decision is warm,
/// and the raw policy reason never reaches the panel as machine text.
@main struct CardChecks {
    static func main() throws {
        _ = NSApplication.shared
        var passed = 0
        func check(_ condition: Bool, _ label: String) {
            guard condition else { fputs("FAIL \(label)\n", stderr); exit(1) }
            passed += 1; print("PASS \(label)")
        }
        let directory = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
        let fonts = URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true)
        Typeface.register(fonts)
        check(Typeface.heading(22).familyName == "Literata", "heading uses the bundled Literata")
        check(Typeface.interface(13).familyName?.hasPrefix("Commissioner") == true, "interface text uses the bundled Commissioner")
        check(Typeface.figures(12).familyName?.hasPrefix("Martian Mono") == true, "times use the bundled Martian Mono")

        // A capture with a clearly coloured target, as the broker would store it.
        let path = directory.appendingPathComponent("card-fixture.jpg")
        let width = 480, height = 260
        let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height,
            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
            colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        for y in 0..<height { for x in 0..<width {
            let target = x >= 150 && x < 300 && y >= 120 && y < 170
            let offset = y * bitmap.bytesPerRow + x * 4
            bitmap.bitmapData![offset] = target ? 240 : 225
            bitmap.bitmapData![offset + 1] = target ? 120 : 225
            bitmap.bitmapData![offset + 2] = target ? 0 : 225
            bitmap.bitmapData![offset + 3] = 255
        } }
        try bitmap.representation(using: .jpeg, properties: [.compressionFactor: 0.95])!.write(to: path)
        let approval = Approval(["id": "cardcheck", "kind": "click", "detail": "Pay now",
            "caller": "claude-desktop", "url": "https://shop.example.com/checkout",
            "reason": "verb:pay now", "tab": "12", "expiresAt": Date().addingTimeInterval(540).timeIntervalSince1970 * 1000,
            "imagePath": path.path, "box": ["x": 150, "y": 120, "width": 150, "height": 50]])!

        check(ApprovalWords.title(approval).verb == "click" && ApprovalWords.title(approval).object == "“Pay now”",
              "the heading says what the agent will do, in words")
        check(ApprovalWords.reason("verb:pay now") == "Held because its name contains “pay now”.", "the reason reads as a sentence")
        check(ApprovalWords.host("https://shop.example.com/checkout") == "shop.example.com/checkout", "the address shows host and path")
        // The warm button and the mark on a page capture keep one light tone in both
        // appearances: the ground under them never changes with the Mac's theme.
        let warmText = [NSAppearance(named: .aqua)!, NSAppearance(named: .darkAqua)!].map { appearance -> CGFloat in
            var brightness: CGFloat = 0
            appearance.performAsCurrentDrawingAppearance { brightness = Palette.onWarm.usingColorSpace(.sRGB)!.brightnessComponent }
            return brightness
        }
        check(warmText[0] > 0.9 && warmText[0] == warmText[1], "the warm button's label stays light in both appearances")

        for (name, appearance) in [("light", NSAppearance(named: .aqua)!), ("dark", NSAppearance(named: .darkAqua)!)] {
            let card = ApprovalCard(approval, enabled: true) { _ in }
            card.appearance = appearance
            card.frame = NSRect(x: 0, y: 0, width: 528, height: card.fittingSize.height)
            card.layoutSubtreeIfNeeded()
            let page = NSView(frame: card.frame.insetBy(dx: -36, dy: -36))
            page.appearance = appearance; page.wantsLayer = true
            page.addSubview(card)
            card.setFrameOrigin(NSPoint(x: 36, y: 36))
            page.setFrameOrigin(.zero)
            guard let shot = page.bitmapImageRepForCachingDisplay(in: page.bounds) else { fatalError("no bitmap") }
            appearance.performAsCurrentDrawingAppearance {
                page.layer?.backgroundColor = Palette.paper.cgColor
                page.cacheDisplay(in: page.bounds, to: shot)
            }
            try shot.representation(using: .png, properties: [:])!.write(to: directory.appendingPathComponent("card-\(name).png"))
            check(card.fittingSize.height > 300 && card.fittingSize.height < 700, "\(name): the card fits one screenful (\(Int(card.fittingSize.height))pt)")
            func color(_ x: Int, _ y: Int) -> NSColor { shot.colorAt(x: x, y: y)!.usingColorSpace(.sRGB)! }
            let ground = color(8, 8)
            let paper = appearance.name == .darkAqua ? 0.1 : 0.9
            check(abs(ground.redComponent - paper) < 0.15, "\(name): the panel's ground is paper")
            // The warm decision sits in the last row of the card; find it there.
            var warm = 0
            for y in max(0, shot.pixelsHigh - 220)..<shot.pixelsHigh {
                for x in 0..<shot.pixelsWide {
                    let pixel = color(x, y)
                    if pixel.redComponent > 0.6 && pixel.greenComponent < 0.45 && pixel.blueComponent < 0.3 { warm += 1 }
                }
            }
            check(warm > 5000, "\(name): the approve button carries the warm human colour (\(warm) px)")
        }

        func descendants(_ view: NSView) -> [NSView] { view.subviews.flatMap { [$0] + descendants($0) } }
        func render(_ view: NSView, width: CGFloat, name: String, appearance: NSAppearance) throws -> (NSView, NSBitmapImageRep) {
            view.appearance = appearance
            view.widthAnchor.constraint(equalToConstant: width).isActive = true
            view.frame = NSRect(x: 36, y: 36, width: width, height: view.fittingSize.height)
            view.layoutSubtreeIfNeeded()
            let page = NSView(frame: NSRect(x: 0, y: 0, width: width + 72, height: view.frame.height + 72))
            page.appearance = appearance; page.wantsLayer = true; page.addSubview(view)
            page.layoutSubtreeIfNeeded()
            view.setFrameSize(NSSize(width: width, height: view.fittingSize.height))
            page.setFrameSize(NSSize(width: width + 72, height: view.frame.height + 72))
            page.layoutSubtreeIfNeeded()
            let shot = page.bitmapImageRepForCachingDisplay(in: page.bounds)!
            appearance.performAsCurrentDrawingAppearance {
                page.layer?.backgroundColor = Palette.paper.cgColor
                page.cacheDisplay(in: page.bounds, to: shot)
            }
            try shot.representation(using: .png, properties: [:])!.write(to: directory.appendingPathComponent("\(name).png"))
            return (page, shot)
        }
        func pixel(in view: NSView, at point: NSPoint, page: NSView, shot: NSBitmapImageRep) -> NSColor {
            let point = view.convert(point, to: page)
            let x = Int(point.x * CGFloat(shot.pixelsWide) / page.bounds.width)
            let y = Int((page.bounds.height - point.y) * CGFloat(shot.pixelsHigh) / page.bounds.height)
            return shot.colorAt(x: x, y: y)!.usingColorSpace(.sRGB)!
        }
        func fits(_ label: NSTextField, within view: NSView) -> Bool {
            // NSTextField's frame includes two optical alignment pixels on each
            // side; its alignment rect is the visible text's allocated space.
            let rect = label.convert(label.alignmentRect(forFrame: label.bounds), to: view)
            let measured = label.cell!.cellSize(forBounds: NSRect(x: 0, y: 0, width: label.bounds.width, height: 10000))
            let fits = !label.isHidden && rect.width > 0 && rect.height > 0
                && view.bounds.insetBy(dx: -1, dy: -1).contains(rect)
                && measured.height <= label.bounds.height + 1
            if !fits { print("TEXT GEOMETRY \(label.stringValue): rect=\(rect), needed=\(measured), container=\(view.bounds)") }
            return fits
        }
        func make(_ id: String, kind: String = "click", detail: String, reason: String,
                  url: String = "https://workspace.example.com/project/messages", picture: Bool = true) -> Approval {
            var object: JSONObject = ["id": id, "kind": kind, "detail": detail, "caller": "codex",
                "url": url, "tab": "12", "reason": reason,
                "expiresAt": Date().addingTimeInterval(540).timeIntervalSince1970 * 1000]
            if picture {
                object["imagePath"] = path.path
                object["box"] = ["x": 150, "y": 120, "width": 150, "height": 50]
            }
            return Approval(object)!
        }
        struct Fixture {
            let approval: Approval
            let heading: String
            let place: String
            let reason: String
        }
        let source = "on workspace.example.com/project/messages"
        // Eval has no current HOLD policy. This fixture exercises a possible stored
        // approval without changing that policy or claiming a live eval hold exists.
        let fixtures = [
            Fixture(approval: make("delete", detail: "Delete forever", reason: "verb:delete"),
                heading: "codex wants to click “Delete forever”", place: source,
                reason: "Held because its name contains “delete”."),
            Fixture(approval: make("send", detail: "Send", reason: "verb:send"),
                heading: "codex wants to click “Send”", place: source,
                reason: "Held because its name contains “send”."),
            Fixture(approval: make("link", detail: "Billing settings -> https://accounts.example.com/billing/settings", reason: "url-pattern:billing"),
                heading: "codex wants to click “Billing settings”",
                place: "\(source), which leads to accounts.example.com/billing/settings",
                reason: "Held because this address is on the protected list."),
            Fixture(approval: make("enter", kind: "press", detail: "Enter", reason: "enter-submits:send"),
                heading: "codex wants to press Enter", place: source,
                reason: "Held because Enter would activate a button or link with “send” in its name."),
            Fixture(approval: make("open", kind: "open", detail: "https://accounts.example.com/billing/settings", reason: "url-pattern:billing",
                url: "https://accounts.example.com/billing/settings", picture: false),
                heading: "codex wants to open a new tab", place: "to accounts.example.com/billing/settings",
                reason: "Held because this address is on the protected list."),
            Fixture(approval: make("goto", kind: "goto", detail: "https://accounts.example.com/billing/settings", reason: "url-pattern:billing", picture: false),
                heading: "codex wants to navigate this tab", place: "to accounts.example.com/billing/settings",
                reason: "Held because this address is on the protected list."),
            Fixture(approval: make("eval-synthetic", kind: "eval", detail: "eval", reason: "manual-review:script", picture: false),
                heading: "codex wants to run a script", place: source,
                reason: "Held because this action needs your approval."),
            Fixture(approval: make("extension-disable", kind: "extension.disable", detail: "Fixture extension", reason: "extension:disable", url: "chrome://extensions", picture: false),
                heading: "codex wants to disable extension “Fixture extension”", place: "in Chrome",
                reason: "Held because this action needs your approval."),
            Fixture(approval: make("extension-remove", kind: "extension.uninstall", detail: "Fixture extension", reason: "extension:uninstall", url: "chrome://extensions", picture: false),
                heading: "codex wants to remove extension “Fixture extension”", place: "in Chrome",
                reason: "Held because this action needs your approval."),
            Fixture(approval: make("extension-install", kind: "extension.install", detail: "Fixture extension", reason: "extension:install", url: "", picture: false),
                heading: "codex wants to install extension “Fixture extension”", place: "in Chrome",
                reason: "Held because this action needs your approval."),
            Fixture(approval: make("unnamed", detail: "", reason: "manual-review:control"),
                heading: "codex wants to click an unnamed control", place: source,
                reason: "Held because this action needs your approval."),
            Fixture(approval: make("unnamed-link", detail: "-> https://accounts.example.com/billing/settings", reason: "url-pattern:billing"),
                heading: "codex wants to click an unnamed control",
                place: "\(source), which leads to accounts.example.com/billing/settings",
                reason: "Held because this address is on the protected list."),
            Fixture(approval: make("guarded-key", kind: "press", detail: "Control+Enter", reason: "key:Control+Enter on workspace.example.com", picture: false),
                heading: "codex wants to press Control+Enter", place: source,
                reason: "Held because Control+Enter is guarded on this site."),
            Fixture(approval: make("long-name", detail: "Delete forever all selected messages and their attachments from the shared project archive", reason: "verb:delete"),
                heading: "codex wants to click “Delete forever all selected messages and their attachments from the shared project archive”", place: source,
                reason: "Held because its name contains “delete”.")
        ]
        check(ApprovalWords.title(make("unnamed-untrimmed", detail: " -> https://accounts.example.com/billing", reason: "url-pattern:billing")).object == "an unnamed control",
              "an unnamed link is readable with or without leading whitespace")
        for (theme, appearance) in [("light", NSAppearance(named: .aqua)!), ("dark", NSAppearance(named: .darkAqua)!)] {
            for width: CGFloat in [528, 408] {
                for fixture in fixtures {
                    let id = "\(fixture.approval.id)-\(theme)-\(Int(width))"
                    var decisions: [String] = []
                    let card = ApprovalCard(fixture.approval, enabled: true) { decisions.append($0) }
                    let (page, shot) = try render(card, width: width, name: "card-\(id)", appearance: appearance)
                    let labels = descendants(card).compactMap { $0 as? NSTextField }
                    let visible = labels.map(\.stringValue)
                    check(visible.contains(fixture.heading) && visible.contains(fixture.place) && visible.contains(fixture.reason),
                          "\(id): the full action, address and plain reason are visible")
                    check(labels.allSatisfy { fits($0, within: card) }, "\(id): every text line fits without clipping")
                    let heading = labels.first { $0.stringValue == fixture.heading }!
                    let attributes = heading.attributedStringValue.attributes(at: 0, effectiveRange: nil)
                    let font = attributes[.font] as! NSFont
                    let paragraph = attributes[.paragraphStyle] as! NSParagraphStyle
                    let lineHeight = max(paragraph.minimumLineHeight, font.ascender - font.descender + font.leading)
                    let needed = heading.cell!.cellSize(forBounds: NSRect(x: 0, y: 0, width: heading.bounds.width, height: 10000)).height
                    let paper = pixel(in: page, at: NSPoint(x: 8, y: 8), page: page, shot: shot)
                    var allLinesPainted = true
                    for line in 0..<Int(ceil(needed / lineHeight)) {
                        var ink = 0
                        for y in Int(CGFloat(line) * lineHeight)..<min(Int(CGFloat(line + 1) * lineHeight), Int(heading.bounds.height)) {
                            for x in 2..<(Int(heading.bounds.width) - 2) {
                                let p = pixel(in: heading, at: NSPoint(x: x, y: y), page: page, shot: shot)
                                if abs(p.redComponent - paper.redComponent) + abs(p.greenComponent - paper.greenComponent)
                                    + abs(p.blueComponent - paper.blueComponent) > 0.5 { ink += 1 }
                            }
                        }
                        allLinesPainted = allLinesPainted && ink > 20
                    }
                    check(allLinesPainted, "\(id): every heading line actually paints into the PNG")
                    let reason = labels.first { $0.stringValue == fixture.reason }!
                    check(reason.accessibilityHelp() == fixture.approval.reason, "\(id): accessibility retains the raw policy reason")
                    let buttons = descendants(card).compactMap { $0 as? PanelButton }
                    let approve = buttons.first { $0.title == "Approve with Touch ID" }
                    let deny = buttons.first { $0.title == "Deny" }
                    check(buttons.count == 2 && approve?.isEnabled == true && deny?.isEnabled == true,
                          "\(id): both decisions are available")
                    let warm = pixel(in: approve!, at: NSPoint(x: 8, y: 19), page: page, shot: shot)
                    check(warm.redComponent > 0.6 && warm.greenComponent < 0.45 && warm.blueComponent < 0.3,
                          "\(id): the approval button is warm")
                    approve!.performClick(nil); deny!.performClick(nil)
                    check(decisions == ["grant", "deny"], "\(id): the buttons retain their decision actions")
                    let pictures = descendants(card).compactMap { $0 as? ApprovalPictureView }
                    check(pictures.count == (fixture.approval.imagePath == nil ? 0 : 1)
                          && card.frame.height > 130 && card.frame.height < 700,
                          "\(id): the complete card fits, with a picture only when one exists (\(Int(card.frame.height))pt)")
                }

                let pair = ApprovalList([fixtures[0].approval, fixtures[4].approval], enabled: true) { _, _ in }
                let (page, shot) = try render(pair, width: width, name: "card-two-\(theme)-\(Int(width))", appearance: appearance)
                check(pair.arrangedSubviews.count == 3 && pair.arrangedSubviews[0] is ApprovalCard
                      && pair.arrangedSubviews[1] is PanelRule && pair.arrangedSubviews[2] is ApprovalCard,
                      "two-\(theme)-\(Int(width)): the production list separates two cards with one rule")
                let rule = pair.arrangedSubviews[1]
                var expected = NSColor.clear
                appearance.performAsCurrentDrawingAppearance { expected = Palette.rule.usingColorSpace(.sRGB)! }
                let actual = pixel(in: rule, at: NSPoint(x: width / 2, y: 0.5), page: page, shot: shot)
                check(rule.frame.width == width && rule.frame.height == 1 && abs(actual.redComponent - expected.redComponent) < 0.02,
                      "two-\(theme)-\(Int(width)): the full-width separator is painted")
                check(descendants(pair).compactMap { $0 as? NSTextField }.allSatisfy { fits($0, within: pair) },
                      "two-\(theme)-\(Int(width)): both cards fit in their scrollable body")

                let empty = ApprovalList([], enabled: true) { _, _ in }
                _ = try render(empty, width: width, name: "card-empty-\(theme)-\(Int(width))", appearance: appearance)
                let emptyLabels = descendants(empty).compactMap { $0 as? NSTextField }
                check(emptyLabels.map(\.stringValue) == ["Nothing is waiting for you. Actions that need your approval appear here."]
                      && emptyLabels.allSatisfy { fits($0, within: empty) } && empty.frame.height >= 14
                      && !descendants(empty).contains { $0 is ApprovalCard || $0 is PanelButton || $0 is ApprovalPictureView },
                      "empty-\(theme)-\(Int(width)): the production empty state explains what belongs here")
            }
        }

        let signin = Approval(["id": "signincheck", "kind": "signin", "detail": "Fixture login", "caller": "codex", "tab": 7,
            "url": "https://accounts.example.test:8443/login", "site": "https://accounts.example.test:8443",
            "reason": "sign-in needs owner approval", "expiresAt": Date().addingTimeInterval(540).timeIntervalSince1970 * 1000])!
        for (theme, appearance) in [("light", NSAppearance(named: .aqua)!), ("dark", NSAppearance(named: .darkAqua)!)] {
            for width: CGFloat in [528, 408] {
                var choices: [String] = []
                let card = ApprovalCard(signin, enabled: true) { choices.append($0) }
                _ = try render(card, width: width, name: "signin-\(theme)-\(Int(width))", appearance: appearance)
                let buttons = descendants(card).compactMap { $0 as? PanelButton }
                check(buttons.map(\.title).sorted() == ["Allow once", "Always allow on this site", "Deny"].sorted(),
                      "signin-\(theme)-\(Int(width)): only sign-in cards offer both allow choices")
                check(descendants(card).compactMap { $0 as? NSTextField }.allSatisfy { fits($0, within: card) }
                      && descendants(card).compactMap { $0 as? NSTextField }.contains { $0.stringValue == "codex wants to sign in with “Fixture login”" }
                      && buttons.allSatisfy { card.bounds.contains($0.convert($0.bounds, to: card)) },
                      "signin-\(theme)-\(Int(width)): exact origin and all controls fit")
                for title in ["Allow once", "Always allow on this site", "Deny"] { buttons.first { $0.title == title }!.performClick(nil) }
                check(choices == ["grant", "remember", "deny"], "signin-\(theme)-\(Int(width)): choices route to distinct actions")
                let sites = [signin.site!, "https://long-subdomain.accounts.example.test:9443"]
                var revoked: [String] = []
                let remembered = RememberedSigninList(sites, enabled: true) { revoked.append($0) }
                _ = try render(remembered, width: width, name: "remembered-\(theme)-\(Int(width))", appearance: appearance)
                check(descendants(remembered).compactMap { $0 as? NSTextField }.allSatisfy { fits($0, within: remembered) },
                      "remembered-\(theme)-\(Int(width)): full origins wrap without clipping")
                for button in descendants(remembered).compactMap({ $0 as? PanelButton }) { button.performClick(nil) }
                check(revoked == sites, "remembered-\(theme)-\(Int(width)): Revoke selects the exact row origin")
            }
        }
        let sendObject: JSONObject = ["id": "sendcheck", "kind": "press", "detail": "Enter", "caller": "codex", "tab": 7,
            "url": "https://chat.example.test:8443/chat", "site": "https://chat.example.test:8443", "rememberable": true,
            "reason": "enter-submits:send", "expiresAt": Date().addingTimeInterval(540).timeIntervalSince1970 * 1000]
        let send = Approval(sendObject)!
        for (theme, appearance) in [("light", NSAppearance(named: .aqua)!), ("dark", NSAppearance(named: .darkAqua)!)] {
            for width: CGFloat in [528, 408] {
                var choices: [String] = []
                let card = ApprovalCard(send, enabled: true) { choices.append($0) }
                _ = try render(card, width: width, name: "send-\(theme)-\(Int(width))", appearance: appearance)
                let buttons = descendants(card).compactMap { $0 as? PanelButton }
                check(buttons.map(\.title).sorted() == ["Allow once", "Always allow on this site", "Deny"].sorted(),
                      "send-\(theme)-\(Int(width)): eligible sends offer the owner both allow choices")
                for title in ["Allow once", "Always allow on this site", "Deny"] { buttons.first { $0.title == title }!.performClick(nil) }
                check(choices == ["grant", "remember", "deny"], "send choices route to distinct decisions")
                check(descendants(card).compactMap { $0 as? NSTextField }.allSatisfy { fits($0, within: card) }
                      && buttons.allSatisfy { card.bounds.contains($0.convert($0.bounds, to: card)) }, "send origin and controls fit")
                let rules = [send.sendPermission!, SendPermission(["site": send.site!, "kind": "click", "reason": "verb:send now"])!]
                var revoked: [SendPermission] = []
                let remembered = RememberedSendList(rules, enabled: true) { revoked.append($0) }
                _ = try render(remembered, width: width, name: "remembered-sends-\(theme)-\(Int(width))", appearance: appearance)
                check(descendants(remembered).compactMap { $0 as? NSTextField }.allSatisfy { fits($0, within: remembered) }, "remembered send rows wrap exact scopes")
                for button in descendants(remembered).compactMap({ $0 as? PanelButton }) { button.performClick(nil) }
                check(revoked == rules, "Revoke selects exact send origin, kind and reason")
            }
        }
        for fields: JSONObject in [["rememberable": false], ["kind": "upload"], ["reason": "enter-submits:pay"]] {
            var object = sendObject; object.merge(fields) { _, new in new }
            let card = ApprovalCard(Approval(object)!, enabled: true) { _ in }
            check(!descendants(card).compactMap { $0 as? PanelButton }.contains { $0.title == "Always allow on this site" }, "ineligible actions have no Always control")
        }
        let disabledSend = RememberedSendList([send.sendPermission!], enabled: false) { _ in fatalError("disabled send revoke ran") }
        let emptySignin = RememberedSigninList([], enabled: true) { _ in fatalError("empty sign-in revoke ran") }
        let emptySend = RememberedSendList([], enabled: true) { _ in fatalError("empty send revoke ran") }
        check(descendants(emptySignin).compactMap { $0 as? NSTextField }.contains { $0.stringValue == "No sites are remembered. Sign-ins wait for your approval." }, "empty sign-in list explains approval")
        check(descendants(emptySend).compactMap { $0 as? NSTextField }.contains { $0.stringValue == "No sends are remembered. Sending waits for your approval." }, "empty send list explains approval")
        check(descendants(emptySignin).compactMap { $0 as? PanelButton }.isEmpty && descendants(emptySend).compactMap { $0 as? PanelButton }.isEmpty, "empty permission lists have no revoke controls")
        check(descendants(disabledSend).compactMap { $0 as? PanelButton }.allSatisfy { !$0.isEnabled }, "busy/disconnected send revoke is disabled")

        // Session grants: the request card and the list of what is running unattended.
        let grantApproval = Approval(["id": "grantcheck", "kind": "grant", "caller": "codex", "reason": "session grant",
            "detail": "post on www.linkedin.com/company\nupload on github.com/settings\nfor 3 hours\n“Update the profile”",
            "expiresAt": Date().addingTimeInterval(540).timeIntervalSince1970 * 1000])!
        for (theme, appearance) in [("light", NSAppearance(named: .aqua)!), ("dark", NSAppearance(named: .darkAqua)!)] {
            for width: CGFloat in [528, 408] {
                var choices: [String] = []
                let card = ApprovalCard(grantApproval, enabled: true) { choices.append($0) }
                _ = try render(card, width: width, name: "grant-\(theme)-\(Int(width))", appearance: appearance)
                let buttons = descendants(card).compactMap { $0 as? PanelButton }
                let labels = descendants(card).compactMap { $0 as? NSTextField }
                let visible = labels.map(\.stringValue)
                check(buttons.map(\.title).sorted() == ["Approve with Touch ID", "Deny"].sorted(),
                      "grant-\(theme)-\(Int(width)): approve and deny only, never Always allow")
                check(visible.contains("codex wants to work without asking you for 3 hours")
                      && visible.contains("post on www.linkedin.com/company\nupload on github.com/settings\nDescribed by the agent as: “Update the profile”")
                      && visible.contains("Payments, purchases, sending messages, sign-in and security changes still ask you every time."),
                      "grant-\(theme)-\(Int(width)): the heading, every rule and the fixed sentence are visible")
                check(visible.contains { $0.hasPrefix("decide by ") } && !visible.contains { $0.hasPrefix("until ") },
                      "grant-\(theme)-\(Int(width)): the time shown is the time to answer, not the grant's length")
                // The image-bearing button overhangs the card's last row by a point on every card without an
                // "Always allow" row (an existing quirk), so only the horizontal fit of the controls is checked.
                check(labels.allSatisfy { fits($0, within: card) }
                      && buttons.allSatisfy { let frame = $0.convert($0.bounds, to: card); return frame.minX >= -1 && frame.maxX <= card.bounds.width + 1 },
                      "grant-\(theme)-\(Int(width)): text and controls fit across the card")
                for title in ["Approve with Touch ID", "Deny"] { buttons.first { $0.title == title }!.performClick(nil) }
                check(choices == ["grant", "deny"], "grant-\(theme)-\(Int(width)): the buttons keep their decisions")
            }
        }
        let activeGrants = [
            SessionGrant(["id": "g1", "caller": "codex", "label": "Update the profile",
                "rules": ["upload https://github.com/settings", "post https://www.linkedin.com/company"],
                "expiresAt": Date().addingTimeInterval(10800).timeIntervalSince1970 * 1000])!,
            SessionGrant(["id": "g2", "caller": "claude-code", "rules": ["delete https://shop.example/account/items"],
                "expiresAt": Date().addingTimeInterval(1800).timeIntervalSince1970 * 1000])!,
        ]
        for (theme, appearance) in [("light", NSAppearance(named: .aqua)!), ("dark", NSAppearance(named: .darkAqua)!)] {
            for width: CGFloat in [528, 408] {
                var ended: [String] = []
                let list = SessionGrantList(activeGrants, enabled: true) { ended.append($0.id) }
                _ = try render(list, width: width, name: "session-grants-\(theme)-\(Int(width))", appearance: appearance)
                let texts = descendants(list).compactMap { $0 as? NSTextField }.map(\.stringValue)
                check(texts.contains("Session grants")
                      && texts.contains { $0.hasPrefix("codex · until ") && $0.contains("upload on github.com/settings") && $0.contains("post on www.linkedin.com/company")
                          && $0.contains("Described by the agent as: “Update the profile”") }
                      && texts.contains { $0.hasPrefix("claude-code · until ") && $0.contains("delete on shop.example/account/items") },
                      "session-grants-\(theme)-\(Int(width)): who, until when, what is waived and the agent's own words")
                check(descendants(list).compactMap { $0 as? NSTextField }.allSatisfy { fits($0, within: list) },
                      "session-grants-\(theme)-\(Int(width)): every row fits")
                let ends = descendants(list).compactMap { $0 as? PanelButton }
                check(ends.map(\.title) == ["End now", "End now"], "session-grants-\(theme)-\(Int(width)): one End now per grant")
                for button in ends { button.performClick(nil) }
                check(ended == ["g1", "g2"], "session-grants-\(theme)-\(Int(width)): End now selects exactly its grant")
            }
        }
        let noGrants = SessionGrantList([], enabled: true) { _ in fatalError("empty grant list ended something") }
        check(descendants(noGrants).compactMap { $0 as? NSTextField }.contains { $0.stringValue == "No session grants. An agent can ask for one at the start of a chat." }
              && descendants(noGrants).compactMap { $0 as? PanelButton }.isEmpty, "the empty grant list explains itself and has no controls")
        let frozenGrants = SessionGrantList(activeGrants, enabled: false) { _ in fatalError("disabled end ran") }
        check(descendants(frozenGrants).compactMap { $0 as? PanelButton }.allSatisfy { !$0.isEnabled }, "a disconnected panel cannot end a grant")

        // Approving from the owner's other device: the switch, what it allows and never allows, the honest limit, the
        // answers it gave, and the cards it may also answer.
        let phoneKey = String(repeating: "0123456789abcdef", count: 4)
        let phoneOffStatus = RemoteStatus(["enabled": false, "candidate": ["fingerprint": phoneKey]])!
        let phoneNoKeyStatus = RemoteStatus(["enabled": false, "candidate": NSNull()])!
        let phoneOnStatus = RemoteStatus(["enabled": true, "fingerprint": phoneKey, "enabledAt": "2099-01-01T00:00:00.000Z"])!
        let phoneAnswers = [
            RemoteDecision(["id": "pa1", "kind": "click", "caller": "Marcus", "url": "https://example.test/shop", "detail": "Post",
                "status": "used", "by": "remote", "decidedAt": "2099-01-01T14:02:00.000Z"])!,
            RemoteDecision(["id": "pa2", "kind": "upload", "caller": "codex", "url": "https://example.test/profile", "detail": "avatar.png (4 KB)",
                "status": "denied", "by": "remote", "decidedAt": "2099-01-01T13:00:00.000Z"])!,
        ]
        for (theme, appearance) in [("light", NSAppearance(named: .aqua)!), ("dark", NSAppearance(named: .darkAqua)!)] {
            for width: CGFloat in [528, 408] {
                let tag = "phone-off-\(theme)-\(Int(width))"
                var pressed: [String] = []
                let panel = RemotePanel(phoneOffStatus, decisions: phoneAnswers, canTurnOn: true, canTurnOff: true,
                    turnOn: { pressed.append("on") }, turnOff: { pressed.append("off") })
                _ = try render(panel, width: width, name: tag, appearance: appearance)
                let texts = descendants(panel).compactMap { $0 as? NSTextField }.map(\.stringValue)
                check(texts.contains(RemotePanel.title)
                      && texts.contains("Payments, purchases, sign-in, security pages and sending messages always need Touch ID on this Mac.")
                      && texts.contains("The limit: a program running as you on this Mac that can read the phone approver's key could approve these requests too.")
                      && texts.contains("A key from your phone approver is waiting: 0123 4567 89ab cdef. Check that your phone approver shows the same digits."),
                      "\(tag): what it allows, what it never does, the honest limit and the key to compare")
                check(texts.contains { $0.hasPrefix("Approved from phone: Marcus click “Post” on example.test/shop, ") }
                      && texts.contains { $0.hasPrefix("Denied from phone: codex upload “avatar.png (4 KB)” on example.test/profile, ") },
                      "\(tag): what the phone answered is listed")
                let buttons = descendants(panel).compactMap { $0 as? PanelButton }
                check(buttons.map(\.title) == ["Turn on…"] && buttons.allSatisfy { $0.isEnabled }, "\(tag): one usable Turn on… button")
                buttons.first!.performClick(nil)
                check(pressed == ["on"], "\(tag): Turn on… asks to turn on and does nothing else")
                check(descendants(panel).compactMap { $0 as? NSTextField }.allSatisfy { fits($0, within: panel) }, "\(tag): every line fits")
            }
        }
        for (theme, appearance) in [("light", NSAppearance(named: .aqua)!), ("dark", NSAppearance(named: .darkAqua)!)] {
            for width: CGFloat in [528, 408] {
                let tag = "phone-on-\(theme)-\(Int(width))"
                var pressed: [String] = []
                let panel = RemotePanel(phoneOnStatus, decisions: [], canTurnOn: true, canTurnOff: true,
                    turnOn: { pressed.append("on") }, turnOff: { pressed.append("off") })
                _ = try render(panel, width: width, name: tag, appearance: appearance)
                let texts = descendants(panel).compactMap { $0 as? NSTextField }.map(\.stringValue)
                check(texts.contains { $0.hasPrefix("On, since ") && $0.hasSuffix("It answers to the key 0123 4567 89ab cdef. Requests it can answer say so on their card.") },
                      "\(tag): it says it is on, since when, and for which key")
                let buttons = descendants(panel).compactMap { $0 as? PanelButton }
                check(buttons.map(\.title) == ["Turn off"] && buttons.allSatisfy { $0.isEnabled }, "\(tag): one usable Turn off button")
                buttons.first!.performClick(nil)
                check(pressed == ["off"], "\(tag): Turn off ends it and does nothing else")
                check(descendants(panel).compactMap { $0 as? NSTextField }.allSatisfy { fits($0, within: panel) }, "\(tag): every line fits")
            }
        }
        let phoneNoKey = RemotePanel(phoneNoKeyStatus, decisions: [], canTurnOn: true, canTurnOff: true,
            turnOn: { fatalError("turned on with no key") }, turnOff: { fatalError("turned off while off") })
        check(descendants(phoneNoKey).compactMap { $0 as? PanelButton }.allSatisfy { !$0.isEnabled }
              && descendants(phoneNoKey).compactMap { $0 as? NSTextField }.contains { $0.stringValue == "No key from a phone approver has been found yet." },
              "with no key waiting, Turn on… is disabled and says why")
        let phoneBusy = RemotePanel(phoneOffStatus, decisions: [], canTurnOn: false, canTurnOff: true,
            turnOn: { fatalError("busy turn on ran") }, turnOff: { fatalError("busy turn off ran") })
        check(descendants(phoneBusy).compactMap { $0 as? PanelButton }.allSatisfy { !$0.isEnabled }, "while the app is busy or cannot sign, Turn on… is disabled")
        let phoneFrozen = RemotePanel(phoneOnStatus, decisions: [], canTurnOn: true, canTurnOff: false,
            turnOn: { fatalError("frozen turn on ran") }, turnOff: { fatalError("frozen turn off ran") })
        check(descendants(phoneFrozen).compactMap { $0 as? PanelButton }.allSatisfy { !$0.isEnabled }, "a disconnected panel cannot turn it off")
        let phoneCard = ApprovalCard(approval, enabled: true, remote: true) { _ in }
        _ = try render(phoneCard, width: 528, name: "phone-card-light-528", appearance: NSAppearance(named: .aqua)!)
        check(descendants(phoneCard).compactMap { $0 as? NSTextField }.contains { $0.stringValue == "Can also be approved from your phone." },
              "a request the phone may answer says so")
        check(descendants(phoneCard).compactMap { $0 as? PanelButton }.map(\.title).sorted() == ["Approve with Touch ID", "Deny"].sorted(),
              "and its buttons stay Touch ID")
        let plainCard = ApprovalCard(approval, enabled: true) { _ in }
        check(!descendants(plainCard).compactMap { $0 as? NSTextField }.contains { $0.stringValue.contains("phone") }, "a request it may not answer says nothing of the phone")
        let mixedList = ApprovalList([approval, signin], enabled: true, remote: [approval.id]) { _, _ in }
        let mixedCards = mixedList.arrangedSubviews.compactMap { $0 as? ApprovalCard }
        let mixedSays = mixedCards.map { card in
            descendants(card).compactMap { $0 as? NSTextField }.contains { $0.stringValue == "Can also be approved from your phone." }
        }
        check(mixedCards.count == 2 && mixedSays == [true, false], "only the request the broker flagged says it can be answered from the phone")

        let disabled = ApprovalCard(signin, enabled: false) { _ in fatalError("disabled decision ran") }
        check(descendants(disabled).compactMap { $0 as? PanelButton }.allSatisfy { !$0.isEnabled }, "busy/disconnected sign-in choices are disabled")
        let disabledRevoke = RememberedSigninList([signin.site!], enabled: false) { _ in fatalError("disabled revoke ran") }
        check(descendants(disabledRevoke).compactMap { $0 as? PanelButton }.allSatisfy { !$0.isEnabled }, "busy/disconnected revocation is disabled")

        // Real JPEGs are supplied by the disposable bridge harness when it has run.
        // They are optional so this app-only check remains independently runnable.
        let manifest = directory.deletingLastPathComponent().appendingPathComponent("context-captures/measurements.json")
        if FileManager.default.fileExists(atPath: manifest.path) {
            let captures = try JSONSerialization.jsonObject(with: Data(contentsOf: manifest)) as! [JSONObject]
            var measurements: [JSONObject] = []
            for capture in captures {
                let name = capture["name"] as! String
                let imageWidth = (capture["width"] as! NSNumber).doubleValue
                let imageHeight = (capture["height"] as! NSNumber).doubleValue
                let label = ["small": "Delete forever", "scrolled": "Delete forever", "wide": "Pay now",
                    "top-left": "Send", "bottom-right": "Send", "oversized": "Confirm order"][name]!
                let approval = Approval(["id": name, "kind": "click", "detail": label,
                    "caller": "codex", "url": "https://fixture.example.com/project",
                    "reason": "verb:\(label.lowercased())", "imagePath": capture["imagePath"]!, "box": capture["box"]!])!
                for (theme, appearance) in [("light", NSAppearance(named: .aqua)!), ("dark", NSAppearance(named: .darkAqua)!)] {
                    for width: CGFloat in [528, 408] {
                        let card = ApprovalCard(approval, enabled: true) { _ in }
                        _ = try render(card, width: width, name: "capture-\(name)-\(theme)-\(Int(width))", appearance: appearance)
                        let picture = descendants(card).compactMap { $0 as? ApprovalPictureView }.first!
                        let frames = picture.targetFrame(in: picture.bounds)!
                        let expectedHeight = min(width * imageHeight / imageWidth, min(360, imageHeight))
                        check(abs(picture.frame.height - expectedHeight) < 1 && abs(frames.image.height - picture.frame.height) < 1,
                              "capture-\(name)-\(theme)-\(Int(width)): the image uses its height without a blank slot")
                        check(frames.target.width >= 65 && frames.target.height >= 20 && card.frame.height < 700,
                              "capture-\(name)-\(theme)-\(Int(width)): target remains at least 65×20pt (\(Int(frames.target.width))×\(Int(frames.target.height))pt)")
                        if theme == "light" {
                            measurements.append(["name": name, "cardWidth": width, "cardHeight": card.frame.height,
                                "imageWidth": frames.image.width, "imageHeight": frames.image.height,
                                "targetWidth": frames.target.width, "targetHeight": frames.target.height,
                                "targetImageShare": frames.target.width * frames.target.height / (frames.image.width * frames.image.height),
                                "targetCardShare": frames.target.width * frames.target.height / (width * card.frame.height)])
                        }
                    }
                }
            }
            try JSONSerialization.data(withJSONObject: measurements, options: [.prettyPrinted, .sortedKeys])
                .write(to: directory.appendingPathComponent("capture-panel-measurements.json"))
        } else {
            print("NOTE real capture renders require the disposable bridge fixture manifest")
        }
        print("PNG directory: \(directory.path)")
        print("== app card: \(passed) passed, 0 failed")
    }
}
