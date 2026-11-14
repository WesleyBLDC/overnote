import Darwin
import Foundation

/// What runs in the drawer: a kept Herdr terminal, or a plain login shell when Herdr is missing.
public enum TerminalBackend: String, Sendable {
    case herdr
    case shell
}

/// One program in a pseudo terminal (docs/architecture.md, the terminal drawer).
///
/// Output is read on a background queue and handed to `onOutput` as it arrives. Every byte handed
/// out counts as unacked until `ack(_:)`; above `highWater` unacked bytes reading pauses, so a flood
/// waits in the program (and in herdr-core) instead of piling up in the helper or the page.
/// `close()` hangs up the program's process group; `onExit` reports how the program ended.
public final class TerminalSession: @unchecked Sendable {
    public struct Command: Equatable, Sendable {
        public var executable: String
        /// Arguments after `argv[0]`, which is the executable's file name.
        public var arguments: [String]
        public var environment: [String: String]
        public var directory: String

        public init(executable: String, arguments: [String], environment: [String: String], directory: String) {
            self.executable = executable
            self.arguments = arguments
            self.environment = environment
            self.directory = directory
        }
    }

    /// Reading pauses while this many output bytes wait for the page's ack.
    public static let highWater = 256 * 1024
    static let readSize = 64 * 1024

    public let pid: pid_t
    private let master: Int32
    private let readQueue = DispatchQueue(label: "overnote.terminal.read")
    private let writeQueue = DispatchQueue(label: "overnote.terminal.write")
    private let lock = NSLock()
    private var readSource: DispatchSourceRead?
    private var exitSource: DispatchSourceProcess?
    private var unacked = 0
    private var paused = false
    private var finished = false
    private var started = false

    /// Called on a background queue with each piece of output.
    public var onOutput: (@Sendable (Data) -> Void)?
    /// Called once, on a background queue, with the exit code (128 plus the signal for a signal).
    public var onExit: (@Sendable (Int32) -> Void)?

