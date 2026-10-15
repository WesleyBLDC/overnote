import AppKit
import BetterNotesCore
import UniformTypeIdentifiers
import WebKit

/// Owns the panel and its web view, implements `HelperHost` for the dispatcher, and carries
/// the window behavior of spec/window.md: three way toggle, no activation, per display
/// position memory, content driven height with the top edge fixed, and the user height rule.
@MainActor
final class PanelController: NSObject, HelperHost, NSWindowDelegate {
    /// Auto-height limits at 100% zoom (spec/window.md 6.3); both scale with zoom.
    static let autoMinimumHeight: CGFloat = 128
    static let autoMaximumHeight: CGFloat = 860
    /// Height changes this small are ignored (spec/window.md 6.6).
    static let heightTolerance: CGFloat = 2

    private let repository: NotesRepository
    private let logger: FileLogger
    private let onShutdown: @Sendable () -> Void
    private let schemeHandler: EditorSchemeHandler
    private var bridge: WebBridge?

    let panel: NotesPanel
    private var webView: NotesWebView?
    /// The app that was frontmost when the panel was shown; focus returns to it.
    private var previousApp: NSRunningApplication?
    private(set) var settings: Settings
    /// The latest content height the editor reported, nil until the first report.
    private var contentHeight: CGFloat?
    /// The frame when a user live resize began, to tell a height change from a width change.
    private var liveResizeStartFrame: NSRect?
    private var saveFrameWork: DispatchWorkItem?
    /// Every event sent to the editor, kept only when test hooks are on.
    private(set) var emittedEvents: [(String, JSONValue)] = []
    /// Bridge methods the editor called and heights it reported, kept only with test hooks.
    private(set) var bridgeMethods: [String] = []
    private(set) var resizeReports: [Double] = []
    private let recordEvents: Bool

    init(
        repository: NotesRepository, editorDirectory: String?, logger: FileLogger, recordEvents: Bool = false,
        onShutdown: @escaping @Sendable () -> Void
    ) {
        self.repository = repository
        self.logger = logger
        self.onShutdown = onShutdown
        self.recordEvents = recordEvents
        self.schemeHandler = EditorSchemeHandler(editorDirectory: editorDirectory, logger: logger)
        self.settings = (try? repository.settings()) ?? .defaults
        let width = settings.panelFrame?.width ?? NotesPanel.defaultWidth
        self.panel = NotesPanel(contentRect: NSRect(x: 0, y: 0, width: width, height: NotesPanel.defaultHeight))
        super.init()
        panel.delegate = self
        applyWindowSettings()
    }

    // MARK: - Setup

    /// Builds the body, the web view, and the bridge, and starts loading the editor while the
    /// panel stays hidden, so the first show only orders it in (spec/window.md 3.4).
    func prewarm(dispatcher: RPCDispatcher?) {
        let body = PanelBodyView(frame: NSRect(origin: .zero, size: panel.frame.size))
        body.autoresizingMask = [.width, .height]

        let background = NSVisualEffectView(frame: body.bounds)
        background.material = .popover
        background.blendingMode = .behindWindow
        background.state = .active
        background.autoresizingMask = [.width, .height]
        // Behind window blending ignores layer masks, so the material gets its own rounded mask.
        background.maskImage = Self.roundedMask(radius: NotesPanel.cornerRadius)

        let configuration = WKWebViewConfiguration()
        configuration.setURLSchemeHandler(schemeHandler, forURLScheme: EditorSchemeHandler.scheme)
        let contentController = WKUserContentController()
        configuration.userContentController = contentController
        configuration.suppressesIncrementalRendering = true

        let webView = NotesWebView(frame: body.bounds, configuration: configuration)
        webView.autoresizingMask = [.width, .height]
        // Let the material show through wherever the page is transparent.
        webView.setValue(false, forKey: "drawsBackground")
        webView.underPageBackgroundColor = .clear
        webView.allowsMagnification = false
        #if DEBUG
            webView.isInspectable = true
        #endif

        if let dispatcher {
            let bridge = WebBridge(dispatcher: dispatcher, webView: webView, logger: logger)
            if recordEvents {
                bridge.onMessage = { [weak self] method in self?.bridgeMethods.append(method) }
            }
            contentController.add(WeakScriptMessageHandler(bridge), name: WebBridge.handlerName)
            webView.navigationDelegate = bridge
            webView.uiDelegate = bridge
            self.bridge = bridge
        }

        let strip = DragStripView(
            frame: NSRect(
                x: 0, y: body.bounds.height - NotesPanel.dragStripHeight, width: body.bounds.width,
                height: NotesPanel.dragStripHeight))
        strip.autoresizingMask = [.width, .minYMargin]

        body.addSubview(background)
        body.addSubview(webView)
        body.addSubview(strip)
        panel.contentView = body
        self.webView = webView

        placePanel()
        if let url = URL(string: "\(EditorSchemeHandler.scheme)://app/index.html") {
            webView.load(URLRequest(url: url))
        }
    }

