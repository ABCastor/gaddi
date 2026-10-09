import AppKit
import UserNotifications
import LocalAuthentication

final class AppController: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    private let model = BrowserModel()
    private let keys = SigningKey()
    private var statusItem: NSStatusItem!
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
        let grants: [SessionGrant]
        let requestedID: String?
        let connected: Bool
        let keyReady: Bool
        let busy: Bool
        let errorText: String?
    }
    private var panelState: ApprovalPanelState?
    private var approvalsPanel: NSPanel?
    private var timer: Timer?
    private var requestedID: String?
    private var launchRequestID: String?
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
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.image = StatusMark.image()
        statusItem.button?.imagePosition = .imageLeading
        statusItem.button?.toolTip = "Gaddi"
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
                let notifications = UNUserNotificationCenter.current()
                notifications.removeDeliveredNotifications(withIdentifiers: Array(resolved))
                notifications.removePendingNotificationRequests(withIdentifiers: Array(resolved))
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
                let notifications = UNUserNotificationCenter.current()
                notifications.removeDeliveredNotifications(withIdentifiers: expired)
                notifications.removePendingNotificationRequests(withIdentifiers: expired)
                self.snapshot.approvals.removeAll(where: \.expired)
                self.render()
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

    private func menuItem(_ title: String, action: Selector?, object: Any? = nil) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
        item.target = self; item.representedObject = object
        return item
    }
    private func render() {
        let menu = NSMenu()
        let waiting = snapshot.approvals.count
        menu.addItem(menuItem(!connected ? connectionText
            : waiting == 0 ? "Nothing is waiting for you"
            : waiting == 1 ? "1 action is waiting for you" : "\(waiting) actions are waiting for you", action: nil))
        if let errorText { menu.addItem(menuItem(errorText, action: nil)) }
        let running = snapshot.grants.count
        if running > 0 { menu.addItem(menuItem(running == 1 ? "1 session grant active" : "\(running) session grants active", action: nil)) }
        menu.addItem(.separator())
        menu.addItem(menuItem(snapshot.approvals.isEmpty ? "Open Gaddi…" : "Review and decide…", action: #selector(openApprovals)))
        menu.addItem(menuItem("Remembered sign-ins…", action: #selector(openRememberedSignins)))
        menu.addItem(.separator())
        menu.addItem(menuItem("Quit Gaddi", action: #selector(quit)))
        menu.autoenablesItems = false
        statusItem.menu = menu
        statusItem.button?.title = snapshot.approvals.isEmpty ? "" : " \(snapshot.approvals.count)"
        if approvalsPanel != nil { renderApprovals() }
    }
    @objc private func quit() { NSApp.terminate(nil) }
    @objc private func openRememberedSignins() { requestedID = nil; openApprovals() }
    private func presentPendingApprovals() {
        guard connected else { return }
        // A launch or notification ID is just a selection hint. Only the broker's
        // current, unexpired pending list may cause an automatic foreground window.
        if let id = launchRequestID, !busy {
            launchRequestID = nil
            if snapshot.approvals.contains(where: { $0.id == id && !$0.expired }) {
                requestedID = id
                visibility.acknowledge(snapshot.approvals)
                openApprovals()
                return
            }
        }
        if visibility.shouldPresent(snapshot.approvals, busy: busy) {
            requestedID = nil
            openApprovals()
        }
    }
    @objc private func openApprovals() {
        if approvalsPanel == nil {
            let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 600, height: 620),
                                styleMask: [.titled, .closable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
            panel.title = "Gaddi"; panel.titlebarAppearsTransparent = true
            panel.backgroundColor = Palette.paper; panel.isReleasedWhenClosed = false
            panel.minSize = NSSize(width: 480, height: 320); panel.center(); approvalsPanel = panel
        }
        renderApprovals()
        approvalsPanel?.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
    }
    private func renderApprovals() {
        guard let panel = approvalsPanel else { return }
        let state = ApprovalPanelState(approvals: snapshot.approvals,
            rememberedSignins: snapshot.rememberedSignins,
            rememberedSends: snapshot.rememberedSends,
            grants: snapshot.grants,
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
            add(ApprovalList(displayed, enabled: connected && keyReady && !busy) { [weak self] approval, verb in
                self?.decide(approval, verb: verb)
            })
        }
        add(PanelRule())
        // Standing authority comes first and is always shown, even empty. Ending a grant needs no
        // Touch ID (it only removes authority), so this list does not wait for the signing key.
        add(SessionGrantList(snapshot.grants, enabled: connected && !busy) { [weak self] grant in
            self?.endGrant(grant)
        })
        add(PanelRule())
        add(RememberedSigninList(snapshot.rememberedSignins, enabled: connected && keyReady && !busy) { [weak self] site in
            self?.revokeSignin(site)
        })
        add(PanelRule())
        add(RememberedSendList(snapshot.rememberedSends, enabled: connected && keyReady && !busy) { [weak self] rule in
            self?.revokeSend(rule)
        })
    }
    private func notify(_ approval: Approval) {
        let content = UNMutableNotificationContent()
        content.title = approval.notification()
        content.body = ApprovalWords.reason(approval.reason) + " Open Gaddi to decide."; content.sound = .default
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: approval.id, content: content, trigger: nil)) { error in
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
            if let id = approvalRequestID(response.notification.request.identifier) { self.requestApproval(id) }
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
        let action = remember ? "Always allow \(approval.kind == "signin" ? "sign-in" : "this send action") on \(approval.site ?? "")" : verb == "grant" ? "Approve" : "Deny"
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
