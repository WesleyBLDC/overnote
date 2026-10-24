import AppKit
import OvernoteCore
import UniformTypeIdentifiers
import WebKit

/// Owns the panel and its web view, implements `HelperHost` for the dispatcher, and carries
/// the window behavior: three way toggle, no activation, per display
/// position memory, content driven height with the top edge fixed, and the user height rule.
@MainActor
final class PanelController: NSObject, HelperHost, NSWindowDelegate {
    /// Height changes this small are ignored.
    static let heightTolerance: CGFloat = 2

    private let repository: NotesRepository
    private let logger: FileLogger
    private let onShutdown: @Sendable () -> Void
    private let schemeHandler: EditorSchemeHandler
    private var bridge: WebBridge?

    let panel: NotesPanel
    private var webView: NotesWebView?
    /// The editor's bars plus one line at the current zoom (`window.setMinimumSize`), nil until it reports.
    private var reportedMinimum: CGSize?
    /// The smallest the panel may be, for every way its size is set (`PanelSizing`).
    var minimumSize: CGSize { PanelSizing.minimumSize(reported: reportedMinimum) }
    /// The app that was frontmost when the panel was shown; focus returns to it.
    private var previousApp: NSRunningApplication?
    private(set) var settings: Settings
    /// The latest content height the editor reported, nil until the first report.
    private var contentHeight: CGFloat?
    /// A temporary height (⌘K, browse, dialogs) that wins until the next normal report.
    private var temporaryHeight: CGFloat?
    /// The height before a temporary growth, restored when no user height is stored.
    private var heightBeforeTemporary: CGFloat?
    private var saveFrameWork: DispatchWorkItem?
    /// True while the helper itself sets the frame, so the window delegate can tell its own
    /// changes from the system's (tiling, a window manager).
    private var applyingFrame = false
    /// The frame as of the last move or resize, the start of the next outside resize.
    private var lastFrame: NSRect = .zero
    /// The frame when a system live resize (the window edge) began.
    private var liveResizeStart: NSRect?
    /// Set when the person moved or resized the panel since the last save, so that save drops
    /// the display's stored `window.place` placement while keeping the frame.
    /// Stays set when a save finds no display (`placementClearOnSave`), so a nil screen cannot
    /// consume it.
    private var clearsPlacementOnSave = false
    /// Set when the screen configuration changed, until the save that follows. That save keeps
    /// the destination display's placement: the system moved the panel, the person did not.
    private var screenConfigurationChanged = false
    /// The display the panel was on before the latest screen change, so an unplug can be told
    /// from a drag onto a display that is still connected.
    private var lastScreenKey: String?
    /// Every event sent to the editor, kept only when test hooks are on.
    private(set) var emittedEvents: [(String, JSONValue)] = []
    /// Bridge methods the editor called and heights it reported, kept only with test hooks.
    private(set) var bridgeMethods: [String] = []
    private(set) var resizeReports: [Double] = []
    /// The panel height at each order in, kept only with test hooks.
    private(set) var shownHeights: [Double] = []
    private let recordEvents: Bool
    /// A show that waits for the editor's first height report while auto-sizing is on, so a
    /// cold start never flashes the default height before shrinking to the content.
    private var pendingShow: DispatchWorkItem?
    /// How long a show waits for that first report before it orders the panel in anyway.
    static let firstReportTimeout: TimeInterval = 3
    /// Whether a show is waiting for the editor's first height report.
    var isShowPending: Bool { pendingShow != nil }
    /// Development only (`--watch-editor`): reloads the page when a new editor build lands.
    private var buildWatcher: EditorBuildWatcher?
    /// Reloads the page itself when the editor did not reload after `editor.willReload`.
    private var reloadFallback: DispatchWorkItem?
    /// How long the editor gets to save and reload on its own.
    static let reloadFallbackDelay: TimeInterval = 2

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
        NotificationCenter.default.addObserver(
            self, selector: #selector(screenParametersChanged),
            name: NSApplication.didChangeScreenParametersNotification, object: nil)
    }

    // MARK: - Setup

    /// Builds the body, the web view, and the bridge, and starts loading the editor while the
    /// panel stays hidden, so the first show only orders it in.
    func prewarm(dispatcher: RPCDispatcher?) {
        let body = PanelBodyView(frame: NSRect(origin: .zero, size: panel.frame.size))
        body.autoresizingMask = [.width, .height]

        let background = NSVisualEffectView(frame: body.bounds)
        // A dark, dense material: under the editor's darker tint it reads as solid dark glass.
        background.material = Self.material
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

        // Resize zones go on top of everything; they claim only edge and corner events.
        let overlay = ResizeOverlayView(frame: body.bounds)
        overlay.autoresizingMask = [.width, .height]
        webView.resizeOverlay = overlay
        panel.resizeOverlay = overlay

        body.addSubview(background)
        body.addSubview(webView)
        body.addSubview(strip)
        body.addSubview(overlay)
        panel.contentView = body
        self.webView = webView
        panel.onUserResize = { [weak self] start, end in self?.userDidResize(from: start, to: end) }
        panel.onClose = { [weak self] in self?.hide() }

        placePanel()
        lastFrame = panel.frame
        if let url = URL(string: "\(EditorSchemeHandler.scheme)://app/index.html") {
            webView.load(URLRequest(url: url))
        }
    }

    /// Development only: watches `directory` for new editor builds and reloads the page on each.
    func watchEditorBuild(directory: String) {
        let watcher = EditorBuildWatcher(directory: directory) { [weak self] in self?.reloadEditor() }
        watcher.start()
        buildWatcher = watcher
        bridge?.onPageNavigation = { [weak self] in
            self?.reloadFallback?.cancel()
            self?.reloadFallback = nil
        }
        logger.log("Watching \(directory) for new editor builds")
    }

    /// Asks the editor to save and reload itself, and reloads it after a moment if it cannot
    /// (for example when the previous build failed to start).
    private func reloadEditor() {
        logger.log("New editor build; reloading the editor")
        reloadFallback?.cancel()
        let fallback = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.reloadFallback = nil
            self.logger.log("The editor did not reload itself; reloading it")
            self.webView?.reload()
        }
        reloadFallback = fallback
        emitEvent("editor.willReload", [:])
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.reloadFallbackDelay, execute: fallback)
    }

    static let material: NSVisualEffectView.Material = .hudWindow

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
        // Our own optional setting, default off.
        panel.sharingType = settings.hideWhileScreenSharing ? .none : .readOnly
        panel.minSize = minimumSize
    }

    // MARK: - Showing and hiding

    /// Shows the panel on the display under the pointer and makes it key, without activating
    /// the app. The web view becomes first responder so typing goes to the editor.
    /// With auto-sizing on and no height report from the editor yet (a cold start), the panel
    /// waits for that report, up to `firstReportTimeout`, so it opens at its content height.
    /// The editor measures in a ResizeObserver, so it reports while the panel is still hidden.
    func show() {
        if let frontmost = NSWorkspace.shared.frontmostApplication,
            frontmost.processIdentifier != ProcessInfo.processInfo.processIdentifier
        {
            previousApp = frontmost
        }
        if !panel.isVisible, settings.windowAutoSize, contentHeight == nil, temporaryHeight == nil, webView != nil {
            guard pendingShow == nil else { return }
            let work = DispatchWorkItem { [weak self] in
                MainActor.assumeIsolated { self?.completePendingShow() }
            }
            pendingShow = work
            DispatchQueue.main.asyncAfter(deadline: .now() + Self.firstReportTimeout, execute: work)
            return
        }
        present()
    }

    /// The first report never came in time (a slow first load, or a page that does not report):
    /// show at the default height rather than not at all.
    private func completePendingShow() {
        guard pendingShow != nil else { return }
        pendingShow = nil
        logger.log("No height report from the editor within \(Self.firstReportTimeout) s; showing the panel anyway")
        present()
    }

    private func cancelPendingShow() {
        pendingShow?.cancel()
        pendingShow = nil
    }

    /// Orders the panel in at its target height and makes it key; ends any pending show.
    private func present() {
        let wasVisible = panel.isVisible
        cancelPendingShow()
        if !wasVisible {
            placePanel()
        }
        makeVisible(wasAlready: wasVisible)
    }

    /// Orders the panel in and makes it key without moving it. `wasAlready` skips a second
    /// `window.didShow` when the panel was already on screen.
    private func makeVisible(wasAlready: Bool) {
        if !wasAlready {
            // A system relocation while hidden produced no save to keep the destination
            // placement through, and ordering in re-places the panel from what is stored.
            // The relocation is spent here, so a later drag still clears that placement.
            screenConfigurationChanged = false
        }
        panel.orderFrontRegardless()
        panel.makeKey()
        if let webView, panel.firstResponder !== webView {
            panel.makeFirstResponder(webView)
        }
        if !wasAlready {
            if recordEvents { shownHeights.append(Double(panel.frame.height)) }
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
        cancelPendingShow()
        guard panel.isVisible else { return }
        saveFrameNow()
        panel.orderOut(nil)
        // We never activate on purpose, but a save sheet can; give focus back.
        if NSApp.isActive {
            returnFocusToPreviousApp()
        }
        emitEvent("window.didHide", [:])
    }

    /// Close Window (⌘W): the same hide path as Esc and the editor's Close control; the editor
    /// flushes pending edits when it receives `window.didHide`.
    @objc func closeWindow(_ sender: Any?) {
        hide()
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

    /// Places the panel on the display under the pointer. A placement stored for that display
    /// (`window.place`, matched by display uuid when its resolution changed) runs again against
    /// the display's current visible frame; otherwise the panel opens at that display's
    /// remembered top left point, else at the legacy last used point when it is on this
    /// display, else centered with its top just under the menu bar.
    private func placePanel() {
        guard let screen = screenUnderPointer else { return }
        let width = CGFloat(settings.panelFrame?.width ?? Double(NotesPanel.defaultWidth))
        let key = screen.positionKey
        if let placement = PanelGeometry.storedPlacement(in: settings.panelFrame, displayKey: key) {
            let frame = PanelGeometry.placed(
                placement, current: CGSize(width: width, height: targetHeight(on: screen)), visible: screen.visibleFrame,
                minimum: minimumSize)
            setFrame(frame)
            storePlacement(placement, frame: frame, displayKey: key, patch: [:])
            return
        }
        setFrame(
            PanelGeometry.placement(
                stored: settings.panelFrame, displayKey: screen.positionKey, visible: screen.visibleFrame, width: width,
                height: targetHeight(on: screen), minimum: minimumSize))
    }

    /// The first open frame: the default size, centered at the top of the display under the pointer.
    private func restoreDefaultFrame() {
        guard let screen = panel.screen ?? screenUnderPointer else { return }
        let visible = screen.visibleFrame
        let height = settings.windowAutoSize ? targetHeight(on: screen) : NotesPanel.defaultHeight
        let frame = NSRect(
            x: visible.midX - NotesPanel.defaultWidth / 2, y: visible.maxY - height, width: NotesPanel.defaultWidth,
            height: height)
        setFrame(keepOnScreen(frame, visible: visible))
    }

    /// The height the panel should have now, before keeping it on screen.
    private func targetHeight(on screen: NSScreen) -> CGFloat {
        let minimum = minimumSize.height
        var height: CGFloat
        if let temporaryHeight {
            height = PanelSizing.autoHeight(temporaryHeight, minimum: minimum, zoom: settings.zoom)
        } else if settings.windowAutoSize {
            let content = contentHeight ?? (panel.isVisible ? panel.frame.height : NotesPanel.defaultHeight)
            height = PanelSizing.autoHeight(content, minimum: minimum, zoom: settings.zoom)
        } else if let saved = settings.panelFrame?.height {
            height = CGFloat(saved)
        } else {
            // No stored height yet: the first open size, or whatever the panel had before a
            // temporary growth.
            height = heightBeforeTemporary ?? panel.frame.height
        }
        return min(max(height, minimum), screen.visibleFrame.height).rounded()
    }

    /// Grows the frame to the minimum size, clamps it to the display, and nudges it fully onto
    /// it, keeping the top edge where it was whenever the frame fits.
    private func keepOnScreen(_ frame: NSRect, visible: NSRect) -> NSRect {
        PanelGeometry.keepOnScreen(frame, visible: visible, minimum: minimumSize)
    }

    /// Every frame change the helper makes goes through here, so the window delegate never
    /// mistakes one for the system or a window manager placing the panel.
    private func setFrame(_ frame: NSRect) {
        guard frame != panel.frame else { return }
        applyingFrame = true
        defer { applyingFrame = false }
        // No animation: height steps land at once.
        panel.setFrame(frame, display: panel.isVisible, animate: false)
        panel.invalidateShadow()
        lastFrame = panel.frame
        if let key = panel.screen?.positionKey { lastScreenKey = key }
    }

    /// Applies the current target height with the top edge fixed.
    private func applyHeight(force: Bool = false) {
        guard !panel.isUserResizing, !panel.inLiveResize, let screen = panel.screen ?? screenUnderPointer else { return }
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
    /// off) the height. The display's stored placement stays unless the person moved or resized
    /// the panel since the last save (`clearsPlacementOnSave`).
    private func saveFrameNow() {
        saveFrameWork?.cancel()
        saveFrameWork = nil
        let decision = PanelGeometry.placementClearOnSave(
            clearRequested: clearsPlacementOnSave, systemRelocation: screenConfigurationChanged,
            hasDisplay: panel.screen != nil)
        clearsPlacementOnSave = decision.clearRequested
        screenConfigurationChanged = decision.systemRelocation
        guard let screen = panel.screen else { return }
        let saved = PanelGeometry.recording(
            panel.frame, displayKey: screen.positionKey, in: settings.panelFrame, autoSize: settings.windowAutoSize,
            temporary: temporaryHeight != nil, keepsPlacement: decision.keepsPlacement)
        guard saved != settings.panelFrame else { return }
        do {
            settings = try repository.setSettings(["panelFrame": saved.json])
        } catch {
            logger.log("Could not save the panel frame: \(error)")
        }
    }

    /// Keeps the current frame and drops the stored placement for the panel's display.
    private func clearPlacement() {
        clearsPlacementOnSave = true
        saveFrameNow()
    }

    /// Stores `placement` at `frame` for `displayKey`, plus any other settings in `patch`, so
    /// the next open on that display runs it again.
    private func storePlacement(
        _ placement: PanelPlacement, frame: NSRect, displayKey: String, patch: [String: JSONValue]
    ) {
        let autoSize = patch["windowAutoSize"]?.boolValue ?? settings.windowAutoSize
        let saved = PanelGeometry.placing(
            placement, frame: frame, displayKey: displayKey, in: settings.panelFrame, autoSize: autoSize,
            temporary: temporaryHeight != nil)
        guard saved != settings.panelFrame || !patch.isEmpty else { return }
        var values = patch
        values["panelFrame"] = saved.json
        do {
            settings = try repository.setSettings(values)
        } catch {
            logger.log("Could not save the panel placement: \(error)")
        }
    }

    /// A user made height change turns auto-sizing off and keeps that height; a width only
    /// change leaves auto-sizing on. Called at the end of a drag in the resize zones or along
    /// the window edge, and for any frame the system or a window manager sets (tiling or
    /// Accessibility); the helper's own resizes never get here.
    func userDidResize(from start: NSRect, to end: NSRect) {
        let heightChanged = PanelGeometry.changesHeight(from: start, to: end, tolerance: Self.heightTolerance)
        lastFrame = end
        if heightChanged {
            // The user's height wins over a temporary growth that was in effect.
            temporaryHeight = nil
            heightBeforeTemporary = nil
        }
        if heightChanged && settings.windowAutoSize {
            var frame = settings.panelFrame ?? PanelFrame(x: end.minX, y: end.maxY, width: end.width)
            frame.height = end.height
            do {
                settings = try repository.setSettings(["windowAutoSize": false, "panelFrame": frame.json])
                emitEvent("settings.changed", settings.json)
            } catch {
                logger.log("Could not turn auto-sizing off: \(error)")
            }
        }
        clearPlacement()
    }

    // MARK: - NSWindowDelegate

    /// A move the helper did not make (a drag, or the system moving the panel) clears the
    /// display's stored placement at the next save. The helper's own moves go through `setFrame`,
    /// which updates `lastFrame`, so even a late notification for one is not mistaken for a drag.
    func windowDidMove(_ notification: Notification) {
        if !applyingFrame, panel.isVisible, panel.frame.origin != lastFrame.origin { clearsPlacementOnSave = true }
        if !panel.isUserResizing, !panel.inLiveResize { lastFrame = panel.frame }
        if panel.isVisible { scheduleFrameSave() }
    }

    /// A resize the helper did not make and that is not a live resize: system tiling or a
    /// window manager setting the frame through Accessibility. The panel keeps that frame as
    /// the person's own resize, grown to the minimum size first if it is smaller (a frame set
    /// from outside skips the window's `minSize`). A frame at least the minimum stays exactly.
    func windowDidResize(_ notification: Notification) {
        guard !applyingFrame, !panel.isUserResizing, !panel.inLiveResize else { return }
        let start = lastFrame
        lastFrame = panel.frame
        guard panel.isVisible, start != .zero else { return }
        let minimum = minimumSize
        if panel.frame.width < minimum.width || panel.frame.height < minimum.height,
            let screen = panel.screen ?? screenUnderPointer
        {
            setFrame(keepOnScreen(panel.frame, visible: screen.visibleFrame))
        }
        userDidResize(from: start, to: panel.frame)
    }

    func windowWillStartLiveResize(_ notification: Notification) {
        liveResizeStart = panel.frame
    }

    /// The end of a resize along the window edge (the system's live resize), the same as one
    /// in the resize zones.
    func windowDidEndLiveResize(_ notification: Notification) {
        let start = liveResizeStart ?? lastFrame
        liveResizeStart = nil
        lastFrame = panel.frame
        panel.invalidateShadow()
        userDidResize(from: start, to: panel.frame)
    }

    func windowDidChangeScreen(_ notification: Notification) {
        let connected = NSScreen.screens.map(\.positionKey)
        let current = panel.screen?.positionKey
        if let previous = lastScreenKey, let current, !PanelGeometry.sameDisplay(previous, current),
            !connected.contains(where: { PanelGeometry.sameDisplay($0, previous) })
        {
            // The display we left is gone. Clear its placement, and keep the one we landed on.
            noteScreenConfiguration(connectedKeys: connected, relocated: true)
        }
        if let current { lastScreenKey = current }
        applyHeight()
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
    /// A toggle while a show waits for the first height report cancels that show, as a second
    /// press on a visible panel would hide it.
    func toggleWindow() async -> Bool {
        if pendingShow != nil {
            cancelPendingShow()
            return false
        }
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

    /// `window.place`: on the panel's display while it is visible, else on the display under the
    /// pointer. A hidden panel stays hidden, except a show that is waiting for its first height
    /// report: placing completes that show at the placed frame. Left, right, and fill end any
    /// temporary growth and turn auto-sizing off, since they set the height; center keeps the
    /// size and never touches auto-sizing. The placement is stored for that display and runs
    /// again when the panel opens there.
    func placeWindow(_ placement: PanelPlacement) async -> CGRect {
        guard let screen = (panel.isVisible ? panel.screen : nil) ?? screenUnderPointer else { return panel.frame }
        // A drag just before the placement must not clear it at the next save.
        saveFrameWork?.cancel()
        saveFrameWork = nil
        clearsPlacementOnSave = false
        if placement.setsSize {
            temporaryHeight = nil
            heightBeforeTemporary = nil
        }
        let current = panel.isVisible ? panel.frame.size : CGSize(width: panel.frame.width, height: targetHeight(on: screen))
        let frame = PanelGeometry.placed(placement, current: current, visible: screen.visibleFrame, minimum: minimumSize)
        setFrame(frame)
        storePlacement(
            placement, frame: frame, displayKey: screen.positionKey,
            patch: placement.setsSize ? ["windowAutoSize": false] : [:])
        if pendingShow != nil {
            // show, then place (the menu bar): the waiting show opens at this frame.
            let wasVisible = panel.isVisible
            cancelPendingShow()
            makeVisible(wasAlready: wasVisible)
        }
        emitEvent("settings.changed", settings.json)
        return frame
    }

    /// Content driven height. Always programmatic: it never turns auto-sizing off.
    /// A temporary report grows the panel even with auto-sizing off; the next normal report
    /// clears it, which restores the content height (auto-sizing on) or the user's stored
    /// height (auto-sizing off).
    func resizeWindow(contentHeight height: Double, temporary: Bool) async {
        if recordEvents { resizeReports.append(height) }
        let rounded = CGFloat(height).rounded(.up)
        if temporary {
            // Temporary growth only grows: a panel that is already tall enough stays as it is,
            // and so does an earlier, taller temporary growth.
            let wanted = PanelSizing.autoHeight(rounded, minimum: minimumSize.height, zoom: settings.zoom)
            guard panel.frame.height < wanted.rounded() - Self.heightTolerance else { return }
            if temporaryHeight == nil { heightBeforeTemporary = panel.frame.height }
            temporaryHeight = wanted
            applyHeight(force: true)
        } else {
            let wasTemporary = temporaryHeight != nil
            temporaryHeight = nil
            contentHeight = rounded
            if pendingShow != nil {
                // The report a waiting show was for: order the panel in, placed at this height.
                heightBeforeTemporary = nil
                present()
                return
            }
            // Restoring after a temporary growth still needs the height from before it.
            applyHeight(force: wasTemporary)
            heightBeforeTemporary = nil
        }
    }

    /// A new minimum from the editor (its bars or the zoom changed): a smaller panel grows to it,
    /// keeping its top edge. The growth goes through `setFrame`, so it is the helper's own frame
    /// change and never reads as the person's resize.
    func setMinimumSize(width: Double, height: Double) async {
        let reported = CGSize(width: width, height: height)
        guard reported != reportedMinimum else { return }
        reportedMinimum = reported
        panel.minSize = minimumSize
        if panel.frame.width < minimumSize.width || panel.frame.height < minimumSize.height {
            applyHeight(force: true)
        }
    }

    func setDragRegions(_ rects: [DragRect]) async {
        webView?.dragRects = rects.map { NSRect(x: $0.x, y: $0.y, width: $0.width, height: $0.height) }
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
            // A sheet needs a visible window: never wait for a height report here.
            present()
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
        // settings.reset forgets the frame: the panel goes back to its first open size and place.
        let frameForgotten = newSettings.panelFrame == nil && settings.panelFrame != nil
        let autoSizeTurnedOn = newSettings.windowAutoSize && !settings.windowAutoSize
        settings = newSettings
        applyWindowSettings()
        if frameForgotten {
            temporaryHeight = nil
            heightBeforeTemporary = nil
            restoreDefaultFrame()
            return
        }
        if pendingShow != nil, !settings.windowAutoSize {
            // Auto-sizing went off while a show waited for a height report: nothing to wait for.
            present()
            return
        }
        if geometryChanged {
            applyHeight(force: true)
        }
        if autoSizeTurnedOn, let cleared = PanelGeometry.clearingAllPlacements(in: settings.panelFrame),
            cleared != settings.panelFrame
        {
            // Auto-sizing owns the height on every display, so every stored placement goes,
            // not only the display the panel is on now. A nil screen must not skip the others.
            do {
                settings = try repository.setSettings(["panelFrame": cleared.json])
            } catch {
                logger.log("Could not clear placements after turning auto-sizing on: \(error)")
            }
        }
    }

    /// Screens were plugged, unplugged, or resized. Placements for displays that are gone are
    /// cleared here. The destination display's placement is kept only when the panel itself
    /// left a display that is no longer connected (`windowDidChangeScreen`).
    @objc private func screenParametersChanged() {
        noteScreenConfiguration(connectedKeys: NSScreen.screens.map(\.positionKey), relocated: false)
    }

    /// `connectedKeys` are the displays still attached (`"<uuid>@<w>x<h>"`). Test hooks pass the
    /// same shape the screen notification does, so the clear runs without unplugging a display.
    /// `relocated` marks the following save as the system's move onto the display that remains.
    func noteScreenConfiguration(connectedKeys: [String], relocated: Bool) {
        if relocated { screenConfigurationChanged = true }
        guard let cleared = PanelGeometry.clearingDisconnected(in: settings.panelFrame, connectedKeys: connectedKeys),
            cleared != settings.panelFrame
        else { return }
        do {
            settings = try repository.setSettings(["panelFrame": cleared.json])
        } catch {
            logger.log("Could not clear a disconnected display's placement: \(error)")
        }
    }

    func emit(_ event: String, _ payload: JSONValue) async {
        emitEvent(event, payload)
    }

    func requestShutdown() async {
        onShutdown()
    }
}
