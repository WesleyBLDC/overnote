import Darwin
import Foundation

public struct SocketError: Error, CustomStringConvertible, Equatable {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var description: String { message }

    static func posix(_ what: String, _ code: Int32 = errno) -> SocketError {
        SocketError("\(what): \(String(cString: strerror(code)))")
    }
}

/// Socket file system helpers shared by the server and the client.
public enum SocketPaths {
    /// Default runtime directory, `/tmp/overnote-<uid>`.
    public static var defaultDirectory: String { "/tmp/overnote-\(getuid())" }

    /// Creates the socket's parent directory with mode 0700, or checks that an existing one
    /// is a real directory owned by this user and tightens its mode to 0700.
    public static func prepareDirectory(for socketPath: String) throws {
        let directory = (socketPath as NSString).deletingLastPathComponent
        if mkdir(directory, 0o700) != 0 && errno != EEXIST {
            throw SocketError.posix("Cannot create \(directory)")
        }
        var info = stat()
        guard lstat(directory, &info) == 0 else { throw SocketError.posix("Cannot inspect \(directory)") }
        guard (info.st_mode & S_IFMT) == S_IFDIR else {
            throw SocketError("\(directory) exists and is not a directory")
        }
        guard info.st_uid == getuid() else {
            throw SocketError("\(directory) is owned by another user")
        }
        if (info.st_mode & 0o777) != 0o700 && chmod(directory, 0o700) != 0 {
            throw SocketError.posix("Cannot set mode 0700 on \(directory)")
        }
    }

    /// Fills a `sockaddr_un` for `path`, which must fit in `sun_path` (103 bytes plus NUL).
    static func address(for path: String) throws -> sockaddr_un {
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8)
        let capacity = MemoryLayout.size(ofValue: address.sun_path)
        guard bytes.count < capacity else {
            throw SocketError("Socket path is too long (\(bytes.count) bytes, max \(capacity - 1)): \(path)")
        }
        withUnsafeMutableBytes(of: &address.sun_path) { buffer in
            buffer.copyBytes(from: bytes)
            buffer[bytes.count] = 0
        }
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        return address
    }

    /// Opens a blocking client connection, or throws.
    public static func connect(to path: String) throws -> Int32 {
        var address = try address(for: path)
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw SocketError.posix("socket") }
        var on: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
        let result = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard result == 0 else {
            let code = errno
            close(fd)
            throw SocketError.posix("connect \(path)", code)
        }
        return fd
    }

    /// Writes all of `data`, waiting up to `timeout` seconds whenever the socket is full.
    static func writeAll(fd: Int32, data: Data, timeout: Double) throws {
        try data.withUnsafeBytes { (buffer: UnsafeRawBufferPointer) in
            guard let base = buffer.baseAddress else { return }
            var offset = 0
            while offset < buffer.count {
                let written = Darwin.write(fd, base + offset, buffer.count - offset)
                if written > 0 {
                    offset += written
                } else if written < 0 && errno == EINTR {
                    continue
                } else if written < 0 && errno == EAGAIN {
                    var pollFd = pollfd(fd: fd, events: Int16(POLLOUT), revents: 0)
                    if poll(&pollFd, 1, Int32(timeout * 1000)) <= 0 {
                        throw SocketError("Timed out writing to socket")
                    }
                } else {
                    throw SocketError.posix("write")
                }
            }
        }
    }
}

/// A newline delimited stream server on a Unix domain socket.
///
/// Each line is handed to `handler` in its own task, so requests on one connection run
/// concurrently and responses are written as they finish (matched by id on the client).
/// Writes on a connection are serialized so lines never interleave.
public final class SocketServer: @unchecked Sendable {
    public typealias LineHandler = @Sendable (String) async -> String

    /// Requests longer than this close the connection.
    static let maxLineBytes = 32 * 1024 * 1024

    public let path: String
    private let handler: LineHandler
    private let log: @Sendable (String) -> Void
    /// How many bytes one read on a connection may take in (tests read in small pieces).
    private let readChunkSize: Int
    /// Called with the byte count of every read on a connection, or nil.
    private let onRead: (@Sendable (Int) -> Void)?
    private let queue = DispatchQueue(label: "overnote.socket.accept")
    private let lock = NSLock()
    private var listenFd: Int32 = -1
    private var acceptSource: DispatchSourceRead?
    private var connections: [ObjectIdentifier: Connection] = [:]

    public init(path: String, log: @escaping @Sendable (String) -> Void = { _ in }, handler: @escaping LineHandler) {
        self.path = path
        self.handler = handler
        self.log = log
        readChunkSize = 64 * 1024
        onRead = nil
    }

