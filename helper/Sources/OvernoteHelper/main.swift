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
    let host = RecordingHost(onShutdown: { runtime.scheduleShutdown() })
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
