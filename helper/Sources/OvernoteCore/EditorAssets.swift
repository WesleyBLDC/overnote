import Foundation

/// Maps `overnote://app/<path>` requests onto files under the editor directory.
public struct EditorAssets: Sendable {
    public let root: URL

    public init(directory: String) {
        root = URL(fileURLWithPath: directory, isDirectory: true).standardizedFileURL.resolvingSymlinksInPath()
    }

    /// The file for a request URL, or nil when the host is not `app`, the path escapes the
    /// editor directory (`..`, encoded separators, or symlinks pointing outside), or the
    /// file does not exist.
    public func file(for url: URL) -> URL? {
        guard url.host == "app" else { return nil }
        var path = url.path
        if path.isEmpty || path == "/" {
            path = "/index.html"
        }
        let components = path.split(separator: "/", omittingEmptySubsequences: true)
        guard !components.contains(where: { $0 == ".." || $0 == "." || $0.contains("\\") }) else { return nil }
        var candidate = root
        for component in components {
            candidate.appendPathComponent(String(component))
        }
        candidate = candidate.standardizedFileURL.resolvingSymlinksInPath()
        let rootPath = root.path.hasSuffix("/") ? root.path : root.path + "/"
        guard candidate.path.hasPrefix(rootPath) else { return nil }
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: candidate.path, isDirectory: &isDirectory), !isDirectory.boolValue
        else { return nil }
        return candidate
    }

    public var hasIndex: Bool {
        FileManager.default.fileExists(atPath: root.appendingPathComponent("index.html").path)
    }

    /// MIME types for the files a Vite build produces, defaulting to octet-stream.
    public static func mimeType(forExtension ext: String) -> String {
        switch ext.lowercased() {
        case "html", "htm": return "text/html; charset=utf-8"
        case "js", "mjs", "cjs": return "text/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json", "map": return "application/json; charset=utf-8"
        case "svg": return "image/svg+xml"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "gif": return "image/gif"
        case "webp": return "image/webp"
        case "ico": return "image/x-icon"
        case "woff": return "font/woff"
        case "woff2": return "font/woff2"
        case "ttf": return "font/ttf"
        case "otf": return "font/otf"
        case "wasm": return "application/wasm"
        case "txt", "md": return "text/plain; charset=utf-8"
        default: return "application/octet-stream"
        }
    }
}
