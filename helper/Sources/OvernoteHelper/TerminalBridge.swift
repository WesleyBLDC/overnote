import Foundation
import OvernoteCore
import WebKit

/// The terminal drawer's native side (docs/architecture.md, the terminal drawer): owns the one
/// `TerminalSession`, takes keystrokes and acks on the fast lane (`overnoteTerm`, fire and forget,
/// never queued behind note saves), and sends output to the page as `term.data` as soon as it
/// arrives, with at most two sends in flight and whatever arrives meanwhile merged into the next.
@MainActor
final class TerminalBridge: NSObject, WKScriptMessageHandler {
    static let handlerName = "overnoteTerm"
    /// Output sends that may wait for the page at once.
    static let maxInFlight = 2

    private weak var webView: WKWebView?
    private let logger: FileLogger
    private let environment: [String: String]
    private var session: TerminalSession?
    private var backend: TerminalBackend = .shell
    /// Bumped for every new session, so a closed session's late output and exit are ignored.
    private var generation = 0
    private var pending = Data()
    private var inFlight = 0
    private var exitCode: Int32?
    /// Whether keystrokes reach the program: only while the drawer is open.
    var acceptsInput: () -> Bool = { false }
    /// `hc`, looked up once (it runs the login shell), then reused.
    private var herdrLookup: Task<String?, Never>?

    init(webView: WKWebView, logger: FileLogger, environment: [String: String] = ProcessInfo.processInfo.environment) {
        self.webView = webView
        self.logger = logger
        self.environment = environment
    }

    // MARK: - Methods (term.open, term.resize, term.close)

    /// Starts the drawer's program, or resizes the one already running; one session per helper,
    /// so two opens never start two programs.
    func open(cols: Int, rows: Int) async throws -> TerminalBackend {
        if let session, !session.isFinished {
            session.resize(cols: cols, rows: rows)
            return backend
        }
        let environment = self.environment
        let lookup = herdrLookup ?? Task.detached { TerminalLauncher.findHC(environment: environment) }
        herdrLookup = lookup
        let hc = await lookup.value
        // Another open may have started a session while the lookup ran.
        if let session, !session.isFinished {
            session.resize(cols: cols, rows: rows)
            return backend
        }
        let (command, backend) = TerminalLauncher.command(hc: hc, environment: environment)
        let session = try TerminalSession(command: command, cols: cols, rows: rows)
        generation += 1
        let current = generation
        pending = Data()
        exitCode = nil
        session.onOutput = { [weak self] data in
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.received(data, generation: current) } }
        }
        session.onExit = { [weak self] code in
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.exited(code, generation: current) } }
        }
        self.session = session
        self.backend = backend
        session.start()
        logger.log("Terminal started (\(backend.rawValue))")
        return backend
    }

    func resize(cols: Int, rows: Int) {
        session?.resize(cols: cols, rows: rows)
    }

    /// Ends the program in the drawer: for Herdr that is only the attach, and the shell keeps running.
    func close() {
        guard let session else { return }
        self.session = nil
        generation += 1
        pending = Data()
        exitCode = nil
        session.close()
    }

    // MARK: - Output

    private func received(_ data: Data, generation: Int) {
        guard generation == self.generation else { return }
        pending.append(data)
        pump()
    }

    private func exited(_ code: Int32, generation: Int) {
        guard generation == self.generation else { return }
        exitCode = code
        session = nil
        pump()
    }

    /// Sends what is pending while fewer than two sends wait; reports the exit after the last output.
    private func pump() {
        guard let webView else { return }
        while inFlight < Self.maxInFlight, !pending.isEmpty {
            let chunk = pending
            pending = Data()
            inFlight += 1
            let current = generation
            let script = "window.overnoteBridge && window.overnoteBridge.emit(\"term.data\", {\"data\":\"\(chunk.base64EncodedString())\"});"
            webView.evaluateJavaScript(script) { [weak self] _, error in
                MainActor.assumeIsolated {
                    guard let self else { return }
                    self.inFlight -= 1
                    if error != nil, current == self.generation {
                        // The page never drew it, so it will never ack it: do it here, or reading stays paused.
                        self.session?.ack(chunk.count)
                    }
                    self.pump()
                }
            }
        }
        if pending.isEmpty, inFlight == 0, let code = exitCode {
            exitCode = nil
            let script = "window.overnoteBridge && window.overnoteBridge.emit(\"term.exit\", {\"code\":\(code)});"
            webView.evaluateJavaScript(script) { [logger] _, error in
                if let error { logger.log("Terminal exit event failed: \(error.localizedDescription)") }
            }
        }
    }

    // MARK: - The fast lane

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, message.frameInfo.securityOrigin.protocol == EditorSchemeHandler.scheme,
            let body = message.body as? [String: Any], let type = body["type"] as? String
        else { return }
        switch type {
        case "write":
            guard acceptsInput(), let session, let text = body["data"] as? String, let data = Data(base64Encoded: text)
            else { return }
            session.write(data)
        case "ack":
            guard let bytes = (body["bytes"] as? NSNumber)?.intValue else { return }
            session?.ack(bytes)
        default:
            return
        }
    }
}
