import OvernoteCore
import Darwin
import Foundation

/// Process lifecycle shared by the GUI and headless modes: single instance lock, database,
/// socket server, purge schedule, signal handling, and graceful shutdown.
@MainActor
final class HelperRuntime {
    let arguments: HelperArguments
    let logger: FileLogger
    private(set) var repository: NotesRepository?
    private(set) var dispatcher: RPCDispatcher?
    let backups = BackupStore(directory: BackupStore.defaultDirectory())
    private var backupScheduler: BackupScheduler?
    private var lock: InstanceLock?
    private var server: SocketServer?
    private var purgeScheduler: PurgeScheduler?
    private var signalSources: [DispatchSourceSignal] = []
    private var isShuttingDown = false
    /// The host serving requests, asked to flush the editor before a shutdown.
    private var host: (any HelperHost)?
    /// A shutdown is waiting for the editor to save; further requests wait with it.
    private var isFlushing = false

    init(arguments: HelperArguments) {
        self.arguments = arguments
        let supportDir = arguments.supportDir
        try? FileManager.default.createDirectory(atPath: supportDir, withIntermediateDirectories: true)
        #if DEBUG
            let mirror = true
        #else
            let mirror = false
        #endif
        logger = FileLogger(path: (supportDir as NSString).appendingPathComponent("helper.log"), mirrorToStderr: mirror)
    }

    enum StartOutcome {
        case started
        /// Another helper owns the lock; this process should exit successfully.
        case alreadyRunning
    }

    /// Takes the instance lock and opens the database. Call before creating any UI.
    func acquire() -> StartOutcome {
        logger.log("Starting OvernoteHelper \(HelperVersion.current) (pid \(getpid()))")
        installSignalHandlers()
        do {
            try SocketPaths.prepareDirectory(for: arguments.pidFile)
            try SocketPaths.prepareDirectory(for: arguments.socketPath)
            let lock = InstanceLock(path: arguments.pidFile)
            do {
                try lock.acquire()
            } catch let error as InstanceLock.AlreadyRunning {
                // The app takes over from a helper the extension started; any other pair keeps
                // the running one (docs/architecture.md section 1, Handover).
                guard arguments.app, takeOver(from: error.pid) else { throw error }
                try lock.acquire()
            }
            self.lock = lock
        } catch let error as InstanceLock.AlreadyRunning {
            logger.log("\(error); exiting")
            if arguments.app {
                forwardShow()
            } else {
                forwardShowIfRequested()
            }
            return .alreadyRunning
        } catch {
            fail("Cannot take the instance lock: \(error)")
        }

        let pendingImport = migrateLegacyDatabase()

        do {
            let path = (arguments.supportDir as NSString).appendingPathComponent("notes.sqlite")
            let isNew = !FileManager.default.fileExists(atPath: path)
            let repository = try NotesRepository(path: path, backups: backups)
            self.repository = repository
            // A missing database next to existing backups usually means the extension was removed
            // and installed again. Start empty, touch nothing, and let the extension offer a restore.
            if isNew, let count = try? backups.list().count, count > 0 {
                try repository.setRestoreOffered(true)
                logger.log("No database yet, but \(count) backup(s) in \(backups.directory): offering a restore")
            }
        } catch {
            fail("Cannot open the database: \(error)")
        }
        if let pendingImport { importLegacyDatabase(from: pendingImport) }
        return .started
    }

    /// Starts serving requests through `host`, and starts the purge schedule.
    func start(host: any HelperHost, extensionHandler: RPCDispatcher.ExtensionHandler? = nil) {
        guard let repository else { return }
        self.host = host
        let dispatcher = RPCDispatcher(
            repository: repository, host: host, backups: backups, hostKind: arguments.hostKind,
            extensionHandler: extensionHandler)
        self.dispatcher = dispatcher

        let logger = logger
        backupScheduler = BackupScheduler(store: backups, repository: repository, log: { logger.log($0) })
        purgeScheduler = PurgeScheduler {
            do {
                let removed = try repository.purgeExpiredTrash()
                if !removed.isEmpty {
                    logger.log("Purged \(removed.count) note(s) deleted more than 60 days ago")
                }
            } catch {
                logger.log("Trash purge failed: \(error)")
            }
        }

        let handler = RPCLineHandler(dispatcher: dispatcher, source: .socket)
        let server = SocketServer(path: arguments.socketPath, log: { logger.log($0) }) { line in
            await handler.handle(line: line)
        }
        do {
            try server.start()
        } catch {
            fail("Cannot start the socket server: \(error)")
        }
        self.server = server
        logger.log("Listening on \(arguments.socketPath)")
    }