    /// A stretchable rounded rectangle used as the material's mask.
    private static func roundedMask(radius: CGFloat) -> NSImage {
        let edge = radius * 2 + 1
        let image = NSImage(size: NSSize(width: edge, height: edge), flipped: false) { rect in
            NSColor.black.setFill()
            NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius).fill()
            return true
        }
        image.capInsets = NSEdgeInsets(top: radius, left: radius, bottom: radius, right: radius)
        image.resizingMode = .stretch
        return image
    }

    private func applyWindowSettings() {
        // Our own optional setting, default off (spec/window.md 1.6).
        panel.sharingType = settings.hideWhileScreenSharing ? .none : .readOnly
        let zoom = CGFloat(settings.zoom)
        panel.minSize = NSSize(width: NotesPanel.minimumWidth, height: (Self.autoMinimumHeight * zoom).rounded())
    }

    // MARK: - Showing and hiding

    /// Shows the panel on the display under the pointer and makes it key, without activating
    /// the app. The web view becomes first responder so typing goes to the editor.
    func show() {
        let wasVisible = panel.isVisible
        if let frontmost = NSWorkspace.shared.frontmostApplication,
            frontmost.processIdentifier != ProcessInfo.processInfo.processIdentifier
        {
            previousApp = frontmost
        }
        if !wasVisible {
            placePanel()
        }
        panel.orderFrontRegardless()
        panel.makeKey()
        if let webView, panel.firstResponder !== webView {
            panel.makeFirstResponder(webView)
        }
        if !wasVisible {
            emitEvent("window.didShow", [:])
        }
    }

    /// Makes an already visible panel key without moving it.
    func focus() {
        panel.makeKey()
        if let webView, panel.firstResponder == nil || panel.firstResponder === panel {
            panel.makeFirstResponder(webView)
        }
    }

    func hide() {
        guard panel.isVisible else { return }
        saveFrameNow()
        panel.orderOut(nil)
        // We never activate on purpose, but a save sheet can; give focus back.
        if NSApp.isActive {
            returnFocusToPreviousApp()
        }
        emitEvent("window.didHide", [:])
    }

    func returnFocusToPreviousApp() {
        guard let previousApp, !previousApp.isTerminated else { return }
        NSApp.yieldActivation(to: previousApp)
        previousApp.activate()
    }

    // MARK: - Geometry

    private var screenUnderPointer: NSScreen? {
        let mouse = NSEvent.mouseLocation
        return NSScreen.screens.first { NSMouseInRect(mouse, $0.frame, false) } ?? NSScreen.main ?? NSScreen.screens.first
    }

    /// Places the panel on the display under the pointer: at that display's remembered top
    /// left point, else at the legacy last used point when it is on this display, else
    /// centered with its top just under the menu bar.
    private func placePanel() {
        guard let screen = screenUnderPointer else { return }
        let visible = screen.visibleFrame
        let width = CGFloat(settings.panelFrame?.width ?? Double(NotesPanel.defaultWidth))
        let height = targetHeight(on: screen)
        var topLeft = NSPoint(x: visible.midX - width / 2, y: visible.maxY)
        if let saved = settings.panelFrame?.displays[screen.positionKey] {
            topLeft = NSPoint(x: saved.x, y: saved.y)
        } else if let frame = settings.panelFrame, frame.displays.isEmpty,
            visible.contains(NSPoint(x: frame.x + 1, y: frame.y - 1))
        {
            topLeft = NSPoint(x: frame.x, y: frame.y)
        }
        let frame = NSRect(x: topLeft.x, y: topLeft.y - height, width: width, height: height)
        setFrame(keepOnScreen(frame, visible: visible))
    }

    /// The height the panel should have now, before keeping it on screen.
    private func targetHeight(on screen: NSScreen) -> CGFloat {
        let zoom = CGFloat(settings.zoom)
        var height: CGFloat
        if settings.windowAutoSize {
            let content = contentHeight ?? (panel.isVisible ? panel.frame.height : NotesPanel.defaultHeight)
            height = min(max(content, Self.autoMinimumHeight * zoom), Self.autoMaximumHeight * zoom)
        } else if let saved = settings.panelFrame?.height {
            height = CGFloat(saved)
        } else {
            height = panel.frame.height
        }
        return min(max(height, panel.minSize.height), screen.visibleFrame.height).rounded()
    }

    /// Clamps the width to the display and nudges the frame fully onto it, keeping the top
    /// edge where it was whenever the frame fits.
    private func keepOnScreen(_ frame: NSRect, visible: NSRect) -> NSRect {
        var result = frame
        result.size.width = min(max(frame.width, NotesPanel.minimumWidth), visible.width)
        result.size.height = min(frame.height, visible.height)
        result.origin.y = frame.maxY - result.height
        if result.maxY > visible.maxY { result.origin.y = visible.maxY - result.height }
        if result.minY < visible.minY { result.origin.y = visible.minY }
        if result.maxX > visible.maxX { result.origin.x = visible.maxX - result.width }
        if result.minX < visible.minX { result.origin.x = visible.minX }
        return result
    }

    private func setFrame(_ frame: NSRect) {
        guard frame != panel.frame else { return }
        // No animation: height steps land at once (spec/window.md 6.4).
        panel.setFrame(frame, display: panel.isVisible, animate: false)
        panel.invalidateShadow()
    }

    /// Applies the current target height with the top edge fixed.
    private func applyHeight(force: Bool = false) {
        guard !panel.inLiveResize, let screen = panel.screen ?? screenUnderPointer else { return }
        let height = targetHeight(on: screen)
        guard force || abs(height - panel.frame.height) > Self.heightTolerance else { return }
        var frame = panel.frame
        frame.origin.y = frame.maxY - height
        frame.size.height = height
        setFrame(keepOnScreen(frame, visible: screen.visibleFrame))
    }

    // MARK: - Remembering the frame

    private func scheduleFrameSave() {
        saveFrameWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated { self?.saveFrameNow() }
        }
        saveFrameWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3, execute: work)
    }

    /// Stores the top left point for the current display, the width, and (with auto-sizing
    /// off) the height.
    private func saveFrameNow() {
        saveFrameWork?.cancel()
        saveFrameWork = nil
        guard let screen = panel.screen else { return }
        let frame = panel.frame
        var saved = settings.panelFrame ?? PanelFrame(x: frame.minX, y: frame.maxY, width: frame.width)
        saved.x = frame.minX
        saved.y = frame.maxY
        saved.width = frame.width
        saved.height = settings.windowAutoSize ? nil : frame.height
        saved.displays[screen.positionKey] = PanelPoint(x: frame.minX, y: frame.maxY)
        guard saved != settings.panelFrame else { return }
        do {
            settings = try repository.setSettings(["panelFrame": saved.json])
        } catch {
            logger.log("Could not save the panel frame: \(error)")
        }
    }

    /// A user made height change turns auto-sizing off and keeps that height; a width only
    /// change leaves auto-sizing on (spec/window.md 5.6). Programmatic resizes never get here,
    /// because they do not run a live resize.
    func userDidResize(from start: NSRect, to end: NSRect) {
        if abs(end.height - start.height) > Self.heightTolerance && settings.windowAutoSize {
            var frame = settings.panelFrame ?? PanelFrame(x: end.minX, y: end.maxY, width: end.width)
            frame.height = end.height
            do {
                settings = try repository.setSettings(["windowAutoSize": false, "panelFrame": frame.json])
                emitEvent("settings.changed", settings.json)
            } catch {
                logger.log("Could not turn auto-sizing off: \(error)")
            }
        }
        saveFrameNow()
    }

    // MARK: - NSWindowDelegate

    func windowWillStartLiveResize(_ notification: Notification) {
        liveResizeStartFrame = panel.frame
    }

    func windowDidEndLiveResize(_ notification: Notification) {
        let start = liveResizeStartFrame ?? panel.frame
        liveResizeStartFrame = nil
        userDidResize(from: start, to: panel.frame)
    }

    func windowDidMove(_ notification: Notification) {
        if panel.isVisible { scheduleFrameSave() }
    }

    func windowDidChangeScreen(_ notification: Notification) {
        applyHeight()
    }

    func windowDidBecomeKey(_ notification: Notification) {
        emitEvent("window.didBecomeKey", [:])
    }

    func windowDidResignKey(_ notification: Notification) {
        emitEvent("window.didResignKey", [:])
    }

    // MARK: - Events

    private func emitEvent(_ event: String, _ payload: JSONValue) {
        if recordEvents {
            emittedEvents.append((event, payload))
        }
        bridge?.emit(event, payload)
    }

    // MARK: - HelperHost

    /// Hidden: show and focus. Visible but not key: focus only. Visible and key: hide.
    func toggleWindow() async -> Bool {
        if !panel.isVisible {
            show()
            return true
        }
        if !panel.isKeyWindow {
            focus()
            return true
        }
        hide()
        return false
    }

    func showWindow() async {
        if panel.isVisible { focus() } else { show() }
    }

    func hideWindow() async {
        hide()
    }

    /// Content driven height, including the editor's temporary growth while ⌘K, browse, or a
    /// dialog is open. Always programmatic: it never turns auto-sizing off. With auto-sizing
    /// off the user's height wins (and the editor stops reporting).
    func resizeWindow(contentHeight height: Double) async {
        if recordEvents { resizeReports.append(height) }
        contentHeight = CGFloat(height).rounded(.up)
        applyHeight()
    }

    func openURL(_ url: URL) async {
        NSWorkspace.shared.open(url)
    }

    func resignFocus() async {
        returnFocusToPreviousApp()
    }

    func copyToClipboard(text: String, html: String?) async {
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        var types: [NSPasteboard.PasteboardType] = [.string]
        if html != nil { types.append(.html) }
        pasteboard.declareTypes(types, owner: nil)
        pasteboard.setString(text, forType: .string)
        if let html {
            pasteboard.setString(html, forType: .html)
        }
    }

    func saveFile(suggestedName: String, content: String) async throws -> String? {
        let savePanel = NSSavePanel()
        savePanel.nameFieldStringValue = suggestedName
        savePanel.canCreateDirectories = true
        savePanel.isExtensionHidden = false
        let ext = (suggestedName as NSString).pathExtension
        if !ext.isEmpty, let type = UTType(filenameExtension: ext) {
            savePanel.allowedContentTypes = [type]
            savePanel.allowsOtherFileTypes = true
        }
        if !panel.isVisible {
            show()
        }
        let response: NSApplication.ModalResponse = await withCheckedContinuation { continuation in
            savePanel.beginSheetModal(for: panel) { continuation.resume(returning: $0) }
        }
        panel.makeKey()
        guard response == .OK, let url = savePanel.url else { return nil }
        do {
            try content.write(to: url, atomically: true, encoding: .utf8)
        } catch {
            throw RPCError.internal("Could not save \(url.path): \(error.localizedDescription)")
        }
        return url.path
    }

    func settingsDidChange(_ newSettings: Settings) async {
        let geometryChanged =
            newSettings.windowAutoSize != settings.windowAutoSize || newSettings.zoom != settings.zoom
            || newSettings.panelFrame?.height != settings.panelFrame?.height
        settings = newSettings
        applyWindowSettings()
        if geometryChanged {
            applyHeight(force: true)
        }
    }

    func emit(_ event: String, _ payload: JSONValue) async {
        emitEvent(event, payload)
    }

    func requestShutdown() async {
        onShutdown()
    }
}
