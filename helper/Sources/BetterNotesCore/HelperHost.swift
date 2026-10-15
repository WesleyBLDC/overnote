import Foundation

/// Everything the dispatcher needs from the app around it: the panel, native services, and
/// the event channel to the editor. The AppKit app implements it on the main actor; tests
/// and `--headless` use `RecordingHost`.
public protocol HelperHost: Sendable {
    /// Shows and focuses the panel, or hides it. Returns the new visibility.
    func toggleWindow() async -> Bool
    func showWindow() async
    func hideWindow() async
    /// Applies a content driven height (in points), clamped by the host.
    func resizeWindow(contentHeight: Double) async
    /// Opens a link in the default app for its scheme (already checked by `LinkPolicy`).
    func openURL(_ url: URL) async
    /// Returns keyboard focus to the previously frontmost app without hiding.
    func resignFocus() async
    func copyToClipboard(text: String, html: String?) async
    /// Runs a save panel. Returns the saved path, or nil when the user cancelled.
    func saveFile(suggestedName: String, content: String) async throws -> String?
    /// Called after `settings.set` stored new settings.
    func settingsDidChange(_ settings: Settings) async
    /// Sends an event to the editor (`window.betterNotesBridge.emit`).
    func emit(_ event: String, _ payload: JSONValue) async
    /// Exits gracefully soon after the current reply has been written.
    func requestShutdown() async
}

/// A host with no window. It records calls, which makes it the test double and the
/// implementation behind `--headless`.
public final class RecordingHost: HelperHost, @unchecked Sendable {
    public enum Call: Equatable, Sendable {
        case toggle, show, hide, resize(Double), openURL(String), resignFocus, copy(String, String?), save(String, String)
        case settingsChanged(Settings), emit(String, JSONValue), shutdown
    }

    private let lock = NSLock()
    private var recorded: [Call] = []
    private var visible = false
    private let onShutdown: @Sendable () -> Void

    public init(onShutdown: @escaping @Sendable () -> Void = {}) {
        self.onShutdown = onShutdown
    }

    public var calls: [Call] { lock.withLock { recorded } }
    public var isVisible: Bool { lock.withLock { visible } }

    public var events: [(String, JSONValue)] {
        calls.compactMap { call in
            if case .emit(let name, let payload) = call { return (name, payload) }
            return nil
        }
    }

    public func reset() { lock.withLock { recorded.removeAll() } }

    private func record(_ call: Call) { lock.withLock { recorded.append(call) } }

    public func toggleWindow() async -> Bool {
        lock.withLock {
            recorded.append(.toggle)
            visible.toggle()
            return visible
        }
    }

    public func showWindow() async {
        lock.withLock {
            recorded.append(.show)
            visible = true
        }
    }

    public func hideWindow() async {
        lock.withLock {
            recorded.append(.hide)
            visible = false
        }
    }

    public func resizeWindow(contentHeight: Double) async { record(.resize(contentHeight)) }
    public func openURL(_ url: URL) async { record(.openURL(url.absoluteString)) }
    public func resignFocus() async { record(.resignFocus) }
    public func copyToClipboard(text: String, html: String?) async { record(.copy(text, html)) }

    public func saveFile(suggestedName: String, content: String) async throws -> String? {
        record(.save(suggestedName, content))
        return nil
    }

    public func settingsDidChange(_ settings: Settings) async { record(.settingsChanged(settings)) }
    public func emit(_ event: String, _ payload: JSONValue) async { record(.emit(event, payload)) }

    public func requestShutdown() async {
        record(.shutdown)
        onShutdown()
    }
}

/// Makes a user supplied file name safe for a save panel: drops path separators and
/// control characters, trims whitespace, caps the length, never starts with a dot, and
/// falls back to "Untitled".
public enum FileNameSanitizer {
    public static let fallback = "Untitled"
    static let maxLength = 200

    public static func sanitize(_ name: String) -> String {
        let forbidden: Set<Character> = ["/", "\\", ":"]
        var cleaned = String(
            name.filter { character in
                !forbidden.contains(character)
                    && !character.unicodeScalars.contains { CharacterSet.controlCharacters.contains($0) }
            })
        cleaned = cleaned.trimmingCharacters(in: .whitespacesAndNewlines)
        if cleaned.count > maxLength {
            cleaned = String(cleaned.prefix(maxLength)).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        if cleaned.isEmpty || cleaned.allSatisfy({ $0 == "." }) {
            return fallback
        }
        // A leading dot would make a hidden file; ".md" (an empty title) becomes "Untitled.md".
        if cleaned.hasPrefix(".") {
            cleaned = fallback + cleaned
        }
        return cleaned
    }
}

/// Which links `app.openURL` may open: web pages, mail, and Raycast deeplinks only.
public enum LinkPolicy {
    public static let allowedSchemes: Set<String> = ["http", "https", "mailto", "raycast"]

    /// The URL to open, or nil when the text is not a URL with an allowed scheme.
    public static func openableURL(_ text: String) -> URL? {
        guard let url = URL(string: text.trimmingCharacters(in: .whitespacesAndNewlines)),
            let scheme = url.scheme?.lowercased(), allowedSchemes.contains(scheme)
        else { return nil }
        if scheme == "http" || scheme == "https" {
            guard let host = url.host, !host.isEmpty else { return nil }
        }
        return url
    }
}
