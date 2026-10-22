import AppKit
import UserNotifications
import LocalAuthentication

// Keep the same menu and rows while it is tracking. Replacing statusItem.menu on
// every broker snapshot can dismiss the owner's open menu.
final class ApprovalMenu {
    let menu = NSMenu()
    private let waiting = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    private let error = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    private let running = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    private let phone = NSMenuItem(title: "Approving from your phone is on", action: nil, keyEquivalent: "")
    private let review: NSMenuItem

    init(target: AnyObject, open: Selector, remembered: Selector, quit: Selector) {
        review = NSMenuItem(title: "Open Gaddi…", action: open, keyEquivalent: "")
        // "1 action is waiting for you" is what the owner clicks: it opens the review, like the row below it.
        waiting.action = open; waiting.target = target
        let signins = NSMenuItem(title: "Remembered sign-ins…", action: remembered, keyEquivalent: "")
        let exit = NSMenuItem(title: "Quit Gaddi", action: quit, keyEquivalent: "")
        for item in [review, signins, exit] { item.target = target }
        for item in [waiting, error, running, phone, .separator(), review, signins, .separator(), exit] { menu.addItem(item) }
        menu.autoenablesItems = false
    }

    func update(connected: Bool, connectionText: String, count: Int, grants: Int, remote: Bool, errorText: String?) {
        waiting.title = !connected ? connectionText : count == 0 ? "Nothing is waiting for you"
            : count == 1 ? "1 action is waiting for you" : "\(count) actions are waiting for you"
        error.title = errorText ?? ""; error.isHidden = errorText == nil
        running.title = grants == 1 ? "1 session grant active" : "\(grants) session grants active"
        running.isHidden = grants == 0; phone.isHidden = !remote
        review.title = count == 0 ? "Open Gaddi…" : "Review and decide…"
        waiting.isEnabled = connected
    }
}

