import AppKit
import OvernoteCore
import Darwin
import Foundation

// Sockets report a closed peer as EPIPE instead of killing the process.
signal(SIGPIPE, SIG_IGN)

let arguments: HelperArguments
do {
    arguments = try HelperArguments.parse(Array(CommandLine.arguments.dropFirst()))
} catch {
    try? FileHandle.standardError.write(contentsOf: Data("\(error)\n\(HelperArguments.usage)\n".utf8))
    exit(64)
}

if arguments.version {
    print(HelperVersion.current)
    exit(0)
}
if arguments.schemaVersion {
    print(HelperVersion.schemaVersion)
    exit(0)
}

let runtime = HelperRuntime(arguments: arguments)
if runtime.acquire() == .alreadyRunning {
    exit(0)
}

if arguments.headless {
    // With --test-hooks, a page that stands in for the panel's editor takes the shutdown flush.
    let flushRelay = HeadlessFlushRelay()
    let host = RecordingHost(
        onShutdown: { runtime.scheduleShutdown() },
        onFlush: { timeout in arguments.testHooks ? await flushRelay.request(timeout: timeout) : true })
    // With --test-hooks, smoke tests can read what a window host would have received.
    let hooks: RPCDispatcher.ExtensionHandler? =
        arguments.testHooks
        ? { @Sendable method, params in
            switch method {
            case "test.events":
                return .array(host.events.map { ["event": .string($0.0), "payload": $0.1] })
            case "test.visible":
                return .bool(host.isVisible)
            case "test.asBridge":
                // Lets an end to end test run the real editor build against this helper: the
                // page's bridge messages arrive over the socket and are handled as the bridge.
                let p = try Params(params)
                guard let dispatcher = await MainActor.run(body: { runtime.dispatcher }) else {
                    throw RPCError.internal("No dispatcher")
                }
                return try await dispatcher.handle(method: try p.string("method"), params: p.values["params"], source: .bridge)
            case "test.awaitFlush":
                // A page standing in for the panel long polls here; the answer is a flush
                // request's number, or null when none came within waitMs.
                let p = try Params(params)
                let waitMs = Int(try p.optionalInt("waitMs") ?? 1000)
                return await flushRelay.next(waitMs: waitMs).map { .int(Int64($0)) } ?? .null
            case "test.flushDone":
                let p = try Params(params)
                guard let request = try p.optionalInt("request") else { throw RPCError.badParams("request is required") }
                await flushRelay.done(Int(request))
                return [:]
            default:
                return nil
            }
        } : nil
    runtime.start(host: host, extensionHandler: hooks)
    dispatchMain()
} else {
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    let delegate = AppDelegate(runtime: runtime)
    app.delegate = delegate
    app.run()
}

/// Headless with `--test-hooks`: relays the shutdown flush to a page that runs the shipped
/// editor over `test.asBridge` (editor/tests/real-helper.spec.ts), the way the panel's
/// `callAsyncJavaScript` reaches the page in a window host. The page long polls
/// `test.awaitFlush`, calls `window.overnoteBridge.flush()`, and reports `test.flushDone`.
/// With no page polling, there is no editor to flush and a request answers true at once.
actor HeadlessFlushRelay {
    private var requested = 0
    private var handedOut = 0
    private var completed = 0
    private var polls = 0
    private var lastPollEnd = Date.distantPast

    private var hasEditor: Bool { polls > 0 || Date().timeIntervalSince(lastPollEnd) < 1 }

    func request(timeout: TimeInterval) async -> Bool {
        guard hasEditor else { return true }
        requested += 1
        let number = requested
        let deadline = Date().addingTimeInterval(timeout)
        while completed < number {
            if Date() > deadline { return false }
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        return true
    }

    func next(waitMs: Int) async -> Int? {
        polls += 1
        defer {
            polls -= 1
            lastPollEnd = Date()
        }
        let deadline = Date().addingTimeInterval(Double(waitMs) / 1000)
        while handedOut >= requested {
            if Date() > deadline { return nil }
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        handedOut = requested
        return requested
    }

    func done(_ number: Int) {
        completed = max(completed, number)
    }
}
