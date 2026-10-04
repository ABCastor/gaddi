import Foundation

@main struct VisibilityChecks {
    static func main() {
        var passed = 0
        func check(_ value: Bool, _ label: String) {
            guard value else { diagnostic("FAIL \(label)"); exit(1) }
            passed += 1; print("PASS \(label)")
        }
        let now = Date()
        func approval(_ id: String, expires: Date = now.addingTimeInterval(600)) -> Approval {
            Approval(["id": id, "kind": "click", "detail": "Delete fixture", "expiresAt": expires.timeIntervalSince1970 * 1000])!
        }
        let first = approval("first"), second = approval("second")
        var visibility = PendingApprovalVisibility()
        check(!visibility.shouldPresent([], busy: false, now: now), "idle startup does not foreground")
        check(visibility.shouldPresent([first], busy: false, now: now), "pending snapshot foregrounds even without notifications or events")
        check(!visibility.shouldPresent([first], busy: false, now: now), "already-running polls do not foreground a dismissed panel")
        check(visibility.shouldPresent([first, second], busy: false, now: now), "another genuine pending action foregrounds once")
        check(!visibility.shouldPresent([first, second], busy: false, now: now), "unchanged reconnect snapshot does not steal focus")
        check(!visibility.shouldPresent([], busy: false, now: now), "resolution does not foreground")
        check(visibility.shouldPresent([first], busy: false, now: now), "restored pending after resolved grant foregrounds again")
        var restarted = PendingApprovalVisibility()
        check(restarted.shouldPresent([first, second], busy: false, now: now), "cold app foregrounds restored pending snapshot")
        var authenticating = PendingApprovalVisibility()
        check(!authenticating.shouldPresent([first], busy: true, now: now), "incoming request does not replace an authentication in progress")
        check(authenticating.shouldPresent([first], busy: false, now: now), "pending request foregrounds after authentication finishes")
        check(!authenticating.shouldPresent([first], busy: false, now: now), "deferred request foregrounds only once")
        var stale = PendingApprovalVisibility()
        let expired = approval("expired", expires: now)
        check(!stale.shouldPresent([expired], busy: false, now: expired.expiresAt!), "expired snapshot cannot foreground")
        let invalid = Approval(["id": "invalid", "kind": "click", "detail": "Delete fixture", "expiresAt": "invalid"])!
        check(!stale.shouldPresent([invalid], busy: false, now: now), "missing valid expiry cannot foreground")
        var manuallyOpened = PendingApprovalVisibility()
        manuallyOpened.acknowledge([first])
        check(!manuallyOpened.shouldPresent([first], busy: false, now: now), "explicit selection does not auto-foreground again on the next poll")
        print("== app approval visibility: \(passed) passed, 0 failed")
    }
}
