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
        check(!visibility.shouldPresent([], busy: false, now: now), "idle startup does not present")
        check(visibility.shouldPresent([first], busy: false, now: now), "pending snapshot presents even without notifications or events")
        check(!visibility.shouldPresent([first], busy: false, now: now), "already-running polls do not present a dismissed panel")
        check(visibility.shouldPresent([first, second], busy: false, now: now), "another genuine pending action presents once")
        check(!visibility.shouldPresent([first, second], busy: false, now: now), "unchanged reconnect snapshot does not reopen the panel")
        check(!visibility.shouldPresent([], busy: false, now: now), "resolution does not present")
        check(visibility.shouldPresent([first], busy: false, now: now), "restored pending after resolved grant presents again")
        var restarted = PendingApprovalVisibility()
        check(restarted.shouldPresent([first, second], busy: false, now: now), "cold app presents restored pending snapshot")
        var authenticating = PendingApprovalVisibility()
        check(!authenticating.shouldPresent([first], busy: true, now: now), "incoming request does not replace an authentication in progress")
        check(authenticating.shouldPresent([first], busy: false, now: now), "pending request presents after authentication finishes")
        check(!authenticating.shouldPresent([first], busy: false, now: now), "deferred request presents only once")
        var stale = PendingApprovalVisibility()
        let expired = approval("expired", expires: now)
        check(!stale.shouldPresent([expired], busy: false, now: expired.expiresAt!), "expired snapshot cannot present")
        let invalid = Approval(["id": "invalid", "kind": "click", "detail": "Delete fixture", "expiresAt": "invalid"])!
        check(!stale.shouldPresent([invalid], busy: false, now: now), "missing valid expiry cannot present")
        var manuallyOpened = PendingApprovalVisibility()
        manuallyOpened.acknowledge([first])
        check(!manuallyOpened.shouldPresent([first], busy: false, now: now), "explicit selection does not auto-present again on the next poll")
        var review = PendingApprovalVisibility()
        review.opened([first, second])
        check(!review.shouldDismiss([second], connected: true, busy: false, hasError: false), "another waiting approval keeps the review open")
        check(!review.shouldDismiss([], connected: false, busy: false, hasError: false), "disconnect cannot dismiss a review using stale state")
        check(!review.shouldDismiss([], connected: true, busy: true, hasError: false), "authentication keeps the review open until completion")
        check(!review.shouldDismiss([], connected: true, busy: false, hasError: true), "a decision error remains readable")
        check(review.shouldDismiss([], connected: true, busy: false, hasError: false), "the last approval closes its finished review")
        check(!review.shouldDismiss([], connected: true, busy: false, hasError: false), "repeated empty polls do not close again")
        review.opened([])
        check(!review.shouldDismiss([], connected: true, busy: false, hasError: false), "manually opened settings remain available with an empty queue")
        review.opened([first], preservingCurrentMode: true)
        check(!review.shouldDismiss([], connected: true, busy: false, hasError: false), "an intervening automatic approval preserves already-visible settings")
        review.opened([first])
        check(review.shouldDismiss([], connected: true, busy: false, hasError: false), "a later approval review closes when it is resolved from the phone or expires")
        review.opened([])
        review.opened([first], preservingCurrentMode: false)
        check(review.shouldDismiss([], connected: true, busy: false, hasError: false), "closing settings then opening a new automatic review does not retain the settings mode")
        var float = ReviewWindowFloat()
        float.opened(at: now)
        check(float.floating, "an opened review floats above other apps")
        check(!float.otherAppActivated(at: now.addingTimeInterval(0.3)) && float.floating, "the activation macOS hands back right after a banner does not bury the review")
        check(float.otherAppActivated(at: now.addingTimeInterval(2)) && !float.floating, "switching to another app later lets that app come to the front")
        check(!float.otherAppActivated(at: now.addingTimeInterval(3)), "a dropped review is not dropped twice")
        float.opened(at: now)
        check(float.clickedInOtherApp() && !float.floating, "a click in another app at once lets that app come to the front")
        float.opened(at: now); float.closed()
        check(!float.floating && !float.clickedInOtherApp(), "a closed review no longer floats")
        print("== app approval visibility: \(passed) passed, 0 failed")
    }
}
