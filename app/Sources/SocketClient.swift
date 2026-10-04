import Foundation
import Darwin

typealias JSONObject = [String: Any]

struct AppError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

func diagnostic(_ message: String) {
    FileHandle.standardError.write(Data((message + "\n").utf8))
}

/// Each connection owns its descriptor. A bounded frame and deadline prevent a stalled
/// or malformed daemon from hanging a call or growing the app's memory indefinitely.
final class UnixConnection {
    private(set) var fd: Int32 = -1
    private var buffer = Data()
    private let maxFrame = 1_048_576

    init(path: String) throws {
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8) + [0]
        guard bytes.count <= MemoryLayout.size(ofValue: address.sun_path) else {
            throw AppError("Socket path is too long")
        }
        withUnsafeMutableBytes(of: &address.sun_path) { dest in
            dest.copyBytes(from: bytes)
        }
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw AppError("Cannot create daemon socket") }
        var noPipe: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noPipe, socklen_t(MemoryLayout.size(ofValue: noPipe)))
        _ = fcntl(fd, F_SETFL, O_NONBLOCK)
        do {
            let result = withUnsafePointer(to: &address) { ptr in
                ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                    Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
                }
            }
            if result != 0 {
                guard errno == EINPROGRESS else { throw AppError("Cannot connect to daemon (errno \(errno))") }
                try wait(POLLOUT, until: Date().addingTimeInterval(8))
                var error: Int32 = 0
                var size = socklen_t(MemoryLayout.size(ofValue: error))
                guard getsockopt(fd, SOL_SOCKET, SO_ERROR, &error, &size) == 0, error == 0 else {
                    throw AppError("Daemon connection failed (errno \(error))")
                }
            }
        } catch { Darwin.close(fd); fd = -1; throw error }
    }

    deinit { if fd >= 0 { Darwin.close(fd) } }
    func interrupt() { _ = shutdown(fd, SHUT_RDWR) }

    private func wait(_ events: Int32, until deadline: Date?) throws {
        var p = pollfd(fd: fd, events: Int16(events), revents: 0)
        while true {
            let seconds = deadline?.timeIntervalSinceNow ?? 60
            guard seconds > 0 else { throw AppError("Daemon request timed out") }
            let result = poll(&p, 1, Int32(min(seconds * 1000, 60_000).rounded(.up)))
            if result > 0 {
                guard Int32(p.revents) & POLLNVAL == 0 else { throw AppError("Daemon socket closed") }
                return // recv/send reports EOF and detailed errors, including POLLHUP.
            }
            if result < 0 && errno != EINTR { throw AppError("Daemon socket poll failed") }
        }
    }

    func send(_ object: JSONObject) throws {
        var data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        data.append(10)
        let deadline = Date().addingTimeInterval(8)
        try data.withUnsafeBytes { raw in
            var sent = 0
            while sent < data.count {
                try wait(POLLOUT, until: deadline)
                let n = Darwin.send(fd, raw.baseAddress!.advanced(by: sent), data.count - sent, 0)
                if n < 0 && (errno == EAGAIN || errno == EINTR) { continue }
                guard n > 0 else { throw AppError("Cannot write to daemon") }
                sent += n
            }
        }
    }

    func receive(until deadline: Date? = nil) throws -> JSONObject {
        while true {
            if let end = buffer.firstIndex(of: 10) {
                guard end <= maxFrame else { throw AppError("Daemon frame exceeds 1 MiB") }
                let line = buffer.prefix(upTo: end)
                buffer.removeSubrange(...end)
                guard let object = try JSONSerialization.jsonObject(with: line) as? JSONObject else {
                    throw AppError("Daemon frame is not a JSON object")
                }
                return object
            }
            guard buffer.count <= maxFrame else { throw AppError("Daemon frame exceeds 1 MiB") }
            try wait(POLLIN, until: deadline)
            var bytes = [UInt8](repeating: 0, count: 16_384)
            let n = recv(fd, &bytes, bytes.count, 0)
            if n < 0 && (errno == EAGAIN || errno == EINTR) { continue }
            guard n > 0 else { throw AppError("Daemon disconnected") }
            buffer.append(contentsOf: bytes.prefix(n))
        }
    }
}

final class SocketClient {
    static var socketPath: String {
        if let override = ProcessInfo.processInfo.environment["GADDI_SOCKET"], !override.isEmpty { return override }
        return NSHomeDirectory() + "/Library/Application Support/Gaddi/gaddi.sock"
    }
    private let lock = NSLock()
    private var running = false
    private var stream: UnixConnection?

    func call(_ method: String, _ params: JSONObject = [:]) throws -> JSONObject {
        let connection = try UnixConnection(path: Self.socketPath)
        let id = UUID().uuidString
        var params = params
        params["caller"] = "approval-app"
        try connection.send(["id": id, "method": method, "params": params])
        let response = try connection.receive(until: Date().addingTimeInterval(8))
        guard response["id"] as? String == id else { throw AppError("Daemon response ID mismatch") }
        if let error = response["error"] as? JSONObject {
            throw AppError(error["message"] as? String ?? "Daemon rejected the request")
        }
        guard let result = response["result"] as? JSONObject else { throw AppError("Missing daemon result") }
        return result
    }

    private var isRunning: Bool { lock.lock(); defer { lock.unlock() }; return running }
    func subscribe(onConnected: @escaping () -> Void, onEvent: @escaping (JSONObject) -> Void,
                   onDisconnected: @escaping (String) -> Void) {
        lock.lock()
        guard !running else { lock.unlock(); return }
        running = true
        lock.unlock()
        DispatchQueue(label: "gaddi.events").async { [self] in
            var backoff: Double = 0.5
            while isRunning {
                let began = Date()
                do {
                    let connection = try UnixConnection(path: Self.socketPath)
                    lock.lock(); stream = connection; let active = running; lock.unlock()
                    guard active else { break }
                    let id = UUID().uuidString
                    try connection.send(["id": id, "method": "events.subscribe", "params": ["caller": "approval-app"]])
                    // Acknowledge before refreshing: events must already be subscribed while snapshots load.
                    var connected = false
                    while isRunning {
                        let message = try connection.receive(until: connected ? nil : Date().addingTimeInterval(8))
                        if message["error"] != nil { throw AppError("Daemon refused event subscription") }
                        if !connected {
                            guard message["id"] as? String == id || message["event"] is String else {
                                throw AppError("Invalid subscription acknowledgement")
                            }
                            connected = true
                            onConnected()
                        }
                        if message["event"] is String { onEvent(message) }
                    }
                } catch {
                    if isRunning { onDisconnected(error.localizedDescription) }
                }
                lock.lock(); stream = nil; lock.unlock()
                if Date().timeIntervalSince(began) >= 10 { backoff = 0.5 }
                let retryAt = Date().addingTimeInterval(backoff)
                while isRunning && Date() < retryAt { Thread.sleep(forTimeInterval: 0.1) }
                backoff = min(backoff * 2, 30)
            }
        }
    }
    func stop() {
        lock.lock(); running = false; stream?.interrupt(); lock.unlock()
    }
}
