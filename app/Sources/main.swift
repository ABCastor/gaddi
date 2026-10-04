import Foundation
import AppKit
import Security

func fail(_ error: Error) -> Never { diagnostic("Gaddi: \(error.localizedDescription)"); exit(1) }

func headlessCheck() -> Never {
    // This path does not instantiate AppKit, notifications, LAContext or SigningKey.
    let model = BrowserModel()
    var opened = Set<String>()
    var seenPending = false
    var shownApproval = false
    model.onConnection = { connected, message in
        print(connected ? "SUBSCRIBED events.subscribe" : "RECONNECT \(message)")
        fflush(stdout)
    }
    model.onEvent = { name, _ in
        print("EVENT \(name)")
        if name == "approval.pending" { seenPending = true }
    }
    model.onSnapshot = { snapshot in
        let current = Set(snapshot.approvals.map(\.id))
        for id in opened.subtracting(current).sorted() { print("RESOLVED approval=\(id)") }
        opened = current
        fflush(stdout)
    }
    model.onPending = { approval in
        print("NOTIFICATION \(approval.notification())")
        print("APPROVAL \(approval.id) kind=\(approval.kind) tab=\(approval.tab) detail=\(approval.detail) reason=\(approval.reason)")
        shownApproval = true; fflush(stdout)
    }
    model.start()
    let requested = Double(ProcessInfo.processInfo.environment["GADDI_HEADLESS_CHECK_SECONDS"] ?? "8") ?? 8
    model.queue.asyncAfter(deadline: .now() + min(max(requested, 1), 30)) {
        model.stop()
        if seenPending && shownApproval {
            print("PASS headless-check: approval.pending rendered without UI or authentication")
            exit(0)
        }
        diagnostic("FAIL headless-check: expected approval.pending within timeout")
        exit(1)
    }
    dispatchMain()
}

let arguments = Array(CommandLine.arguments.dropFirst())
if arguments == ["--headless-check"] { headlessCheck() }
if arguments == ["--print-public-key"] {
    do { print(try SigningKey().exportPublicKey(), terminator: ""); exit(0) } catch { fail(error) }
}
if arguments == ["--verify-self"] || (arguments.count == 2 && arguments.first == "--sign") {
    let verify = arguments.first == "--verify-self"
    let message = verify ? "Gaddi self verification \(UUID().uuidString)" : arguments[1]
    guard message.utf8.count <= 16_384 else { fail(AppError("Signing input exceeds 16 KiB")) }
    let keys = SigningKey()
    authenticate(reason: verify ? "Verify the Gaddi approver key" : "Sign: \(message)") { result in
        do {
            let context = try result.get()
            defer { context.invalidate() }
            let signed = try keys.sign(message, context: context)
            if verify {
                var error: Unmanaged<CFError>?
                guard SecKeyVerifySignature(signed.publicKey, .ecdsaSignatureMessageX962SHA256,
                                            Data(message.utf8) as CFData, signed.signature as CFData, &error) else {
                    throw error?.takeRetainedValue() as Error? ?? AppError("Self verification failed")
                }
                let output: JSONObject = ["verified": true, "message": message,
                    "sig": signed.signature.base64EncodedString(), "publicKey": try keys.exportPublicKey(from: signed.publicKey)]
                let data = try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys])
                print(String(decoding: data, as: UTF8.self))
            } else { print(signed.signature.base64EncodedString()) }
            exit(0)
        } catch { fail(error) }
    }
    RunLoop.main.run()
    exit(1)
}
let requestedID = arguments.count == 2 && arguments.first == "--approve" ? approvalRequestID(arguments[1]) : nil
if !arguments.isEmpty && requestedID == nil {
    diagnostic("Usage: Gaddi [--approve <id> | --print-public-key | --sign <string> | --verify-self | --headless-check]")
    exit(2)
}
if let requestedID,
   NSRunningApplication.runningApplications(withBundleIdentifier: "com.abcastor.gaddi")
    .contains(where: { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier }) {
    // A second launch may request the sheet; only a later authenticated click signs.
    DistributedNotificationCenter.default().postNotificationName(AppController.approvalNotification,
        object: nil, userInfo: ["id": requestedID], deliverImmediately: true)
    // The running app verifies this ID against its current pending snapshot
    // before foregrounding. A stale launch hint must not take focus.
    exit(0)
}
let application = NSApplication.shared
let delegate = AppController(approvalID: requestedID)
application.delegate = delegate
application.run()
