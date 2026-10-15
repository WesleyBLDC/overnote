import Darwin
import Foundation

/// Single instance lock: an exclusive `flock` on the PID file, held for the life of the process.
///
/// The kernel drops the lock when the process dies, so a crash never leaves a stale lock;
/// a stale PID file left behind is simply locked and rewritten by the next helper.
public final class InstanceLock: @unchecked Sendable {
    public struct AlreadyRunning: Error, CustomStringConvertible {
        /// The pid recorded by the running instance, when readable.
        public let pid: Int32?
        public var description: String { "Another helper is already running" + (pid.map { " (pid \($0))" } ?? "") }
    }

    public let path: String
    private var fd: Int32 = -1

    public init(path: String) {
        self.path = path
    }

    deinit {
        if fd >= 0 { close(fd) }
    }

    /// Takes the lock and writes this process id. Throws `AlreadyRunning` when held elsewhere.
    public func acquire() throws {
        for _ in 0..<5 {
            let descriptor = open(path, O_RDWR | O_CREAT | O_CLOEXEC, 0o600)
            guard descriptor >= 0 else { throw SocketError.posix("Cannot open PID file \(path)") }
            if flock(descriptor, LOCK_EX | LOCK_NB) != 0 {
                let pid = Self.readPid(descriptor)
                close(descriptor)
                throw AlreadyRunning(pid: pid)
            }
            // A previous owner may have unlinked the file between our open and flock; then we
            // hold a lock on an orphaned inode. Retry until the path and our descriptor agree.
            var pathInfo = stat()
            var fdInfo = stat()
            guard stat(path, &pathInfo) == 0, fstat(descriptor, &fdInfo) == 0, pathInfo.st_ino == fdInfo.st_ino else {
                close(descriptor)
                continue
            }
            ftruncate(descriptor, 0)
            let text = "\(getpid())\n"
            _ = text.withCString { Darwin.write(descriptor, $0, strlen($0)) }
            fd = descriptor
            return
        }
        throw SocketError("Could not lock PID file \(path)")
    }

    /// Removes the PID file and releases the lock.
    public func release() {
        guard fd >= 0 else { return }
        unlink(path)
        close(fd)
        fd = -1
    }

    private static func readPid(_ descriptor: Int32) -> Int32? {
        var bytes = [UInt8](repeating: 0, count: 32)
        let count = pread(descriptor, &bytes, bytes.count, 0)
        guard count > 0 else { return nil }
        let text = String(decoding: bytes[0..<count], as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        return Int32(text)
    }
}

/// Appends timestamped lines to a log file, rotating it to `<name>.1` past `maxBytes`.
public final class FileLogger: @unchecked Sendable {
    public static let defaultMaxBytes: UInt64 = 1024 * 1024

    public let path: String
    private let maxBytes: UInt64
    private let mirrorToStderr: Bool
    private let lock = NSLock()
    private var handle: FileHandle?
    private let formatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    public init(path: String, maxBytes: UInt64 = defaultMaxBytes, mirrorToStderr: Bool = false) {
        self.path = path
        self.maxBytes = maxBytes
        self.mirrorToStderr = mirrorToStderr
    }

    public func log(_ message: String) {
        let line = "\(formatter.string(from: Date())) [\(getpid())] \(message)\n"
        lock.withLock {
            if mirrorToStderr {
                FileHandle.standardError.write(Data(line.utf8))
            }
            guard let handle = openIfNeeded() else { return }
            handle.write(Data(line.utf8))
            var info = stat()
            if fstat(handle.fileDescriptor, &info) == 0 && UInt64(info.st_size) >= maxBytes {
                rotate()
            }
        }
    }

    public func close() {
        lock.withLock {
            try? handle?.close()
            handle = nil
        }
    }

    /// Opens with `O_APPEND`, so lines from a short lived second instance never overwrite ours.
    private func openIfNeeded() -> FileHandle? {
        if let handle { return handle }
        let fd = open(path, O_WRONLY | O_APPEND | O_CREAT | O_CLOEXEC, 0o600)
        guard fd >= 0 else { return nil }
        let opened = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        handle = opened
        return opened
    }

    private func rotate() {
        try? handle?.close()
        handle = nil
        let rotated = path + ".1"
        unlink(rotated)
        rename(path, rotated)
    }
}

/// Runs the trash purge now and then every 24 hours on a background queue.
public final class PurgeScheduler: @unchecked Sendable {
    public static let interval: TimeInterval = 24 * 60 * 60

    private let timer: DispatchSourceTimer

    /// `work` runs once immediately (synchronously) and then on every tick.
    public init(interval: TimeInterval = PurgeScheduler.interval, work: @escaping @Sendable () -> Void) {
        work()
        timer = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "overnote.purge", qos: .utility))
        timer.schedule(deadline: .now() + interval, repeating: interval, leeway: .seconds(60))
        timer.setEventHandler(handler: work)
        timer.resume()
    }

    public func cancel() {
        timer.cancel()
    }
}

/// Parsed command line (docs/architecture.md section 1).
public struct HelperArguments: Equatable, Sendable {
    public var supportDir: String
    public var socketPath: String
    public var pidFile: String
    public var editorDir: String?
    public var show = false
    public var version = false
    /// Prints the database schema version this helper writes and exits.
    public var schemaVersion = false
    /// Runs the socket server with no window (for smoke tests and CI). Not part of the contract.
    public var headless = false
    /// Adds `test.*` socket methods for the end to end window checks. Not part of the contract.
    public var testHooks = false

    public static let usage = """
        Usage: OvernoteHelper --support-dir <dir> [--socket <path>] [--pid-file <path>] [--editor-dir <dir>] [--show] [--headless] [--test-hooks] [--version] [--schema-version]
        """

    public struct ParseError: Error, CustomStringConvertible {
        public let description: String
    }

    public static func parse(_ arguments: [String]) throws -> HelperArguments {
        var supportDir: String?
        var socketPath: String?
        var pidFile: String?
        var editorDir: String?
        var result = HelperArguments(supportDir: "", socketPath: "", pidFile: "")
        var iterator = arguments.makeIterator()
        func value(for flag: String) throws -> String {
            guard let value = iterator.next(), !value.hasPrefix("--") else {
                throw ParseError(description: "\(flag) needs a value")
            }
            return value
        }
        while let argument = iterator.next() {
            switch argument {
            case "--support-dir": supportDir = try value(for: argument)
            case "--socket": socketPath = try value(for: argument)
            case "--pid-file": pidFile = try value(for: argument)
            case "--editor-dir": editorDir = try value(for: argument)
            case "--show": result.show = true
            case "--version": result.version = true
            case "--schema-version": result.schemaVersion = true
            case "--headless": result.headless = true
            case "--test-hooks": result.testHooks = true
            default:
                // Ignore arguments AppKit or launchd may add, such as -psn_ or -NSDocumentRevisionsDebugMode.
                if argument.hasPrefix("--") {
                    throw ParseError(description: "Unknown argument: \(argument)")
                }
            }
        }
        if result.version || result.schemaVersion {
            return result
        }
        guard let supportDir else { throw ParseError(description: "--support-dir is required") }
        result.supportDir = supportDir
        result.socketPath = socketPath ?? SocketPaths.defaultDirectory + "/helper.sock"
        result.pidFile = pidFile ?? SocketPaths.defaultDirectory + "/helper.pid"
        result.editorDir = editorDir
        return result
    }
}
