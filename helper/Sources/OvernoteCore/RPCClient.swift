import Darwin
import Foundation

/// A small blocking JSON-RPC client over the helper socket. Used by tests and by a second
/// helper instance to forward `--show` to the running one.
public final class RPCClient {
    private let fd: Int32
    private var buffer = LineBuffer()
    private var nextId: Int64 = 1

    public init(path: String) throws {
        fd = try SocketPaths.connect(to: path)
    }

    deinit {
        close(fd)
    }

    /// Sends a raw line (a newline is appended).
    public func send(line: String) throws {
        try SocketPaths.writeAll(fd: fd, data: Data((line + "\n").utf8), timeout: 3)
    }

    /// Sends raw bytes, with no newline added. Tests use this to split one request across writes
    /// without touching the socket descriptor.
    func send(data: Data) throws {
        try SocketPaths.writeAll(fd: fd, data: data, timeout: 3)
    }

    /// Reads one line, or returns nil on timeout or end of stream.
    public func readLine(timeout: Double = 3) throws -> String? {
        let deadline = Date().addingTimeInterval(timeout)
        while true {
            if let line = buffer.nextLine() {
                return String(decoding: line, as: UTF8.self)
            }
            let remaining = deadline.timeIntervalSinceNow
            guard remaining > 0 else { return nil }
            var pollFd = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
            let ready = poll(&pollFd, 1, Int32(max(1, remaining * 1000)))
            if ready < 0 && errno == EINTR { continue }
            guard ready > 0 else { return nil }
            var chunk = [UInt8](repeating: 0, count: 64 * 1024)
            let count = chunk.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress, $0.count) }
            if count < 0 && errno == EINTR { continue }
            guard count > 0 else { return nil }
            buffer.append(chunk[0..<count])
        }
    }

    public struct CallError: Error, CustomStringConvertible {
        public let description: String
    }

    /// Sends a request and waits for the response with the same id. Returns the whole
    /// response object (`result` or `error`).
    public func request(_ method: String, _ params: JSONValue = [:], timeout: Double = 3) throws -> JSONValue {
        let id = nextId
        nextId += 1
        try send(line: JSONValue.object(["id": .int(id), "method": .string(method), "params": params]).serialized())
        let deadline = Date().addingTimeInterval(timeout)
        while deadline.timeIntervalSinceNow > 0 {
            guard let line = try readLine(timeout: deadline.timeIntervalSinceNow) else { break }
            let response = try JSONValue.parse(line)
            if response["id"] == .int(id) {
                return response
            }
        }
        throw CallError(description: "Timed out waiting for \(method)")
    }

    /// Like `request`, but returns `result` and throws the `error` as an `RPCError`.
    public func call(_ method: String, _ params: JSONValue = [:], timeout: Double = 3) throws -> JSONValue {
        let response = try request(method, params, timeout: timeout)
        if let error = response["error"] {
            throw RPCError(code: Int(error["code"]?.intValue ?? 0), message: error["message"]?.stringValue ?? "")
        }
        return response["result"] ?? .null
    }
}