    /// A server that reads its connections in pieces of `readChunkSize` bytes and reports
    /// every read, so a test can prove a long line really arrived in small reads.
    init(
        path: String, log: @escaping @Sendable (String) -> Void = { _ in }, readChunkSize: Int,
        onRead: (@Sendable (Int) -> Void)?, handler: @escaping LineHandler
    ) {
        self.path = path
        self.handler = handler
        self.log = log
        self.readChunkSize = max(1, readChunkSize)
        self.onRead = onRead
    }

    /// Prepares the directory, removes a stale socket, binds with mode 0600, and starts accepting.
    /// Throws when another live server already answers on `path`.
    public func start() throws {
        try SocketPaths.prepareDirectory(for: path)
        try removeStaleSocket()

        var address = try SocketPaths.address(for: path)
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw SocketError.posix("socket") }
        _ = fcntl(fd, F_SETFD, FD_CLOEXEC)
        // No umask juggling here: umask is process wide and would race with other threads
        // creating files. The parent directory is 0700, so the socket is private until the
        // chmod below tightens it to 0600.
        let bound = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard bound == 0 else {
            let code = errno
            close(fd)
            throw SocketError.posix("bind \(path)", code)
        }
        guard chmod(path, 0o600) == 0 else {
            let code = errno
            close(fd)
            unlink(path)
            throw SocketError.posix("chmod \(path)", code)
        }
        guard listen(fd, 64) == 0 else {
            let code = errno
            close(fd)
            unlink(path)
            throw SocketError.posix("listen", code)
        }
        _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK)

        let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: queue)
        source.setEventHandler { [weak self] in self?.acceptPending() }
        source.setCancelHandler { close(fd) }
        lock.withLock {
            listenFd = fd
            acceptSource = source
        }
        source.resume()
    }

    /// Stops accepting, closes every connection, and removes the socket file.
    public func stop() {
        let (source, open) = lock.withLock { () -> (DispatchSourceRead?, [Connection]) in
            let result = (acceptSource, Array(connections.values))
            acceptSource = nil
            connections.removeAll()
            listenFd = -1
            return result
        }
        guard let source else { return }
        source.cancel()
        open.forEach { $0.close() }
        unlink(path)
    }

    private func removeStaleSocket() throws {
        var info = stat()
        guard lstat(path, &info) == 0 else { return }
        guard (info.st_mode & S_IFMT) == S_IFSOCK else {
            throw SocketError("\(path) exists and is not a socket")
        }
        if let fd = try? SocketPaths.connect(to: path) {
            close(fd)
            throw SocketError("Another helper is already listening on \(path)")
        }
        log("Removing stale socket at \(path)")
        unlink(path)
    }

    private func acceptPending() {
        let fd = lock.withLock { listenFd }
        guard fd >= 0 else { return }
        while true {
            let client = accept(fd, nil, nil)
            if client < 0 {
                if errno == EINTR { continue }
                if errno != EAGAIN && errno != EWOULDBLOCK {
                    log("accept failed: \(String(cString: strerror(errno)))")
                }
                return
            }
            var on: Int32 = 1
            setsockopt(client, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
            _ = fcntl(client, F_SETFD, FD_CLOEXEC)
            _ = fcntl(client, F_SETFL, fcntl(client, F_GETFL) | O_NONBLOCK)
            let connection = Connection(fd: client, handler: handler, log: log, readChunkSize: readChunkSize, onRead: onRead) { [weak self] connection in
                _ = self?.lock.withLock { self?.connections.removeValue(forKey: ObjectIdentifier(connection)) }
            }
            lock.withLock { connections[ObjectIdentifier(connection)] = connection }
            connection.start()
        }
    }
}

/// One client connection: reads lines, dispatches them, and writes responses.
///
/// When the peer closes its write side, requests already received are still answered;
/// the descriptor closes once the last response is written.
final class Connection: @unchecked Sendable {
    private let fd: Int32
    private let handler: SocketServer.LineHandler
    private let log: @Sendable (String) -> Void
    private let readChunkSize: Int
    private let onRead: (@Sendable (Int) -> Void)?
    private let onClose: @Sendable (Connection) -> Void
    private let queue = DispatchQueue(label: "overnote.socket.connection")
    /// Responses are written here, not on Swift's shared cooperative threads: a client that stops
    /// reading may block a write, and only its own responses should wait for it.
    private let writeQueue = DispatchQueue(label: "overnote.socket.write")
    private var source: DispatchSourceRead?
    /// Bytes read but not yet split into lines. Only touched on `queue`.
    private var buffer: [UInt8] = []
    /// No byte of `buffer` before this index is a newline (the contract in `NewlineSearch`).
    private var scanOffset = 0
    /// Guards the fields below and every write, so a late response never hits a reused descriptor.
    private let stateLock = NSLock()
    private var closed = false
    private var readingDone = false
    private var pending = 0
    private var forceClose = false
    /// A write failed or timed out: the client is gone or stopped reading, so nothing more is sent.
    private var broken = false

