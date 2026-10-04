// Non-interactive checks for the production protocol parser and socket client.
import Foundation
var passed = 0
func check(_ condition: @autoclosure () -> Bool, _ label: String) {
    guard condition() else { diagnostic("FAIL \(label)"); exit(1) }
    passed += 1; print("PASS \(label)")
}
func rejects(_ label: String, _ body: () throws -> Void) {
    do { try body(); diagnostic("FAIL \(label): accepted"); exit(1) }
    catch { passed += 1; print("PASS \(label)") }
}
let object: JSONObject = ["id": "a1", "kind": "click", "tab": 42, "detail": "click Pay café",
                          "expiresAt": "2099-01-01T00:00:00.000Z"]
let approval = Approval(object)!
check(approval.imagePath == nil && approval.box == nil, "old approval decodes without a picture")
var pictured = object
pictured["imagePath"] = "/disposable/approval.jpg"
pictured["box"] = ["x": 12.5, "y": 20, "width": 100, "height": 40]
let pictureApproval = Approval(pictured)!
check(pictureApproval.imagePath == "/disposable/approval.jpg" && pictureApproval.box?.x == 12.5 &&
      pictureApproval.box?.y == 20 && pictureApproval.box?.width == 100 && pictureApproval.box?.height == 40,
      "picture path and pixel box decode")
check(try! pictureApproval.signingMessage(verb: "grant", timestamp: 1) == approval.signingMessage(verb: "grant", timestamp: 1),
      "display-only picture leaves signing message unchanged")
for invalid: Any in [NSNull(), "box", ["x": 1, "y": 2, "width": 3],
                     ["x": -1, "y": 0, "width": 3, "height": 4],
                     ["x": 0, "y": 0, "width": 0, "height": 4],
                     ["x": "1", "y": 0, "width": 3, "height": 4],
                     ["x": true, "y": 0, "width": 3, "height": 4],
                     ["x": 0, "y": Double.infinity, "width": 3, "height": 4],
                     ["x": 0, "y": 0, "width": Double.nan, "height": 4]] {
    var invalidPicture = pictured; invalidPicture["box"] = invalid
    let decoded = Approval(invalidPicture)
    check(decoded != nil && decoded?.box == nil, "malformed picture box ignored without dropping approval")
}
for invalid: Any in [NSNull(), 123, ""] {
    var invalidPicture = pictured; invalidPicture["imagePath"] = invalid
    let decoded = Approval(invalidPicture)
    check(decoded != nil && decoded?.imagePath == nil, "malformed image path ignored without dropping approval")
}
let expected = "a1|click|42|543eecf500fcd27381ea367fb0d7efec6916fcd2c33abfac78f16b004d7bf957|1700000000000"
check(try! approval.signingMessage(verb: "grant", timestamp: 1_700_000_000_000) == "grant|" + expected, "grant proof matches Node SHA-256 UTF-8 fixture")
check(try! approval.signingMessage(verb: "deny", timestamp: 1_700_000_000_000) == "deny|" + expected, "deny binds the same action tuple")
rejects("invalid verb rejected") { _ = try approval.signingMessage(verb: "approve", timestamp: 1) }
var bad = object; bad["id"] = "a|2"
rejects("ambiguous proof tuple rejected") { _ = try Approval(bad)!.signingMessage(verb: "grant", timestamp: 1) }
check(!approval.expired, "ISO expiry parsed")
bad = object; bad["expiresAt"] = "invalid"
check(Approval(bad)!.expired, "missing valid expiry fails closed")
check(instant(1_700_000_000_000 as NSNumber)?.timeIntervalSince1970 == 1_700_000_000, "numeric timestamps are milliseconds")
check(approvalRequestID("a_12-XYZ") == "a_12-XYZ", "approval launch ID accepts safe identity")
for id in ["", "a|2", "a\n2", "../a", String(repeating: "a", count: 129)] {
    check(approvalRequestID(id) == nil, "invalid approval launch identity rejected")
}
bad = object; bad["tab"] = NSNull()
check(try! Approval(bad)!.signingMessage(verb: "grant", timestamp: 1).hasPrefix("grant|a1|click||"), "new-tab approval signs empty tab")
check(SocketClient.socketPath == ProcessInfo.processInfo.environment["GADDI_SOCKET"], "GADDI_SOCKET overrides all defaults")
// Either home is disposable; the point is that the live broker's socket can never be named.
guard SocketClient.socketPath.contains("/tests/.state/") || SocketClient.socketPath.hasPrefix("/tmp/gaddi-test-")
else { diagnostic("FAIL isolated socket required"); exit(1) }
let client = SocketClient()
do {
    let result = try client.call("test.echo", ["text": "UTF-8 café\nline two"])
    check(result["text"] as? String == "UTF-8 café\nline two", "short RPC preserves Unicode and embedded newline")
} catch { diagnostic("FAIL echo: \(error)"); exit(1) }
for method in ["test.error", "test.wrong-id", "test.oversized", "test.eof"] {
    rejects("socket rejects \(method)") { _ = try client.call(method) }
}
print("== app protocol primitives: \(passed) passed, 0 failed")
