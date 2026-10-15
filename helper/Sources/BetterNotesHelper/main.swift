import AppKit
import BetterNotesCore
import Darwin
import Foundation

// Sockets report a closed peer as EPIPE instead of killing the process.
signal(SIGPIPE, SIG_IGN)

let arguments: HelperArguments
do {
    arguments = try HelperArguments.parse(Array(CommandLine.arguments.dropFirst()))
} catch {
    FileHandle.standardError.write(Data("\(error)\n\(HelperArguments.usage)\n".utf8))
    exit(64)
}

if arguments.version {
    print(HelperVersion.current)
    exit(0)
}

let runtime = HelperRuntime(arguments: arguments)
if runtime.acquire() == .alreadyRunning {
    exit(0)
}

if arguments.headless {
    let host = RecordingHost(onShutdown: { runtime.scheduleShutdown() })
    runtime.start(host: host)
    dispatchMain()
} else {
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    let delegate = AppDelegate(runtime: runtime)
    app.delegate = delegate
    app.run()
}