    init(
        fd: Int32, handler: @escaping SocketServer.LineHandler, log: @escaping @Sendable (String) -> Void,
        readChunkSize: Int = 64 * 1024, onRead: (@Sendable (Int) -> Void)? = nil,
        onClose: @escaping @Sendable (Connection) -> Void
    ) {
        self.fd = fd
        self.handler = handler
        self.log = log
        self.readChunkSize = max(1, readChunkSize)
        self.onRead = onRead
        self.onClose = onClose
    }

    func start() {
        let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: queue)
        source.setEventHandler { [weak self] in self?.readAvailable() }
        source.setCancelHandler { [weak self] in self?.readingFinished() }
        self.source = source
        source.resume()
    }

    /// Runs on `queue`.
    private func readAvailable() {
        var chunk = [UInt8](repeating: 0, count: readChunkSize)
        while true {
            let count = chunk.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress, $0.count) }
            if count > 0 {
                onRead?(count)
                buffer.append(contentsOf: chunk[0..<count])
                if buffer.count > SocketServer.maxLineBytes {
                    // Answer the complete lines first; what is left is one unfinished line.
                    drainLines()
                    if buffer.count > SocketServer.maxLineBytes {
                        log("Closing connection: request line exceeds \(SocketServer.maxLineBytes) bytes")
                        close()
                        return
                    }
                }
                continue
            }
            if count < 0 && errno == EINTR { continue }
            if count < 0 && (errno == EAGAIN || errno == EWOULDBLOCK) { break }
            // End of stream or a hard error: answer what arrived, then stop reading.
            drainLines()
            source?.cancel()
            source = nil
            return
        }
        drainLines()
    }

    private func drainLines() {
        var start = 0
        while let newline = NewlineSearch.firstNewline(in: buffer, from: max(start, scanOffset)) {
            let lineBytes = buffer[start..<newline]
            start = newline + 1
            guard let line = String(bytes: lineBytes, encoding: .utf8) else {
                send(RPCLineHandler.response(id: .null, error: .badParams("Request is not valid UTF-8")))
                continue
            }
            if line.allSatisfy({ $0.isWhitespace }) { continue }
            stateLock.withLock { pending += 1 }
            let handler = handler
            Task {
                let response = await handler(line)
                self.writeQueue.async {
                    self.send(response)
                    self.stateLock.withLock { self.pending -= 1 }
                    self.closeIfIdle()
                }
            }
        }
        // Shift once past every returned line; what is left holds no newline.
        if start > 0 { buffer.removeFirst(start) }
        scanOffset = buffer.count
    }

    func send(_ line: String) {
        let failed = stateLock.withLock { () -> Bool in
            guard !closed, !broken else { return false }
            do {
                try SocketPaths.writeAll(fd: fd, data: Data((line + "\n").utf8), timeout: 5)
                return false
            } catch {
                broken = true
                log("Closing connection: \(error)")
                return true
            }
        }
        // A client that has not read for 5 s is dropped, so its queued answers never pile up.
        if failed { close() }
    }

    /// Closes now, dropping responses still in flight.
    func close() {
        queue.async { [self] in
            if let source {
                // The descriptor may only close after the read source's cancel handler ran.
                stateLock.withLock { forceClose = true }
                source.cancel()
                self.source = nil
            } else {
                closeDescriptor()
            }
        }
    }

    private func readingFinished() {
        let force = stateLock.withLock { () -> Bool in
            readingDone = true
            return forceClose
        }
        if force {
            closeDescriptor()
        } else {
            closeIfIdle()
        }
    }

    private func closeIfIdle() {
        let idle = stateLock.withLock { readingDone && pending == 0 }
        if idle {
            closeDescriptor()
        }
    }

    private func closeDescriptor() {
        let didClose = stateLock.withLock { () -> Bool in
            guard !closed else { return false }
            closed = true
            Darwin.close(fd)
            return true
        }
        if didClose {
            onClose(self)
        }
    }
}
