import AppKit
import OvernoteCore
import WebKit

/// The editor side of the RPC: receives `overnote` script messages, runs them through the
/// shared dispatcher, and answers with `window.overnoteBridge.resolve/reject`.
@MainActor
final class WebBridge: NSObject, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
    static let handlerName = "overnote"

    private let handler: RPCDispatcher
    private weak var webView: WKWebView?
    private let logger: FileLogger
    /// Called with each method the page sends (test hooks only).
    var onMessage: ((String) -> Void)?
    /// Called when the main frame starts loading our own page (a reload included).
    var onPageNavigation: (() -> Void)?

    init(dispatcher: RPCDispatcher, webView: WKWebView, logger: FileLogger) {
        self.handler = dispatcher
        self.webView = webView
        self.logger = logger
    }

    // MARK: - Messages from the page

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        // Only our own bundled page may talk to the helper.
        guard message.frameInfo.isMainFrame, message.frameInfo.securityOrigin.protocol == EditorSchemeHandler.scheme
        else {
            logger.log("Ignoring a bridge message from an unexpected origin")
            return
        }
        guard let body = message.body as? [String: Any], JSONSerialization.isValidJSONObject(body),
            let data = try? JSONSerialization.data(withJSONObject: body),
            let request = try? JSONValue.parse(data)
        else {
            logger.log("Ignoring a malformed bridge message")
            return
        }
        let id = request["id"] ?? .null
        guard let method = request["method"]?.stringValue else {
            reject(id: id, error: .badParams("method must be a string"))
            return
        }
        onMessage?(method)
        let params = request["params"]
        let dispatcher = handler
        Task {
            do {
                let result = try await dispatcher.handle(method: method, params: params, source: .bridge)
                resolve(id: id, result: result)
            } catch let error as RPCError {
                reject(id: id, error: error)
            } catch {
                reject(id: id, error: .internal("\(error)"))
            }
        }
    }

    // MARK: - Calls into the page

    func resolve(id: JSONValue, result: JSONValue) {
        call("resolve", id.serialized(), result.serialized())
    }

    func reject(id: JSONValue, error: RPCError) {
        call("reject", id.serialized(), error.json.serialized())
    }

    func emit(_ event: String, _ payload: JSONValue) {
        call("emit", JSONValue.string(event).serialized(), payload.serialized())
    }

    /// JSON text is valid JavaScript, so arguments are embedded as JSON literals.
    private func call(_ function: String, _ first: String, _ second: String) {
        guard let webView else { return }
        let script = "window.overnoteBridge && window.overnoteBridge.\(function)(\(first), \(second));"
        webView.evaluateJavaScript(script) { [logger] _, error in
            if let error {
                logger.log("Bridge \(function) failed: \(error.localizedDescription)")
            }
        }
    }

    // MARK: - Navigation

    func webView(
        _ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void
    ) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.cancel)
            return
        }
        if url.scheme == EditorSchemeHandler.scheme || url.scheme == "about" {
            if url.scheme == EditorSchemeHandler.scheme, navigationAction.targetFrame?.isMainFrame == true {
                onPageNavigation?()
            }
            decisionHandler(.allow)
            return
        }
        // Links in notes open in the default browser, never inside the panel.
        if navigationAction.navigationType == .linkActivated, ["http", "https", "mailto"].contains(url.scheme ?? "") {
            NSWorkspace.shared.open(url)
        }
        decisionHandler(.cancel)
    }

    func webView(
        _ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if let url = navigationAction.request.url, ["http", "https", "mailto"].contains(url.scheme ?? "") {
            NSWorkspace.shared.open(url)
        }
        return nil
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        logger.log("Web content process terminated; reloading the editor")
        webView.reload()
    }
}

/// `WKUserContentController` retains its handlers; this breaks the cycle.
@MainActor
final class WeakScriptMessageHandler: NSObject, WKScriptMessageHandler {
    private weak var target: (any WKScriptMessageHandler)?

    init(_ target: any WKScriptMessageHandler) {
        self.target = target
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(userContentController, didReceive: message)
    }
}
