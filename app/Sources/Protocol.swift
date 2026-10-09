import Foundation
import CryptoKit
import CoreFoundation

func string(_ value: Any?) -> String? {
    if let value = value as? String { return value }
    if let value = value as? NSNumber { return value.stringValue }
    return nil
}
func instant(_ value: Any?) -> Date? {
    if let number = value as? NSNumber { return Date(timeIntervalSince1970: number.doubleValue / 1000) }
    guard let text = value as? String else { return nil }
    let parser = ISO8601DateFormatter()
    parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return parser.date(from: text) ?? ISO8601DateFormatter().date(from: text)
}
func displayTime(_ date: Date) -> String {
    let formatter = DateFormatter()
    // Minutes are what a ten-minute window needs; seconds only add noise.
    formatter.timeStyle = .short
    return formatter.string(from: date)
}

struct ApprovalBox: Equatable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
    init?(_ value: Any?) {
        guard let object = value as? JSONObject else { return nil }
        func number(_ key: String) -> Double? {
            guard let value = object[key] as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID(),
                  value.doubleValue.isFinite else { return nil }
            return value.doubleValue
        }
        guard let x = number("x"), let y = number("y"), let width = number("width"), let height = number("height"),
              x >= 0, y >= 0, width > 0, height > 0, (x + width).isFinite, (y + height).isFinite else { return nil }
        self.x = x; self.y = y; self.width = width; self.height = height
    }
}

