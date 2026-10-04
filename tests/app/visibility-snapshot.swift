import Foundation

@main struct SnapshotVisibilityChecks {
    static func main() {
        let model = BrowserModel()
        var visibility = PendingApprovalVisibility()
        var presentations = [[String]]()
        var events = 0
        // Notification delivery is intentionally absent. This is the same state
        // transition AppController uses to decide whether to foreground its panel.
        model.onSnapshot = { snapshot in
            if visibility.shouldPresent(snapshot.approvals, busy: false) {
                let ids = snapshot.approvals.map(\.id)
                presentations.append(ids)
                print("PRESENT \(ids.joined(separator: ","))")
                fflush(stdout)
            }
        }
        model.onEvent = { _, _ in events += 1 }
        model.start()
        model.queue.asyncAfter(deadline: .now() + 5.5) { model.refresh() }
        model.queue.asyncAfter(deadline: .now() + 6) {
            model.stop()
            guard events == 0, presentations == [["existing"], ["existing", "lost-event"]] else {
                diagnostic("FAIL lost-event visibility: events=\(events) presentations=\(presentations)")
                exit(1)
            }
            print("PASS restored hold presents from initial snapshot without an event or notification")
            print("PASS running app discovers lost pending event on its five-second refresh")
            print("PASS repeated refresh does not re-present the same approvals")
            print("== app snapshot visibility: 3 passed, 0 failed")
            exit(0)
        }
        dispatchMain()
    }
}
