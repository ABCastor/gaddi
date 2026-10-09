// Protocol checks and disposable software signatures, no UI, authentication or key store.
import Foundation
import CryptoKit

@main struct RememberProofChecks {
    static func main() throws {
        var passed = 0
        func check(_ condition: Bool, _ label: String) {
            guard condition else { diagnostic("FAIL \(label)"); exit(1) }
            passed += 1; print("PASS \(label)")
        }
        func rejects(_ label: String, _ body: () throws -> Void) {
            do { try body(); diagnostic("FAIL \(label)"); exit(1) }
            catch { passed += 1; print("PASS \(label)") }
        }
        var object: JSONObject = ["id": "a1", "kind": "signin", "tab": 42, "detail": "click Pay café",
            "url": "https://example.test:8443/login", "site": "https://example.test:8443"]
        let approval = Approval(object)!
        let expected = "grant|a1|signin|42|543eecf500fcd27381ea367fb0d7efec6916fcd2c33abfac78f16b004d7bf957|1700000000000"
        check(try approval.signingMessage(verb: "grant", timestamp: 1_700_000_000_000) == expected,
              "allow-once retains the existing approval payload")
        check(try approval.signingMessage(verb: "grant", timestamp: 1_700_000_000_000, remember: true)
              == expected + "|remember|https://example.test:8443", "Always signs the choice and exact origin")
        rejects("deny cannot remember") { _ = try approval.signingMessage(verb: "deny", timestamp: 1, remember: true) }
        object["kind"] = "click"
        rejects("other approval kinds cannot remember") { _ = try Approval(object)!.signingMessage(verb: "grant", timestamp: 1, remember: true) }
        object["kind"] = "signin"; object.removeValue(forKey: "site")
        rejects("missing origin cannot remember") { _ = try Approval(object)!.signingMessage(verb: "grant", timestamp: 1, remember: true) }
        check(try signinRevokeMessage(site: approval.site!, timestamp: 1_700_000_000_000)
              == "signin.revoke|https://example.test:8443|1700000000000", "Revoke binds the exact origin and timestamp")
        rejects("ambiguous revoke origin rejected") { _ = try signinRevokeMessage(site: "https://example.test|x", timestamp: 1) }
        object["site"] = "https://example.test:8443"; object["kind"] = "signin"
        let key = P256.Signing.PrivateKey(), ts = Int64(Date().timeIntervalSince1970 * 1000)
        let grant = try approval.signingMessage(verb: "grant", timestamp: ts, remember: true)
        let revoke = try signinRevokeMessage(site: approval.site!, timestamp: ts)
        let vectors: JSONObject = ["approval": object, "publicKey": key.publicKey.pemRepresentation,
            "grant": ["ts": ts, "sig": try key.signature(for: Data(grant.utf8)).derRepresentation.base64EncodedString()],
            "revoke": ["ts": ts, "sig": try key.signature(for: Data(revoke.utf8)).derRepresentation.base64EncodedString()]]
        let sendObject: JSONObject = ["id": "send1", "kind": "press", "tab": 42, "detail": "Enter",
            "reason": "enter-submits:send", "url": "https://example.test:8443/chat", "site": "https://example.test:8443", "rememberable": true]
        let send = Approval(sendObject)!, permission = send.sendPermission!
        let sendExpected = "grant|send1|press|42|dc8659db6d416dc32fcad510cc921af3c7eaf1176ddedfbe050ecf708fbac087|1700000000000"
        check(send.canRemember && permission.label == "Send with Enter", "eligible sends expose a scoped owner choice")
        check(try send.signingMessage(verb: "grant", timestamp: 1_700_000_000_000, remember: true)
              == sendExpected + "|remember|https://example.test:8443|enter-submits:send", "send Always binds exact origin and hold reason")
        check(permission.revokeMessage(timestamp: 1_700_000_000_000)
              == "sends.revoke|https://example.test:8443|press|enter-submits:send|1700000000000", "send Revoke binds origin, kind and reason")
        for fields: JSONObject in [["rememberable": false], ["kind": "upload"], ["reason": "enter-submits:pay"], ["site": "https://example.test|other"]] {
            var invalid = sendObject; invalid.merge(fields) { _, new in new }
            rejects("ineligible send cannot remember: \(fields.keys.sorted())") {
                _ = try Approval(invalid)!.signingMessage(verb: "grant", timestamp: 1, remember: true)
            }
        }
        let sendMessage = try send.signingMessage(verb: "grant", timestamp: ts, remember: true)
        var allVectors = vectors
        allVectors["sendApproval"] = sendObject
        allVectors["sendGrant"] = ["ts": ts, "sig": try key.signature(for: Data(sendMessage.utf8)).derRepresentation.base64EncodedString()]
        allVectors["sendRevoke"] = ["ts": ts, "sig": try key.signature(for: Data(permission.revokeMessage(timestamp: ts).utf8)).derRepresentation.base64EncodedString()]
        // A session grant is signed like any other hold: id, kind, empty tab, and a digest of the multi-line text the owner read.
        let grantObject: JSONObject = ["id": "grant1", "kind": "grant", "tab": NSNull(), "caller": "codex", "url": "", "reason": "session grant",
            "detail": "post on www.linkedin.com/company\nupload on github.com/settings\nfor 3 hours\n“Update the profile”"]
        let sessionGrant = Approval(grantObject)!
        let sessionMessage = try sessionGrant.signingMessage(verb: "grant", timestamp: ts)
        check(sessionMessage.hasPrefix("grant|grant1|grant||"), "a session grant signs id, kind, an empty tab and the digest of its text")
        rejects("a session grant cannot sign a remember choice") { _ = try sessionGrant.signingMessage(verb: "grant", timestamp: ts, remember: true) }
        allVectors["sessionGrantApproval"] = grantObject
        allVectors["sessionGrant"] = ["ts": ts, "sig": try key.signature(for: Data(sessionMessage.utf8)).derRepresentation.base64EncodedString()]
        try JSONSerialization.data(withJSONObject: allVectors).write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
        print("== app remember protocol: \(passed) passed, 0 failed")
    }
}