    /// Starts `command` in a new pseudo terminal of `cols` by `rows`. Call `start()` once the
    /// callbacks are set; output waits in the terminal until then.
    public init(command: Command, cols: Int, rows: Int) throws {
        // Everything the child needs is built before fork: after it, the child only calls
        // async-signal-safe functions (chdir, sigprocmask, signal, execve, _exit).
        let path = strdup(command.executable)
        let directory = strdup(command.directory)
        let argv = Self.cStrings([(command.executable as NSString).lastPathComponent] + command.arguments)
        let envp = Self.cStrings(command.environment.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" })
        defer {
            free(path)
            free(directory)
            Self.free(argv)
            Self.free(envp)
        }
        var size = winsize(ws_row: Self.clamp(rows), ws_col: Self.clamp(cols), ws_xpixel: 0, ws_ypixel: 0)
        var master: Int32 = -1
        var unblocked = sigset_t(0)
        let pid = forkpty(&master, nil, nil, &size)
        if pid == 0 {
            // The child: a new session with the terminal as its controlling terminal (forkpty).
            sigprocmask(SIG_SETMASK, &unblocked, nil)
            for signal in [SIGPIPE, SIGINT, SIGQUIT, SIGTERM, SIGHUP, SIGCHLD, SIGTSTP, SIGTTIN, SIGTTOU] {
                Darwin.signal(signal, SIG_DFL)
            }
            if let directory { _ = chdir(directory) }
            execve(path, argv, envp)
            _exit(127)
        }
        guard pid > 0, master >= 0 else {
            throw RPCError.internal("Could not start a terminal: \(String(cString: strerror(errno)))")
        }
        _ = fcntl(master, F_SETFD, FD_CLOEXEC)
        self.pid = pid
        self.master = master
    }

    deinit {
        readSource?.cancel()
        exitSource?.cancel()
    }

    /// Starts reading output and watching for the program's exit.
    public func start() {
        lock.lock()
        defer { lock.unlock() }
        guard !started else { return }
        started = true
        // The handlers hold the session until the program exits and they are cancelled, so a
        // closed session always lives long enough to reap its program.
        let read = DispatchSource.makeReadSource(fileDescriptor: master, queue: readQueue)
        read.setEventHandler { self.readAvailable(limit: Self.readSize) }
        read.setCancelHandler { [master] in Darwin.close(master) }
        let exit = DispatchSource.makeProcessSource(identifier: pid, eventMask: .exit, queue: readQueue)
        exit.setEventHandler { self.programExited() }
        readSource = read
        exitSource = exit
        read.resume()
        exit.resume()
        // A program that exited before the source existed may never fire it; this reaps it then.
        readQueue.async { self.programExited() }
    }

    /// Sends input to the program, off the caller's thread, so a program that stops reading
    /// never blocks the main thread.
    public func write(_ data: Data) {
        guard !data.isEmpty else { return }
        writeQueue.async { [weak self] in
            guard let self, !self.isFinished else { return }
            data.withUnsafeBytes { raw in
                guard var pointer = raw.baseAddress else { return }
                var remaining = raw.count
                while remaining > 0 {
                    let written = Darwin.write(self.master, pointer, remaining)
                    if written < 0 {
                        if errno == EINTR { continue }
                        return
                    }
                    remaining -= written
                    pointer = pointer.advanced(by: written)
                }
            }
        }
    }

    /// Tells the program its new size (`TIOCSWINSZ`, which also sends it SIGWINCH).
    public func resize(cols: Int, rows: Int) {
        guard !isFinished else { return }
        var size = winsize(ws_row: Self.clamp(rows), ws_col: Self.clamp(cols), ws_xpixel: 0, ws_ypixel: 0)
        _ = ioctl(master, TIOCSWINSZ, &size)
    }

    /// The page drew `bytes` more output bytes; reading resumes once the backlog is under `highWater`.
    public func ack(_ bytes: Int) {
        lock.lock()
        unacked = max(0, unacked - max(0, bytes))
        let resume = paused && unacked < Self.highWater && !finished
        if resume { paused = false }
        let source = readSource
        lock.unlock()
        if resume { source?.resume() }
    }

    /// Output bytes handed out and not yet acked.
    public var unackedBytes: Int { lock.withLock { unacked } }
    /// Whether reading is paused for the page to catch up.
    public var isPaused: Bool { lock.withLock { paused } }
    public var isFinished: Bool { lock.withLock { finished } }

    /// Hangs up the program's process group, and kills it if it is still there a moment later.
    public func close() {
        guard !isFinished else { return }
        let pid = self.pid
        _ = kill(-pid, SIGHUP)
        _ = kill(pid, SIGHUP)
        readQueue.asyncAfter(deadline: .now() + 2) {
            guard !self.isFinished else { return }
            _ = kill(-pid, SIGKILL)
            _ = kill(pid, SIGKILL)
        }
    }

    // MARK: - Reading

    /// Reads what the terminal has, up to `limit` bytes, and hands it out. Runs on `readQueue`.
    @discardableResult
    private func readAvailable(limit: Int) -> Int {
        var buffer = [UInt8](repeating: 0, count: limit)
        let count = buffer.withUnsafeMutableBytes { Darwin.read(master, $0.baseAddress, limit) }
        guard count > 0 else {
            // End of file or EIO: the program and everything it started closed the terminal.
            if count == 0 || (errno != EINTR && errno != EAGAIN) { suspendReading() }
            return 0
        }
        deliver(Data(buffer[0..<count]))
        return count
    }

    private func deliver(_ data: Data) {
        lock.lock()
        unacked += data.count
        let pause = !paused && unacked >= Self.highWater && !finished
        if pause { paused = true }
        let source = readSource
        lock.unlock()
        if pause { source?.suspend() }
        onOutput?(data)
    }

    /// Stops the read source from firing at end of file until the program's exit is handled.
    private func suspendReading() {
        lock.lock()
        let suspend = !paused && !finished
        if suspend { paused = true }
        let source = readSource
        lock.unlock()
        if suspend { source?.suspend() }
    }

    /// The program exited: hand out what is still buffered, then report the exit once.
    private func programExited() {
        lock.lock()
        guard !finished else {
            lock.unlock()
            return
        }
        lock.unlock()
        var status: Int32 = 0
        let reaped = waitpid(pid, &status, WNOHANG)
        guard reaped == pid else { return }
        // Drain whatever the terminal still holds, so the last lines are never lost.
        var available: Int32 = 0
        while ioctl(master, FIONREAD, &available) == 0, available > 0 {
            if readAvailable(limit: Int(available)) == 0 { break }
        }
        lock.lock()
        finished = true
        let wasPaused = paused
        paused = false
        let read = readSource
        let exit = exitSource
        lock.unlock()
        // A suspended source must be resumed before it can be cancelled.
        if wasPaused { read?.resume() }
        read?.cancel()
        exit?.cancel()
        onExit?(Self.exitCode(status))
    }

    // MARK: - Helpers

    static func exitCode(_ status: Int32) -> Int32 {
        let signal = status & 0x7f
        if signal == 0 { return (status >> 8) & 0xff }
        return 128 + signal
    }

    private static func clamp(_ value: Int) -> UInt16 { UInt16(min(max(value, 1), 1000)) }

    private static func cStrings(_ strings: [String]) -> UnsafeMutablePointer<UnsafeMutablePointer<CChar>?> {
        let array = UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>.allocate(capacity: strings.count + 1)
        for (index, string) in strings.enumerated() { array[index] = strdup(string) }
        array[strings.count] = nil
        return array
    }

    private static func free(_ array: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>) {
        var index = 0
        while let pointer = array[index] {
            Darwin.free(pointer)
            index += 1
        }
        array.deallocate()
    }
}