struct Approval: Equatable {
    let id: String
    let kind: String
    let tab: String
    let detail: String
    let reason: String
    let caller: String
    let url: String
    let site: String?
    let rememberable: Bool
    let expiresAt: Date?
    let imagePath: String?
    let box: ApprovalBox?
    init?(_ object: JSONObject) {
        guard let id = string(object["id"]), let kind = object["kind"] as? String,
              let detail = object["detail"] as? String else { return nil }
        self.id = id; self.kind = kind; self.detail = detail
        tab = string(object["tab"]) ?? ""
        reason = object["reason"] as? String ?? "No reason supplied"
        caller = object["caller"] as? String ?? "unknown"
        url = object["url"] as? String ?? ""
        site = object["site"] as? String
        rememberable = object["rememberable"] as? Bool ?? false
        expiresAt = instant(object["expiresAt"] ?? object["expires"])
        imagePath = (object["imagePath"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        box = ApprovalBox(object["box"])
    }
    var sendPermission: SendPermission? {
        guard rememberable, let site else { return nil }
        return SendPermission(["site": site, "kind": kind, "reason": reason])
    }
    var canRemember: Bool { kind == "signin" && site != nil || sendPermission != nil }
    var expired: Bool { expiresAt.map { $0 <= Date() } ?? true }
    /// What the banner says. Plain words, the same sentence the panel opens with;
    /// the policy's own reason string never reaches a surface the user reads.
    func notification() -> String {
        let words = ApprovalWords.title(self)
        return "\(caller) wants to \(words.verb) \(words.object)"
    }
    func signingMessage(verb: String, timestamp: Int64, remember: Bool = false) throws -> String {
        guard ["grant", "deny"].contains(verb) else { throw AppError("Invalid approval decision") }
        // Bind human proof to the exact UTF-8 detail, kind, tab, ID and millisecond timestamp.
        // Delimiters in identity fields would make the signed tuple ambiguous, so refuse them.
        guard [id, kind, tab].allSatisfy({ !$0.contains("|") }) else { throw AppError("Invalid approval identity") }
        let digest = SHA256.hash(data: Data(detail.utf8)).map { String(format: "%02x", $0) }.joined()
        let message = "\(verb)|\(id)|\(kind)|\(tab)|\(digest)|\(timestamp)"
        guard remember else { return message }
        guard verb == "grant", canRemember, let site, !site.isEmpty, !site.contains("|") else {
            throw AppError("Only a sign-in or eligible send grant can remember a site")
        }
        return kind == "signin" ? "\(message)|remember|\(site)" : "\(message)|remember|\(site)|\(reason)"
    }
}

func signinRevokeMessage(site: String, timestamp: Int64) throws -> String {
    guard !site.isEmpty, !site.contains("|") else { throw AppError("Invalid sign-in origin") }
    return "signin.revoke|\(site)|\(timestamp)"
}

struct SendPermission: Equatable {
    let site: String
    let kind: String
    let reason: String
    init?(_ object: JSONObject) {
        guard let site = object["site"] as? String, !site.isEmpty, !site.contains("|"),
              let kind = object["kind"] as? String, let reason = object["reason"] as? String,
              ["send", "send now", "invia", "invia ora"].contains(where: {
                  reason == (kind == "click" ? "verb:" : kind == "press" ? "enter-submits:" : "invalid:") + $0
              }), ["click", "press"].contains(kind) else { return nil }
        self.site = site; self.kind = kind; self.reason = reason
    }
    var label: String { kind == "press" ? "Send with Enter" : "Send button" }
    var parameters: JSONObject { ["site": site, "kind": kind, "reason": reason] }
    func revokeMessage(timestamp: Int64) -> String { "sends.revoke|\(site)|\(kind)|\(reason)|\(timestamp)" }
}

/// An owner-approved, time-limited permission for one chat. The broker never sends the chat's
/// identity: the panel shows who asked, what is waived and until when, and can end it at once.
struct SessionGrant: Equatable {
    let id: String
    let caller: String
    let label: String?
    /// Canonical rules, e.g. "upload https://github.com/settings".
    let rules: [String]
    let expiresAt: Date
    init?(_ object: JSONObject) {
        guard let id = string(object["id"]), !id.isEmpty, let rules = object["rules"] as? [String], !rules.isEmpty,
              let expiresAt = instant(object["expiresAt"]) else { return nil }
        self.id = id; self.rules = rules; self.expiresAt = expiresAt
        caller = object["caller"] as? String ?? "unknown"
        label = (object["label"] as? String).flatMap { $0.isEmpty ? nil : $0 }
    }
    var expired: Bool { expiresAt <= Date() }
}

struct Snapshot: Equatable {
    var approvals: [Approval] = []
    var rememberedSignins: [String] = []
    var rememberedSends: [SendPermission] = []
    var grants: [SessionGrant] = []
}

/// Visibility follows authoritative pending snapshots, never notification delivery.
/// An unchanged poll cannot take focus again after the owner closes the panel.
struct PendingApprovalVisibility {
    private var presented = Set<String>()
    mutating func shouldPresent(_ approvals: [Approval], busy: Bool, now: Date = Date()) -> Bool {
        let pending = Set(approvals.filter { $0.expiresAt.map { $0 > now } ?? false }.map(\.id))
        presented.formIntersection(pending)
        guard !busy, !pending.subtracting(presented).isEmpty else { return false }
        presented = pending
        return true
    }
    mutating func acknowledge(_ approvals: [Approval]) {
        presented.formUnion(approvals.filter { !$0.expired }.map(\.id))
    }
}

/// One serial work queue orders snapshots, events and user calls. Reconnects replace
/// the whole snapshot so an approval event lost during downtime cannot linger.
final class BrowserModel {
    let client = SocketClient()
    let queue = DispatchQueue(label: "gaddi.model")
    var onSnapshot: ((Snapshot) -> Void)?
    var onPending: ((Approval) -> Void)?
    var onEvent: ((String, JSONObject) -> Void)?
    var onConnection: ((Bool, String) -> Void)?
    private var snapshot = Snapshot()
    private var knownPending = Set<String>()
    private var refreshTimer: DispatchSourceTimer?

    func start() {
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + 5, repeating: 5)
        timer.setEventHandler { [weak self] in self?.refresh() }
        refreshTimer = timer; timer.resume()
        client.subscribe(onConnected: { [weak self] in
            self?.queue.async { [weak self] in
                guard let self else { return }
                self.onConnection?(true, "Connected")
                self.refresh()
            }
        }, onEvent: { [weak self] event in
            self?.queue.async { [weak self] in self?.handle(event) }
        }, onDisconnected: { [weak self] message in
            self?.queue.async { [weak self] in self?.onConnection?(false, message) }
        })
    }
    func stop() { refreshTimer?.cancel(); refreshTimer = nil; client.stop() }
    func refresh() {
        do {
            let approvals = try client.call("approvals.list")
            guard let approvalRows = approvals["pending"] as? [JSONObject] else {
                throw AppError("Daemon returned an invalid approval list")
            }
            let remembered = try client.call("signin.remembered")
            guard let sites = remembered["sites"] as? [String] else {
                throw AppError("Daemon returned an invalid remembered sign-in list")
            }
            let sends = try client.call("sends.remembered")
            guard let rules = sends["rules"] as? [JSONObject] else {
                throw AppError("Daemon returned an invalid remembered send list")
            }
            let sendPermissions = rules.compactMap(SendPermission.init)
            guard sendPermissions.count == rules.count else { throw AppError("Daemon returned an invalid send permission") }
            var next = Snapshot()
            next.rememberedSends = sendPermissions.sorted { ($0.site, $0.kind, $0.reason) < ($1.site, $1.kind, $1.reason) }
            next.rememberedSignins = sites.sorted()
            // Session grants arrive with the approvals. A broker without them is simply older; a malformed
            // list is an error, because a grant the owner cannot see is authority he cannot end.
            if let rows = approvals["grants"] {
                guard let objects = rows as? [JSONObject] else { throw AppError("Daemon returned an invalid session grant list") }
                let parsed = objects.compactMap(SessionGrant.init)
                guard parsed.count == objects.count else { throw AppError("Daemon returned an invalid session grant") }
                next.grants = parsed.filter { !$0.expired }.sorted { ($0.expiresAt, $0.id) < ($1.expiresAt, $1.id) }
            }
            // Granted records remain in the broker queue until consumed, but need no further human decision.
            next.approvals = approvalRows.filter { $0["status"] as? String == "pending" }.compactMap(Approval.init)
                .filter { !$0.expired }.sorted { $0.id < $1.id }
            snapshot = next
            onSnapshot?(next)
            for approval in next.approvals where !knownPending.contains(approval.id) {
                onPending?(approval)
            }
            knownPending = Set(next.approvals.map(\.id))
        } catch { onConnection?(false, error.localizedDescription) }
    }
    private func handle(_ event: JSONObject) {
        guard let name = event["event"] as? String else { return }
        let data = event["data"] as? JSONObject ?? event
        onEvent?(name, data)
        switch name {
        case "approval.pending", "approval.resolved", "signin.remembered", "sends.remembered", "grants.changed":
            refresh()
        default: break
        }
    }
}

// Launch requests select an existing approval only; they never authorize a decision.
func approvalRequestID(_ value: String) -> String? {
    guard !value.isEmpty, value.utf8.count <= 128,
          value.utf8.allSatisfy({ (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || $0 == 45 || $0 == 95 }) else { return nil }
    return value
}
