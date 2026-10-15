import BetterNotesCore
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
    private var lock: InstanceLock?
    private var server: SocketServer?
    private var purgeScheduler: PurgeScheduler?
    private var signalSources: [DispatchSourceSignal] = []
    private var isShuttingDown = false

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
        logger.log("Starting BetterNotesHelper \(HelperVersion.current) (pid \(getpid()))")
        installSignalHandlers()
        do {
            try SocketPaths.prepareDirectory(for: arguments.pidFile)
            try SocketPaths.prepareDirectory(for: arguments.socketPath)
            let lock = InstanceLock(path: arguments.pidFile)
            try lock.acquire()
            self.lock = lock
        } catch let error as InstanceLock.AlreadyRunning {
            logger.log("\(error); exiting")
            forwardShowIfRequested()
            return .alreadyRunning
        } catch {
            fail("Cannot take the instance lock: \(error)")
        }

        do {
            let path = (arguments.supportDir as NSString).appendingPathComponent("notes.sqlite")
            let repository = try NotesRepository(path: path)
            self.repository = repository
        } catch {
            fail("Cannot open the database: \(error)")
        }
        return .started
    }

    /// Starts serving requests through `host`, and starts the purge schedule.
    func start(host: any HelperHost, extensionHandler: RPCDispatcher.ExtensionHandler? = nil) {
        guard let repository else { return }
        let dispatcher = RPCDispatcher(repository: repository, host: host, extensionHandler: extensionHandler)
        self.dispatcher = dispatcher

        let logger = logger
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
            MainActor.assumeIsolated { () -> Void in self.shutdown(reason: "system.shutdown") }
        }
    }

    /// Closes everything this process owns and exits with status 0.
    func shutdown(reason: String) -> Never {
        if !isShuttingDown {
            isShuttingDown = true
            logger.log("Shutting down (\(reason))")
            server?.stop()
            purgeScheduler?.cancel()
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
                MainActor.assumeIsolated { () -> Void in self.shutdown(reason: "signal \(signalNumber)") }
            }
            source.resume()
            signalSources.append(source)
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
        FileHandle.standardError.write(Data((message + "\n").utf8))
        server?.stop()
        lock?.release()
        logger.close()
        exit(1)
    }
}