final class AppController: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate, NSWindowDelegate {
    private let model = BrowserModel()
    private let keys = SigningKey()
    private var statusItem: NSStatusItem!
    private lazy var statusMenu = ApprovalMenu(target: self, open: #selector(openApprovals),
        remembered: #selector(openRememberedSignins), quit: #selector(quit))
    private var snapshot = Snapshot()
    private var connected = false
    private var busy = false
    private var keyReady = false
    private var errorText: String?
    private var connectionText = "Connecting to daemon…"
    private struct ApprovalPanelState: Equatable {
        let approvals: [Approval]
        let rememberedSignins: [String]
        let rememberedSends: [SendPermission]
        let rememberedUploads: [String]
        let zones: [String]
        let grants: [SessionGrant]
        let remote: RemoteStatus
        let remoteApprovable: Set<String>
        let remoteDecisions: [RemoteDecision]
        let requestedID: String?
        let connected: Bool
        let keyReady: Bool
        let busy: Bool
        let errorText: String?
    }
    private var panelState: ApprovalPanelState?
    private var approvalsPanel: NSPanel?
    private var reviewFloat = ReviewWindowFloat()
    private var otherAppClicks: Any?
    private var timer: Timer?
    private var requestedID: String?
    private var launchRequestID: String?
    /// The owner clicked a banner: whatever is waiting opens, even if that one request has gone since.
    private var ownerAsked = false
    private var visibility = PendingApprovalVisibility()
    static let approvalNotification = Notification.Name("com.abcastor.gaddi.show-approval")

    init(approvalID: String? = nil) { launchRequestID = approvalID; super.init() }

    @objc private func requestedApproval(_ notification: Notification) {
        guard let raw = notification.userInfo?["id"] as? String, let id = approvalRequestID(raw) else { return }
        requestApproval(id)
    }
    private func requestApproval(_ id: String) {
        launchRequestID = id
        model.queue.async { [weak self] in self?.model.refresh() }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        Typeface.register(Bundle.main.resourceURL?.appendingPathComponent("Fonts"))
        DistributedNotificationCenter.default().addObserver(self, selector: #selector(requestedApproval(_:)),
            name: Self.approvalNotification, object: nil)
        NSWorkspace.shared.notificationCenter.addObserver(self, selector: #selector(otherAppActivated(_:)),
            name: NSWorkspace.didActivateApplicationNotification, object: nil)
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.image = StatusMark.image()
        statusItem.button?.imagePosition = .imageLeading
        statusItem.button?.toolTip = "Gaddi"
        statusItem.menu = statusMenu.menu
        let notifications = UNUserNotificationCenter.current()
        notifications.delegate = self
        notifications.requestAuthorization(options: [.alert, .sound]) { _, error in
            if let error { diagnostic("Notifications unavailable: \(error.localizedDescription)") }
        }
        model.onConnection = { [weak self] connected, message in
            DispatchQueue.main.async {
                guard let self else { return }
                self.connected = connected; self.connectionText = message
                self.render()
            }
        }
        model.onSnapshot = { [weak self] snapshot in
            DispatchQueue.main.async {
                guard let self else { return }
                let resolved = Set(self.snapshot.approvals.map(\.id)).subtracting(snapshot.approvals.map(\.id))
                // One banner per agent: it goes when that agent has nothing left waiting.
                let quiet = Set(self.snapshot.approvals.map(\.caller)).subtracting(snapshot.approvals.map(\.caller)).map(Self.bannerID)
                let notifications = UNUserNotificationCenter.current()
                notifications.removeDeliveredNotifications(withIdentifiers: Array(resolved) + quiet)
                notifications.removePendingNotificationRequests(withIdentifiers: Array(resolved) + quiet)
                self.snapshot = snapshot; self.connected = true; self.connectionText = "Connected"
                self.render()
                self.presentPendingApprovals()
            }
        }
        model.onPending = { [weak self] approval in
            DispatchQueue.main.async { self?.notify(approval) }
        }
        model.start()
        DispatchQueue(label: "gaddi.key-setup").async { [weak self] in
            guard let self else { return }
            do {
                try self.keys.exportPublicKey()
                DispatchQueue.main.async { self.keyReady = true; self.render() }
            } catch {
                DispatchQueue.main.async { self.showError("Approver key unavailable", error: error) }
            }
        }
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            guard let self else { return }
            if self.snapshot.approvals.contains(where: \.expired) {
                let expired = self.snapshot.approvals.filter(\.expired).map(\.id)
                let callers = Set(self.snapshot.approvals.map(\.caller))
                self.snapshot.approvals.removeAll(where: \.expired)
                let quiet = callers.subtracting(self.snapshot.approvals.map(\.caller)).map(Self.bannerID)
                let notifications = UNUserNotificationCenter.current()
                notifications.removeDeliveredNotifications(withIdentifiers: expired + quiet)
                notifications.removePendingNotificationRequests(withIdentifiers: expired + quiet)
                self.render()
                self.presentPendingApprovals()
            }
            // The broker ends a grant at its time and says so, but a lost event must not leave one on screen.
            if self.snapshot.grants.contains(where: \.expired) {
                self.snapshot.grants.removeAll(where: \.expired)
                self.render()
            }
        }
        render()
    }
    func applicationWillTerminate(_ notification: Notification) { timer?.invalidate(); model.stop() }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    private func render() {
        statusMenu.update(connected: connected, connectionText: connectionText,
            count: snapshot.approvals.count, grants: snapshot.grants.count,
            remote: snapshot.remote.enabled, errorText: errorText)
        statusItem.button?.title = snapshot.approvals.isEmpty ? "" : " \(snapshot.approvals.count)"
        if approvalsPanel != nil { renderApprovals() }
    }
    @objc private func quit() { NSApp.terminate(nil) }
    @objc private func openRememberedSignins() {
        requestedID = nil; openApprovals(); visibility.opened([])
    }
    private func presentPendingApprovals() {
        guard connected else { return }
        if visibility.shouldDismiss(snapshot.approvals, connected: connected, busy: busy, hasError: errorText != nil) {
            requestedID = nil
            approvalsPanel?.orderOut(nil)
        }
        if let id = requestedID, !snapshot.approvals.contains(where: { $0.id == id && !$0.expired }) {
            requestedID = nil
            renderApprovals()
        }
        // A launch or notification ID is just a selection hint. Only the broker's
        // current, unexpired pending list may open the selected request.
        if let id = launchRequestID, !busy {
            launchRequestID = nil
            if ownerAsked {
                // A banner stands for everything its agent has waiting, so the review opens on the whole list.
                ownerAsked = false; requestedID = nil
                visibility.acknowledge(snapshot.approvals)
                openApprovals()
                return
            }
            if snapshot.approvals.contains(where: { $0.id == id && !$0.expired }) {
                requestedID = id
                visibility.acknowledge(snapshot.approvals)
                openApprovals()
                return
            }
        }
        if visibility.shouldPresent(snapshot.approvals, busy: busy) {
            requestedID = nil
            showApprovals()
        }
    }
    @objc private func openApprovals() {
        visibility.opened(snapshot.approvals)
        showApprovals()
        // The owner asked for it (menu, banner, Dock): a real app window that stays above his other windows until he
        // closes it, so the activation that macOS hands back to the previous app cannot bury it.
        NSApp.setActivationPolicy(.regular)
        approvalsPanel?.level = .floating
        approvalsPanel?.makeKeyAndOrderFront(nil); NSApp.activate()
        reviewFloat.opened()
        // Global monitors see only other apps' events: a click there means he chose that app.
        otherAppClicks = otherAppClicks ?? NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown]) { [weak self] _ in
            guard let self, self.reviewFloat.clickedInOtherApp() else { return }
            self.stopFloating()
        }
    }
    @objc private func otherAppActivated(_ notification: Notification) {
        let app = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
        guard app?.processIdentifier != ProcessInfo.processInfo.processIdentifier, reviewFloat.otherAppActivated() else { return }
        stopFloating()
    }
    private func stopFloating() {
        approvalsPanel?.level = .normal
        if let monitor = otherAppClicks { NSEvent.removeMonitor(monitor); otherAppClicks = nil }
    }
    func windowWillClose(_ notification: Notification) {
        reviewFloat.closed(); stopFloating()
        NSApp.setActivationPolicy(.accessory)
    }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        openApprovals(); return false
    }
    private func showApprovals() {
        visibility.opened(snapshot.approvals, preservingCurrentMode: approvalsPanel?.isVisible == true)
        if approvalsPanel == nil {
            let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 600, height: 620),
                                styleMask: [.titled, .closable, .resizable, .fullSizeContentView, .nonactivatingPanel], backing: .buffered, defer: false)
            panel.title = "Gaddi"; panel.titlebarAppearsTransparent = true
            panel.hidesOnDeactivate = false
            panel.backgroundColor = Palette.paper; panel.isReleasedWhenClosed = false
            panel.minSize = NSSize(width: 480, height: 320); panel.center(); panel.delegate = self; approvalsPanel = panel
        }
        renderApprovals()
        approvalsPanel?.orderFrontRegardless()
    }
    private func renderApprovals() {
        guard let panel = approvalsPanel else { return }
        let state = ApprovalPanelState(approvals: snapshot.approvals,
            rememberedSignins: snapshot.rememberedSignins,
            rememberedSends: snapshot.rememberedSends,
            rememberedUploads: snapshot.rememberedUploads,
            zones: snapshot.zones,
            grants: snapshot.grants,
            remote: snapshot.remote,
            remoteApprovable: snapshot.remoteApprovable,
            remoteDecisions: snapshot.remoteDecisions,
            requestedID: requestedID,
            connected: connected, keyReady: keyReady, busy: busy, errorText: errorText)
        // Polls must not reset the reader's scroll or selection.
        guard state != panelState else { return }
        panelState = state
        let scroll = NSScrollView(); scroll.hasVerticalScroller = true
        scroll.drawsBackground = true; scroll.backgroundColor = Palette.paper; scroll.automaticallyAdjustsContentInsets = false
        let stack = NSStackView(); stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 28
        stack.edgeInsets = NSEdgeInsets(top: 48, left: 36, bottom: 32, right: 36)
        scroll.documentView = stack; panel.contentView = scroll
        stack.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: scroll.contentView.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: scroll.contentView.trailingAnchor),
            stack.topAnchor.constraint(equalTo: scroll.contentView.topAnchor)
        ])
        func add(_ view: NSView) {
            stack.addArrangedSubview(view)
            view.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -72).isActive = true
        }
        if let errorText { add(PanelNote(errorText)) }
        if !connected { add(PanelNote("Reconnecting to Gaddi. Decisions wait until it is back.")) }
        if !keyReady { add(PanelNote("Touch ID approval is unavailable. Quit and reopen Gaddi to retry.")) }
        let displayed = requestedID.map { id in snapshot.approvals.filter { $0.id == id } } ?? snapshot.approvals
        if requestedID != nil && displayed.isEmpty {
            let gone = NSTextField(wrappingLabelWithString: "This request is no longer waiting. It was answered or it expired.")
            gone.font = Typeface.interface(14); gone.textColor = Palette.inkSoft; add(gone)
        }
        if requestedID != nil && snapshot.approvals.count > displayed.count {
            add(PanelButton("Show all \(snapshot.approvals.count) waiting", kind: .quiet) { [weak self] in
                self?.requestedID = nil; self?.renderApprovals()
            })
        }
        if !displayed.isEmpty || (snapshot.approvals.isEmpty && requestedID == nil) {
            add(ReviewList(displayed, enabled: connected && keyReady && !busy, remote: snapshot.remoteApprovable,
                decide: { [weak self] approval, verb in self?.decide(approval, verb: verb) },
                decideAll: { [weak self] approvals, verb in self?.decideAll(approvals, verb: verb) },
                zone: { [weak self] approval in self?.makeZone(approval) }))
        }
        add(PanelRule())
        add(ZoneList(snapshot.zones, canAdd: connected && keyReady && !busy, canRemove: connected && !busy,
            add: { [weak self] site in self?.addZones([site], answering: nil) },
            remove: { [weak self] site in self?.removeZone(site) }))
        add(PanelRule())
        // Standing authority comes first and is always shown, even empty. Ending a grant needs no
        // Touch ID (it only removes authority), so this list does not wait for the signing key.
        add(SessionGrantList(snapshot.grants, enabled: connected && !busy) { [weak self] grant in
            self?.endGrant(grant)
        })
        add(PanelRule())
        // Also standing authority, so always shown. Turning it on needs Touch ID; turning it off only removes authority.
        add(RemotePanel(snapshot.remote, decisions: snapshot.remoteDecisions, canTurnOn: connected && keyReady && !busy, canTurnOff: connected && !busy,
                        turnOn: { [weak self] in self?.turnOnRemote() }, turnOff: { [weak self] in self?.turnOffRemote() }))
        add(PanelRule())
        add(RememberedSigninList(snapshot.rememberedSignins, enabled: connected && keyReady && !busy) { [weak self] site in
            self?.revokeSignin(site)
        })
        add(PanelRule())
        add(RememberedSendList(snapshot.rememberedSends, enabled: connected && keyReady && !busy) { [weak self] rule in
            self?.revokeSend(rule)
        })
        add(PanelRule())
        add(RememberedUploadList(uploads: snapshot.rememberedUploads, enabled: connected && keyReady && !busy) { [weak self] site in
            self?.revokeUpload(site)
        })
    }
    static func bannerID(_ caller: String) -> String { "agent:" + caller }
    private func notify(_ approval: Approval) {
        // One banner per agent, replaced as its requests arrive, so a burst is one notification, not a flood.
        let waiting = snapshot.approvals.filter { $0.caller == approval.caller && !$0.expired }.count
        let caller = approval.caller.unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) && !(0x202A...0x202E).contains($0.value) && !(0x2066...0x2069).contains($0.value) }.map(String.init).joined()
        let content = UNMutableNotificationContent()
        content.title = waiting > 1 ? "\(caller) has \(waiting) requests waiting" : approval.notification()
        content.body = (waiting > 1 ? "Latest: " + approval.notification() + "." : ApprovalWords.reason(approval.reason)) + " Open Gaddi to decide."
        content.sound = waiting > 1 ? nil : .default
        content.userInfo = ["id": approval.id]
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: Self.bannerID(approval.caller), content: content, trigger: nil)) { error in
            if let error { diagnostic("Approval notification failed: \(error.localizedDescription)") }
        }
        // Notification authorization and Focus mode cannot hide the decision:
        // the authoritative snapshot also presents the panel, without authenticating.
    }
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound])
    }
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        DispatchQueue.main.async {
            let raw = response.notification.request.content.userInfo["id"] as? String ?? response.notification.request.identifier
            if let id = approvalRequestID(raw) { self.ownerAsked = true; self.requestApproval(id) }
            // A banner whose request has gone still opens the review: clicking it must always show something.
            else { self.openApprovals() }
        }; completionHandler()
    }
    private func showError(_ title: String, error: Error) {
        // Background failures stay readable without taking keyboard focus.
        errorText = "\(title): \(error.localizedDescription)"
        diagnostic(errorText!)
        render()
    }

    private func authenticated(reason: String, operation: @escaping (LAContext) throws -> Void) {
        guard connected && keyReady && !busy else { return }
        errorText = nil
        busy = true; render()
        authenticate(reason: reason) { [weak self] result in
            guard let self else { return }
            self.model.queue.async {
                var failure: Error?
                do {
                    let context = try result.get()
                    defer { context.invalidate() }
                    try operation(context)
                    self.model.refresh()
                } catch { failure = error }
                let finalError = failure
                DispatchQueue.main.async {
                    self.busy = false; self.render()
                    if let finalError { self.showError("Action was not completed", error: finalError) }
                    self.presentPendingApprovals()
                }
            }
        }
    }
    private func decide(_ approval: Approval, verb choice: String) {
        guard !approval.expired else { return }
        let remember = choice == "remember"
        let verb = remember ? "grant" : choice
        let action = remember ? "Always allow \(approval.kind == "signin" ? "sign-in" : approval.kind == "upload" ? "uploads" : "this send action") on \(approval.site ?? "")" : verb == "grant" ? "Approve" : "Deny"
        // The Touch ID sheet is drawn by macOS, so it carries the substance: a session grant is named as one,
        // with how long it lasts and what it waives (the first three rules, then a count).
        let prompt: String
        if approval.kind == "grant" {
            let parts = ApprovalWords.grantParts(approval.detail)
            let more = parts.rules.count > 3 ? " and \(parts.rules.count - 3) more" : ""
            prompt = "\(action) a session grant for \(approval.caller) lasting \(parts.duration ?? "a while"): \(parts.rules.prefix(3).joined(separator: ", "))\(more)"
        } else {
            prompt = "\(action) \(approval.kind): \(approval.detail)"
        }
        authenticated(reason: prompt) { [self] context in
            let list = try model.client.call("approvals.list")
            let current = (list["pending"] as? [JSONObject] ?? [])
                .filter { $0["status"] as? String == "pending" }.compactMap(Approval.init).first { $0.id == approval.id }
            // The facts approved on screen must still be pending and unchanged after
            // authentication. No new action may inherit a prompt for an earlier one.
            guard let current, !current.expired, current == approval else { throw AppError("This approval has expired, changed or already been resolved") }
            let ts = Int64(Date().timeIntervalSince1970 * 1000)
            let message = try current.signingMessage(verb: verb, timestamp: ts, remember: remember)
            let signed = try keys.sign(message, context: context)
            _ = try model.client.call("approval.\(verb)", ["id": approval.id, "remember": remember,
                "proof": ["ts": ts, "sig": signed.signature.base64EncodedString()]])
        }
    }
    /// One Touch ID for a whole group from one agent. Each request is still signed on its own, and only if it is
    /// still waiting and unchanged after authentication; a request that changed is skipped and named.
    private func decideAll(_ group: [Approval], verb: String) {
        let live = group.filter { !$0.expired }
        guard !live.isEmpty, ["grant", "deny"].contains(verb) else { return }
        // Invariant: bulk approval only for the tier a grant could cover; anything else is approved one by one.
        if verb == "grant" && live.contains(where: { $0.kind != "grant" && $0.zoneSites.isEmpty }) { return }
        let caller = live[0].caller
        let what = live.prefix(3).map { "\(ApprovalWords.title($0).verb) \(ApprovalWords.title($0).object)" }.joined(separator: "; ")
        let more = live.count > 3 ? " and \(live.count - 3) more" : ""
        authenticated(reason: "\(verb == "grant" ? "Approve" : "Deny") \(live.count) requests from \(caller): \(what)\(more)") { [self] context in
            let list = try model.client.call("approvals.list")
            let pending = (list["pending"] as? [JSONObject] ?? []).filter { $0["status"] as? String == "pending" }.compactMap(Approval.init)
            var skipped = 0
            for approval in live {
                guard let current = pending.first(where: { $0.id == approval.id }), !current.expired, current == approval else { skipped += 1; continue }
                let ts = Int64(Date().timeIntervalSince1970 * 1000)
                let signed = try keys.sign(try current.signingMessage(verb: verb, timestamp: ts), context: context)
                do {
                    _ = try model.client.call("approval.\(verb)", ["id": approval.id, "remember": false,
                        "proof": ["ts": ts, "sig": signed.signature.base64EncodedString()]])
                } catch { skipped += 1 }
            }
            if skipped > 0 { throw AppError("\(skipped) of \(live.count) had changed, expired or were already answered; the rest were done") }
        }
    }
    /// TEST-ZONE from a waiting request: its sites become test zones and the request is answered, with one Touch ID.
    private func makeZone(_ approval: Approval) {
        let sites = approval.zoneSites
        guard !sites.isEmpty, !approval.expired else { return }
        addZones(sites, answering: approval)
    }
    private func addZones(_ sites: [String], answering approval: Approval?) {
        guard !sites.isEmpty else { return }
        let named = sites.joined(separator: ", ")
        authenticated(reason: "Make \(named) a test zone: agents sign in, upload, post, delete and change account settings there without asking until you remove it") { [self] context in
            var refused: [String] = []
            for site in sites {
                let ts = Int64(Date().timeIntervalSince1970 * 1000)
                let signed = try keys.sign(try zoneAddMessage(site: site, timestamp: ts), context: context)
                do {
                    _ = try model.client.call("zones.add", ["site": site, "proof": ["ts": ts, "sig": signed.signature.base64EncodedString()]])
                } catch { refused.append(ApprovalWords.host(site)) }
            }
            // Fail first: the owner chose standing test authority, so a one-time action is approved only when every
            // site really became a zone.
            if !refused.isEmpty { throw AppError("\(refused.joined(separator: ", ")) cannot be a test zone (a protected site, or not a whole https site); nothing was approved") }
            // A grant request the zones now cover is closed by the broker. A one-time action is approved too, so the
            // agent's retry with its id goes through; the zone answers every later one.
            if let approval, approval.kind != "grant" {
                let list = try model.client.call("approvals.list")
                let current = (list["pending"] as? [JSONObject] ?? []).filter { $0["status"] as? String == "pending" }
                    .compactMap(Approval.init).first { $0.id == approval.id }
                if let current, !current.expired, current == approval {
                    let ts = Int64(Date().timeIntervalSince1970 * 1000)
                    let signed = try keys.sign(try current.signingMessage(verb: "grant", timestamp: ts), context: context)
                    _ = try model.client.call("approval.grant", ["id": approval.id, "remember": false,
                        "proof": ["ts": ts, "sig": signed.signature.base64EncodedString()]])
                }
            }
        }
    }
    private func removeZone(_ site: String) {
        // Removing a zone only takes authority away, so it asks for no Touch ID.
        guard connected, !busy else { return }
        model.queue.async { [self] in
            do { _ = try model.client.call("zones.remove", ["site": site]) }
            catch { DispatchQueue.main.async { self.showError("The test zone was not removed", error: error) } }
            model.refresh()
        }
    }
    private func endGrant(_ grant: SessionGrant) {
        // Ending a grant only removes authority, so it asks for no Touch ID. A grant that has
        // already ended is the outcome the owner wanted, not an error.
        guard connected, !busy else { return }
        model.queue.async { [self] in
            do {
                _ = try model.client.call("grants.revoke", ["id": grant.id])
            } catch {
                if !error.localizedDescription.contains("no such active session grant") {
                    DispatchQueue.main.async { self.showError("The grant was not ended", error: error) }
                }
            }
            model.refresh()
        }
    }
    private func turnOnRemote() {
        guard let candidate = snapshot.remote.candidate, connected, keyReady, !busy else { return }
        // The fingerprint is put in front of the owner before anything is signed, so he can compare it with the one
        // his phone approver shows. Touch ID then signs that exact fingerprint. The button he pressed is in Gaddi's
        // own front panel, so the alert needs no activation of its own (only openApprovals ever takes focus).
        let alert = NSAlert()
        alert.messageText = "Turn on approving from your phone?"
        alert.informativeText = "The key waiting has the fingerprint \(shortFingerprint(candidate)). Check that your phone approver shows the same digits.\n\nIt will then be able to approve uploads, posts and deletes on the pages an agent names, and session grants of up to 2 hours. Payments, purchases, sign-in, security pages and sending messages stay Touch ID only."
        alert.addButton(withTitle: "Turn on with Touch ID")
        alert.addButton(withTitle: "Cancel")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        authenticated(reason: "Turn on approving from your phone for the key \(shortFingerprint(candidate))") { [self] context in
            // What he confirmed must still be what is waiting after he authenticates.
            let current = try model.client.call("remote.status")
            guard let status = RemoteStatus(current), status.candidate == candidate else {
                throw AppError("The phone approver's key changed. Look at its new fingerprint and try again.")
            }
            let ts = Int64(Date().timeIntervalSince1970 * 1000)
            let message = try remoteEnableMessage(fingerprint: candidate, timestamp: ts)
            let signed = try keys.sign(message, context: context)
            _ = try model.client.call("remote.enable", ["fingerprint": candidate,
                "proof": ["ts": ts, "sig": signed.signature.base64EncodedString()]])
        }
    }
    private func turnOffRemote() {
        // Ending it only removes authority, so it asks for no Touch ID. Already off is the outcome the owner wanted.
        guard connected, !busy else { return }
        model.queue.async { [self] in
            do {
                _ = try model.client.call("remote.disable")
            } catch {
                DispatchQueue.main.async { self.showError("Phone approvals were not turned off", error: error) }
            }
            model.refresh()
        }
    }
    private func revokeSend(_ rule: SendPermission) {
        authenticated(reason: "Require approval for \(rule.label.lowercased()) on \(rule.site)") { [self] context in
            let list = try model.client.call("sends.remembered")
            guard let rows = list["rules"] as? [JSONObject], rows.compactMap(SendPermission.init).contains(rule) else {
                throw AppError("This send permission has already been revoked")
            }
            let ts = Int64(Date().timeIntervalSince1970 * 1000)
            let signed = try keys.sign(rule.revokeMessage(timestamp: ts), context: context)
            var parameters = rule.parameters
            parameters["proof"] = ["ts": ts, "sig": signed.signature.base64EncodedString()]
            _ = try model.client.call("sends.revoke", parameters)
        }
    }
    private func revokeUpload(_ site: String) {
        authenticated(reason: "Require approval for uploads on \(site)") { [self] context in
            let list = try model.client.call("uploads.remembered")
            guard let sites = list["sites"] as? [String], sites.contains(site) else {
                throw AppError("This upload permission has already been revoked")
            }
            let ts = Int64(Date().timeIntervalSince1970 * 1000)
            let signed = try keys.sign(uploadRevokeMessage(site: site, timestamp: ts), context: context)
            _ = try model.client.call("uploads.revoke", ["site": site,
                "proof": ["ts": ts, "sig": signed.signature.base64EncodedString()]])
        }
    }
    private func revokeSignin(_ site: String) {
        authenticated(reason: "Require approval for sign-in on \(site)") { [self] context in
            let list = try model.client.call("signin.remembered")
            guard let sites = list["sites"] as? [String], sites.contains(site) else {
                throw AppError("This sign-in grant has already been revoked")
            }
            let ts = Int64(Date().timeIntervalSince1970 * 1000)
            let message = try signinRevokeMessage(site: site, timestamp: ts)
            let signed = try keys.sign(message, context: context)
            _ = try model.client.call("signin.revoke", ["site": site,
                "proof": ["ts": ts, "sig": signed.signature.base64EncodedString()]])
        }
    }
}
