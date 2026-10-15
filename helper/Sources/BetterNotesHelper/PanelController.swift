import AppKit
import BetterNotesCore
import UniformTypeIdentifiers
import WebKit

/// Owns the panel and its web view, and implements `HelperHost` for the dispatcher.
@MainActor
final class PanelController: NSObject, HelperHost, NSWindowDelegate {
    private let repository: NotesRepository
    private let logger: FileLogger
    private let onShutdown: @Sendable () -> Void
    private let schemeHandler: EditorSchemeHandler
    private var bridge: WebBridge?

    private(set) var panel: NotesPanel
    private var webView: WKWebView?
    /// The app that was frontmost when the panel was shown; focus returns to it.
    private var previousApp: NSRunningApplication?
    private var settings: Settings
    /// The latest height the editor asked for, reapplied on show and screen changes.
    private var contentHeight: CGFloat = NotesPanel.defaultHeight
    private var saveFrameWork: DispatchWorkItem?

    init(
        repository: NotesRepository, editorDirectory: String?, logger: FileLogger,
        onShutdown: @escaping @Sendable () -> Void
    ) {
        self.repository = repository
        self.logger = logger
        self.onShutdown = onShutdown
        self.schemeHandler = EditorSchemeHandler(editorDirectory: editorDirectory, logger: logger)
        self.settings = (try? repository.settings()) ?? .defaults
        self.panel = NotesPanel(
            contentRect: NSRect(x: 0, y: 0, width: NotesPanel.defaultWidth, height: NotesPanel.defaultHeight))
        super.init()
        panel.delegate = self
        applyWindowSettings()
    }

    // MARK: - Setup

    /// Builds the visual effect background, the web view, and the bridge, and starts loading
    /// the editor while the panel stays hidden.
    func prewarm(dispatcher: RPCDispatcher?) {
        let background = NSVisualEffectView()
        background.material = .popover
        background.blendingMode = .behindWindow
        background.state = .active
        background.autoresizingMask = [.width, .height]

        let configuration = WKWebViewConfiguration()
        configuration.setURLSchemeHandler(schemeHandler, forURLScheme: EditorSchemeHandler.scheme)
        let contentController = WKUserContentController()
        configuration.userContentController = contentController
        configuration.suppressesIncrementalRendering = true

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.autoresizingMask = [.width, .height]
        // Let the visual effect view show through wherever the page is transparent.
        webView.setValue(false, forKey: "drawsBackground")
        webView.underPageBackgroundColor = .clear
        webView.allowsMagnification = false
        #if DEBUG
            webView.isInspectable = true
        #endif

        if let dispatcher {
            let bridge = WebBridge(dispatcher: dispatcher, webView: webView, logger: logger)
            contentController.add(WeakScriptMessageHandler(bridge), name: WebBridge.handlerName)
            webView.navigationDelegate = bridge
            webView.uiDelegate = bridge
            self.bridge = bridge
        }

        let container = NSView()
        container.autoresizingMask = [.width, .height]
        panel.contentView = container
        background.frame = container.bounds
        webView.frame = container.bounds
        container.addSubview(background)
        container.addSubview(webView)

        let strip = DragStripView(
            frame: NSRect(
                x: 0, y: container.bounds.height - NotesPanel.dragStripHeight, width: container.bounds.width,
                height: NotesPanel.dragStripHeight))
        strip.autoresizingMask = [.width, .minYMargin]
        container.addSubview(strip)

        self.webView = webView
        placePanel()
        if let url = URL(string: "\(EditorSchemeHandler.scheme)://app/index.html") {
            webView.load(URLRequest(url: url))
        }
    }

    private func applyWindowSettings() {
        panel.sharingType = settings.hideWhileScreenSharing ? .none : .readOnly
    }

