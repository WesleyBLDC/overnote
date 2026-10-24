import Foundation

/// Everything the dispatcher needs from the app around it: the panel, native services, and
/// the event channel to the editor. The AppKit app implements it on the main actor; tests
/// and `--headless` use `RecordingHost`.
public protocol HelperHost: Sendable {
    /// Shows and focuses the panel, or hides it. Returns the new visibility.
    func toggleWindow() async -> Bool
    func showWindow() async
    func hideWindow() async
    /// Places the panel inside its display (`window.place`): the panel's display while it is
    /// visible, the display under the pointer while it is hidden. A hidden panel stays hidden,
    /// except a show waiting for its first height report, which placing orders in at the placed
    /// frame. Returns the resulting frame as an AppKit screen rect.
    func placeWindow(_ placement: PanelPlacement) async -> CGRect
    /// Applies a content driven height (in points), clamped by the host. A `temporary` report
    /// (confirmation dialogs) applies even with auto-sizing off; the next non temporary report
    /// restores normal behavior.
    func resizeWindow(contentHeight: Double, temporary: Bool) async
    /// The smallest the panel may be, in points: the editor's bars plus one line of the note at
    /// the current zoom. The host never goes below `PanelSizing.floorSize` and grows a smaller panel.
    func setMinimumSize(width: Double, height: Double) async
    /// Replaces the areas of the web view where a mouse down drags the panel. Points, with a
    /// top left origin relative to the web view.
    func setDragRegions(_ rects: [DragRect]) async
    /// Opens a link in the default app for its scheme (already checked by `LinkPolicy`).
    func openURL(_ url: URL) async
    /// Returns keyboard focus to the previously frontmost app without hiding.
    func resignFocus() async
    func copyToClipboard(text: String, html: String?) async
    /// Runs a save panel. Returns the saved path, or nil when the user cancelled.
    func saveFile(suggestedName: String, content: String) async throws -> String?
    /// Called after `settings.set` stored new settings.
    func settingsDidChange(_ settings: Settings) async
    /// Sends an event to the editor (`window.overnoteBridge.emit`).
    func emit(_ event: String, _ payload: JSONValue) async
    /// Exits gracefully soon after the current reply has been written.
    func requestShutdown() async
}

/// One `window.setDragRegions` rect: points, top left origin, relative to the web view.
public struct DragRect: Equatable, Sendable {
    public var x: Double
    public var y: Double
    public var width: Double
    public var height: Double

    public init(x: Double, y: Double, width: Double, height: Double) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }

    public var json: JSONValue { ["x": .double(x), "y": .double(y), "width": .double(width), "height": .double(height)] }
}

/// A host with no window. It records calls, which makes it the test double and the
/// implementation behind `--headless`.
public final class RecordingHost: HelperHost, @unchecked Sendable {
    public enum Call: Equatable, Sendable {
        case toggle, show, hide, place(PanelPlacement), resize(Double, temporary: Bool), minimumSize(Double, Double), dragRegions([DragRect]), openURL(String), resignFocus, copy(String, String?), save(String, String)
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

    /// The display a headless host pretends to have, and the panel size on it.
    public static let visibleFrame = CGRect(x: 0, y: 0, width: 1440, height: 875)
    public static let panelSize = CGSize(width: 640, height: 560)

    public func placeWindow(_ placement: PanelPlacement) async -> CGRect {
        record(.place(placement))
        return PanelGeometry.placed(
            placement, current: Self.panelSize, visible: Self.visibleFrame, minimum: PanelSizing.floorSize)
    }

    public func resizeWindow(contentHeight: Double, temporary: Bool) async {
        record(.resize(contentHeight, temporary: temporary))
    }
    public func setMinimumSize(width: Double, height: Double) async { record(.minimumSize(width, height)) }
    public func setDragRegions(_ rects: [DragRect]) async { record(.dragRegions(rects)) }
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
/// control characters, trims whitespace, caps the length in UTF-8 bytes (APFS allows 255 per
/// name) while keeping a short extension, never starts with a dot, and falls back to "Untitled".
public enum FileNameSanitizer {
    public static let fallback = "Untitled"
    static let maxBytes = 240

    public static func sanitize(_ name: String) -> String {
        let forbidden: Set<Character> = ["/", "\\", ":"]
        var cleaned = String(
            name.filter { character in
                !forbidden.contains(character)
                    && !character.unicodeScalars.contains { CharacterSet.controlCharacters.contains($0) }
            })
        cleaned = cleaned.trimmingCharacters(in: .whitespacesAndNewlines)
        if cleaned.utf8.count > maxBytes {
            let ext = (cleaned as NSString).pathExtension
            let keepsExtension = !ext.isEmpty && ext.count <= 10 && ext.allSatisfy { $0.isLetter || $0.isNumber }
            var base = keepsExtension ? (cleaned as NSString).deletingPathExtension : cleaned
            let budget = maxBytes - (keepsExtension ? ext.utf8.count + 1 : 0)
            // Whole characters only, so a multi-byte character or emoji is never split.
            while base.utf8.count > budget { base.removeLast() }
            base = base.trimmingCharacters(in: .whitespacesAndNewlines)
            cleaned = keepsExtension ? base + "." + ext : base
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
