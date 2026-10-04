import Foundation
import CryptoKit
import LocalAuthentication
import Security
import Darwin

final class SigningKey {
    // Tests set GADDI_KEY_DIR to an isolated fixture directory, never the user's key store.
    private let publicURL = URL(fileURLWithPath: ProcessInfo.processInfo.environment["GADDI_KEY_DIR"]
        ?? NSHomeDirectory() + "/Library/Application Support/Gaddi")
        .appendingPathComponent("approver.pub")
    private var privateURL: URL { publicURL.deletingPathExtension().appendingPathExtension("key") }

    private func reconstruct(_ blob: Data, context: LAContext?) throws -> SecureEnclave.P256.Signing.PrivateKey {
        // Preserve the enclave binding and ACL; never replace an unreadable blob.
        // A nil context reads the public key without requesting presence.
        return try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: blob, authenticationContext: context)
    }

    private func create() throws -> Data {
        var error: Unmanaged<CFError>?
        // Presence is enforced by the enclave on private-key use, not just by the UI.
        guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
                                                         [.privateKeyUsage, .userPresence], &error) else {
            throw error?.takeRetainedValue() as Error? ?? AppError("Cannot protect the approver key")
        }
        let key = try SecureEnclave.P256.Signing.PrivateKey(accessControl: access)
        // CryptoKit provides an enclave-bound blob, never the raw private scalar.
        return key.dataRepresentation
    }

    private func store(_ blob: Data) throws {
        let directory = privateURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        let temporary = directory.appendingPathComponent(".approver-\(UUID().uuidString).tmp")
        // Start at 0600, then publish atomically without overwriting another key.
        let fd = open(temporary.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
        guard fd >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        defer { unlink(temporary.path) }
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        try handle.write(contentsOf: blob)
        try handle.synchronize()
        try handle.close()
        guard link(temporary.path, privateURL.path) == 0 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
    }

    private func key(context: LAContext? = nil) throws -> SecureEnclave.P256.Signing.PrivateKey {
        // Fail closed for both creation and reload; there is no software fallback.
        guard SecureEnclave.isAvailable else {
            diagnostic("Secure Enclave unavailable: approvals need it")
            exit(3)
        }
        let blob: Data
        do { blob = try Data(contentsOf: privateURL) }
        catch let error as NSError where error.domain == NSCocoaErrorDomain && error.code == NSFileReadNoSuchFileError {
            let created = try create()
            try store(created)
            return try reconstruct(created, context: context)
        }
        return try reconstruct(blob, context: context)
    }

    private func publicKey(_ key: P256.Signing.PublicKey) throws -> SecKey {
        let attributes: JSONObject = [
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrKeyClass as String: kSecAttrKeyClassPublic
        ]
        var error: Unmanaged<CFError>?
        // Only the public point crosses into Security.framework for --verify-self.
        guard let publicKey = SecKeyCreateWithData(key.x963Representation as CFData,
                                                  attributes as CFDictionary, &error) else {
            throw error?.takeRetainedValue() as Error? ?? AppError("Cannot obtain approver public key")
        }
        return publicKey
    }

    private func pem(_ publicKey: P256.Signing.PublicKey) -> String {
        let body = publicKey.derRepresentation.base64EncodedString()
        var lines: [String] = []
        var offset = body.startIndex
        while offset < body.endIndex {
            let end = body.index(offset, offsetBy: 64, limitedBy: body.endIndex) ?? body.endIndex
            lines.append(String(body[offset..<end])); offset = end
        }
        return "-----BEGIN PUBLIC KEY-----\n" + lines.joined(separator: "\n") + "\n-----END PUBLIC KEY-----\n"
    }

    @discardableResult func exportPublicKey(from suppliedKey: SecKey? = nil) throws -> String {
        let publicKey: P256.Signing.PublicKey
        if let suppliedKey {
            var error: Unmanaged<CFError>?
            // This is the software public-key adapter, never an enclave SecKey.
            guard let point = SecKeyCopyExternalRepresentation(suppliedKey, &error) as Data? else {
                throw error?.takeRetainedValue() as Error? ?? AppError("Cannot export public key")
            }
            publicKey = try P256.Signing.PublicKey(x963Representation: point)
        } else {
            publicKey = try key().publicKey
        }
        let text = pem(publicKey)
        try FileManager.default.createDirectory(at: publicURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(text.utf8).write(to: publicURL, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: publicURL.path)
        return text
    }

    /// The caller supplies a fresh context after evaluatePolicy succeeds. Never cache
    /// authenticated contexts across decisions; only the enclave-bound blob is persisted.
    func sign(_ message: String, context: LAContext) throws -> (signature: Data, publicKey: SecKey) {
        let privateKey = try key(context: context)
        let signature = try privateKey.signature(for: Data(message.utf8))
        return (signature.derRepresentation, try publicKey(privateKey.publicKey))
    }
}

func authenticate(reason: String, completion: @escaping (Result<LAContext, Error>) -> Void) {
    let context = LAContext()
    context.localizedCancelTitle = "Cancel"
    var error: NSError?
    guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
        completion(.failure(error ?? AppError("User authentication is unavailable") as NSError)); return
    }
    context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { success, error in
        if success { completion(.success(context)) }
        else { context.invalidate(); completion(.failure(error ?? AppError("Authentication cancelled"))) }
    }
}