    // MARK: - Showing and hiding

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
        if let webView {
            panel.makeFirstResponder(webView)
        }
        if !wasVisible {
            bridge?.emit("window.didShow", [:])
        }
    }

    func hide() {
        guard panel.isVisible else { return }
        panel.orderOut(nil)
        // We never activate on purpose, but a save sheet or the inspector can; give focus back.
        if NSApp.isActive {
            returnFocusToPreviousApp()
        }
        bridge?.emit("window.didHide", [:])
    }

    private func returnFocusToPreviousApp() {
        guard let previousApp, !previousApp.isTerminated else { return }
        NSApp.yieldActivation(to: previousApp)
        previousApp.activate()
    }

    // MARK: - Geometry

    private var activeScreen: NSScreen? {
        let mouse = NSEvent.mouseLocation
        return NSScreen.screens.first { NSMouseInRect(mouse, $0.frame, false) } ?? NSScreen.main ?? NSScreen.screens.first
    }

    /// Positions the panel from the saved frame when it is still on a screen, otherwise
    /// centered near the top of the screen under the mouse.
    private func placePanel() {
        let height = currentTargetHeight()
        if let saved = settings.panelFrame {
            let frame = NSRect(x: saved.x, y: saved.y - height, width: saved.width, height: height)
            if let screen = NSScreen.screens.first(where: { $0.visibleFrame.intersects(frame) }) {
                panel.setFrame(clamp(frame, to: screen), display: false)
                return
            }
        }
        guard let screen = activeScreen else { return }
        let visible = screen.visibleFrame
        let width = min(NotesPanel.defaultWidth, visible.width)
        let top = visible.maxY - visible.height * 0.18
        let frame = NSRect(x: visible.midX - width / 2, y: top - height, width: width, height: height)
        panel.setFrame(clamp(frame, to: screen), display: false)
    }

    private func currentTargetHeight() -> CGFloat {
        if !settings.windowAutoSize, let saved = settings.panelFrame?.height {
            return CGFloat(saved)
        }
        return contentHeight
    }

    /// Clamps the height between the minimum and 70% of the visible screen height, keeps the
    /// width within the screen, and keeps the frame on screen.
    private func clamp(_ frame: NSRect, to screen: NSScreen) -> NSRect {
        let visible = screen.visibleFrame
        var result = frame
        result.size.width = min(max(frame.width, NotesPanel.minimumWidth), visible.width)
        let maxHeight = max(NotesPanel.minimumHeight, (visible.height * 0.7).rounded(.down))
        result.size.height = min(max(frame.height, NotesPanel.minimumHeight), maxHeight)
        // Keep the top edge where it was, then nudge the whole frame onto the screen.
        result.origin.y = frame.maxY - result.height
        if result.maxY > visible.maxY { result.origin.y = visible.maxY - result.height }
        if result.minY < visible.minY { result.origin.y = visible.minY }
        if result.maxX > visible.maxX { result.origin.x = visible.maxX - result.width }
        if result.minX < visible.minX { result.origin.x = visible.minX }
        return result
    }

    private func applyContentHeight() {
        guard settings.windowAutoSize, let screen = panel.screen ?? activeScreen else { return }
        var frame = panel.frame
        let top = frame.maxY
        frame.size.height = contentHeight
        frame.origin.y = top - contentHeight
        let clamped = clamp(frame, to: screen)
        if clamped != panel.frame {
            panel.setFrame(clamped, display: true, animate: false)
        }
    }

    private func scheduleFrameSave() {
        saveFrameWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated { self?.saveFrame() }
        }
        saveFrameWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3, execute: work)
    }

    private func saveFrame() {
        let frame = panel.frame
        let saved = PanelFrame(
            x: frame.minX, y: frame.maxY, width: frame.width,
            height: settings.windowAutoSize ? nil : frame.height)
        guard saved != settings.panelFrame else { return }
        do {
            settings = try repository.setSettings(["panelFrame": saved.json])
        } catch {
            logger.log("Could not save the panel frame: \(error)")
        }
    }

    // MARK: - NSWindowDelegate

    func windowWillResize(_ sender: NSWindow, to frameSize: NSSize) -> NSSize {
        // With automatic sizing the height belongs to the content; the user drags the width.
        settings.windowAutoSize ? NSSize(width: frameSize.width, height: sender.frame.height) : frameSize
    }

    func windowDidMove(_ notification: Notification) {
        if panel.isVisible { scheduleFrameSave() }
    }

    func windowDidEndLiveResize(_ notification: Notification) {
        scheduleFrameSave()
    }

    func windowDidChangeScreen(_ notification: Notification) {
        applyContentHeight()
    }

    func windowDidBecomeKey(_ notification: Notification) {
        bridge?.emit("window.didBecomeKey", [:])
    }

    func windowDidResignKey(_ notification: Notification) {
        bridge?.emit("window.didResignKey", [:])
    }

    // MARK: - HelperHost

    func toggleWindow() async -> Bool {
        if panel.isVisible && panel.isKeyWindow {
            hide()
            return false
        }
        show()
        return true
    }

    func showWindow() async {
        show()
    }

    func hideWindow() async {
        hide()
    }

    func resizeWindow(contentHeight height: Double) async {
        contentHeight = CGFloat(height).rounded(.up)
        applyContentHeight()
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
        let autoSizeTurnedOn = newSettings.windowAutoSize && !settings.windowAutoSize
        settings = newSettings
        applyWindowSettings()
        if autoSizeTurnedOn {
            applyContentHeight()
        }
    }

    func emit(_ event: String, _ payload: JSONValue) async {
        bridge?.emit(event, payload)
    }

    func requestShutdown() async {
        onShutdown()
    }
}
