import OvernoteCore
import Foundation
import WebKit

/// Serves the editor build from `--editor-dir` over `overnote://app/`.
/// Without an `index.html` there, a built in placeholder editor is served instead.
@MainActor
final class EditorSchemeHandler: NSObject, WKURLSchemeHandler {
    static let scheme = "overnote"

    private let assets: EditorAssets?
    private let logger: FileLogger
    private var stoppedTasks = Set<ObjectIdentifier>()

    init(editorDirectory: String?, logger: FileLogger) {
        self.assets = editorDirectory.map(EditorAssets.init(directory:))
        self.logger = logger
        super.init()
        if assets?.hasIndex != true {
            logger.log("No index.html in the editor directory; serving the placeholder editor")
        }
    }

    func webView(_ webView: WKWebView, start urlSchemeTask: any WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url else {
            urlSchemeTask.didFailWithError(URLError(.badURL))
            return
        }
        let isIndex = url.path.isEmpty || url.path == "/" || url.path == "/index.html"
        if isIndex && assets?.hasIndex != true {
            respond(urlSchemeTask, url: url, status: 200, mimeType: "text/html; charset=utf-8", data: Data(PlaceholderPage.html.utf8))
            return
        }
        guard let assets, let file = assets.file(for: url), let data = try? Data(contentsOf: file) else {
            logger.log("Editor asset not found: \(url.path)")
            respond(urlSchemeTask, url: url, status: 404, mimeType: "text/plain; charset=utf-8", data: Data("Not found".utf8))
            return
        }
        respond(urlSchemeTask, url: url, status: 200, mimeType: EditorAssets.mimeType(forExtension: file.pathExtension), data: data)
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: any WKURLSchemeTask) {
        stoppedTasks.insert(ObjectIdentifier(urlSchemeTask))
    }

    private func respond(_ task: any WKURLSchemeTask, url: URL, status: Int, mimeType: String, data: Data) {
        // WebKit raises an exception when a stopped task is answered.
        guard stoppedTasks.remove(ObjectIdentifier(task)) == nil else { return }
        let headers = [
            "Content-Type": mimeType,
            "Content-Length": String(data.count),
            "Cache-Control": "no-cache",
        ]
        guard let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)
        else {
            task.didFailWithError(URLError(.cannotParseResponse))
            return
        }
        task.didReceive(response)
        task.didReceive(data)
        task.didFinish()
    }
}