    /// Exits after the reply in flight has had time to reach the client.
    nonisolated func scheduleShutdown() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
            MainActor.assumeIsolated { () -> Void in self.shutdownAfterFlush(reason: "system.shutdown") }
        }
    }

    /// How long a shutdown waits for the editor to save its pending edits.
    static let flushTimeout: TimeInterval = 1.5

    /// Asks the editor to save what the person typed in the last moments (its saves are
    /// debounced), waits for it at most `flushTimeout` while the database and the socket stay
    /// open to take that save, then shuts down (docs/architecture.md section 1, Shutdown).
    func shutdownAfterFlush(reason: String) {
        guard !isShuttingDown, !isFlushing else { return }
        guard let host else { shutdown(reason: reason) }
        isFlushing = true
        Task { @MainActor in
            if !(await host.flushEditor(timeout: Self.flushTimeout)) {
                logger.log("The editor did not confirm a save before the shutdown")
            }
            shutdown(reason: reason)
        }
    }

    /// Closes everything this process owns and exits with status 0.
    func shutdown(reason: String) -> Never {
        if !isShuttingDown {
            isShuttingDown = true
            logger.log("Shutting down (\(reason))")
            server?.stop()
            purgeScheduler?.cancel()
            backupScheduler?.cancel()
            repository?.close()
            lock?.release()
            logger.close()
        }
        exit(0)
    }

    private func installSignalHandlers() {
        for signalNumber in [SIGTERM, SIGINT, SIGHUP] {
            signal(signalNumber, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .main)
            source.setEventHandler {
                MainActor.assumeIsolated { () -> Void in self.shutdownAfterFlush(reason: "signal \(signalNumber)") }
            }
            source.resume()
            signalSources.append(source)
        }
    }

    /// How long the app waits for an extension helper to exit before it gives up.
    static let takeOverTimeout: TimeInterval = 5

    /// App mode, with the lock held by another helper: when that helper is an extension host (or
    /// an older one that reports no host), asks it to shut down and waits for the lock to free.
    /// Returns false when the running helper is an app host, which this process defers to.
    private func takeOver(from pid: Int32?) -> Bool {
        var host: String?
        if let client = try? RPCClient(path: arguments.socketPath), let ping = try? client.call("system.ping", timeout: 2) {
            host = ping["host"]?.stringValue ?? HelperHostKind.extension.rawValue
            if host == HelperHostKind.app.rawValue { return false }
            logger.log("Taking over from the extension's helper (pid \(pid.map(String.init) ?? "unknown"))")
            _ = try? client.call("system.shutdown", timeout: 10)
        }
        let deadline = Date().addingTimeInterval(Self.takeOverTimeout)
        var signalled = false
        while Date() < deadline {
            if !Self.lockIsHeld(arguments.pidFile) { return true }
            // A helper that does not answer, or that answered but did not exit, gets SIGTERM
            // halfway through the wait.
            if !signalled, Date() > deadline.addingTimeInterval(-Self.takeOverTimeout / 2), let pid, pid > 0 {
                signalled = true
                kill(pid, SIGTERM)
            }
            usleep(50_000)
        }
        logger.log("The running helper did not exit within \(Int(Self.takeOverTimeout)) s (host \(host ?? "unknown"))")
        return false
    }

    /// True while some process holds the instance lock on `path`.
    private static func lockIsHeld(_ path: String) -> Bool {
        let fd = open(path, O_RDONLY | O_CLOEXEC)
        guard fd >= 0 else { return false }
        defer { close(fd) }
        if flock(fd, LOCK_EX | LOCK_NB) == 0 {
            flock(fd, LOCK_UN)
            return false
        }
        return true
    }

    /// Moves the legacy database into the shared folder (docs/architecture.md section 9). With no
    /// shared database it copies the file before the database opens; a failed copy stops the
    /// start, so the helper never creates an empty database that would hide the legacy notes.
    /// A shared database with no note at all counts as not migrated: returns the legacy folder,
    /// which `importLegacyDatabase` imports once the database is open.
    private func migrateLegacyDatabase() -> String? {
        let decision = LegacyMigration.decide(
            supportDir: arguments.supportDir, legacySupportDir: arguments.legacySupportDir,
            fileExists: { FileManager.default.fileExists(atPath: $0) }, holdsNotes: LegacyMigration.holdsNotes(at:))
        if case .importInto = decision { return arguments.legacySupportDir }
        guard case .copy(let source) = decision else { return nil }
        do {
            try LegacyMigration.copy(from: source, toSupportDir: arguments.supportDir)
            logger.log("Copied the notes from \(source) into \(arguments.supportDir); the original stays as it was")
        } catch {
            fail("Could not copy the notes from \(source): \(error)")
        }
        return nil
    }

    /// Imports the legacy notes into the empty shared database, the way `system.importLegacy`
    /// does. A failure leaves the database as it was and the start goes on; the next start, or
    /// the extension's next command, tries again.
    private func importLegacyDatabase(from legacySupportDir: String) {
        guard let repository else { return }
        do {
            let outcome = try LegacyMigration.importLegacy(
                legacySupportDir: legacySupportDir, into: repository, backups: backups)
            if let ids = outcome.ids {
                logger.log("Imported \(ids.count) note(s) from \(legacySupportDir) into the empty shared database")
            }
        } catch {
            logger.log("Could not import the notes from \(legacySupportDir): \(error)")
        }
    }

    /// App mode, a second launch (opening the app again): shows the running helper's panel.
    private func forwardShow() {
        do {
            let client = try RPCClient(path: arguments.socketPath)
            _ = try client.call("window.show")
        } catch {
            logger.log("Could not ask the running helper to show its panel: \(error)")
        }
    }

    /// A second launch with `--show` asks the running helper to show its panel.
    private func forwardShowIfRequested() {
        guard arguments.show else { return }
        do {
            let client = try RPCClient(path: arguments.socketPath)
            _ = try client.call("window.show")
        } catch {
            logger.log("Could not forward --show to the running helper: \(error)")
        }
    }

    private func fail(_ message: String) -> Never {
        logger.log(message)
        try? FileHandle.standardError.write(contentsOf: Data((message + "\n").utf8))
        server?.stop()
        lock?.release()
        logger.close()
        exit(1)
    }
}
