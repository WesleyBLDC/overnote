import AppKit
import OvernoteCore
import UniformTypeIdentifiers
import WebKit

/// Owns the panel and its web view, implements `HelperHost` for the dispatcher, and carries
/// the window behavior: three way toggle, no activation, per display
/// position memory, content driven height with the top edge fixed, and the user height rule.
@MainActor
final class PanelController: NSObject, HelperHost, NSWindowDelegate {
    /// Auto-height limits at 100% zoom; both scale with zoom.
    static let autoMinimumHeight: CGFloat = 128
    static let autoMaximumHeight: CGFloat = 860
    /// Height changes this small are ignored.
    static let heightTolerance: CGFloat = 2

    private let repository: NotesRepository
    private let logger: FileLogger
    private let onShutdown: @Sendable () -> Void
    private let schemeHandler: EditorSchemeHandler
    private var bridge: WebBridge?

    let panel: NotesPanel
    private var webView: NotesWebView?
    private var bodyView: PanelBodyView?
    /// Points of window below the note while a dropdown hangs past its bottom edge (`window.setOverhang`).
    private(set) var overhang: CGFloat = 0
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
    /// The window frame this controller last set itself, in AppKit global coordinates
    /// (bottom left origin, y up). Every controller frame change goes through `setFrame`,
    /// which records its target here before touching the window, so a frame the window
    /// reports later can be told apart from a controller frame: if the reported frame
    /// differs from this one by more than the tolerance, somebody else moved or resized
    /// the panel. Direct `panel.setFrame` calls (the resize overlay, test hooks, and
    /// Accessibility clients) deliberately bypass this record.
    private(set) var expectedFrame: NSRect?
    /// How the most recent external frame change was classified, for test hooks. Only a
    /// change beyond tolerance replaces it, so a no-op external set leaves it alone.
    private(set) var lastAdoptionClassification: ExternalFrameChange?
    /// When the most recent external adoption landed, so a screen change that arrives
    /// with it (within a second) does not reapply the content height over it.
    private var lastExternalAdoptionAt: TimeInterval = 0
    /// Panel drag starts reported by `NotesPanel.onUserMove`. The placement work in
    /// ticket T4 consumes this; nothing here acts on it beyond counting.
    private(set) var panelDragMoveCount = 0
    private var userMovePendingPlacement = false
    /// True between a panel drag start and its end, so those moves are not read as
    /// external adoptions; the usual debounced save remembers their point.
    private var panelDragInProgress = false
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
    }

    // MARK: - Setup

    /// Builds the body, the web view, and the bridge, and starts loading the editor while the
    /// panel stays hidden, so the first show only orders it in.
    func prewarm(dispatcher: RPCDispatcher?) {
        let body = PanelBodyView(frame: NSRect(origin: .zero, size: panel.frame.size))
        body.autoresizingMask = [.width, .height]
        bodyView = body

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

        body.addSubview(background)
        body.addSubview(webView)
        body.addSubview(strip)
        body.addSubview(overlay)
        body.background = background
        body.resizeOverlay = overlay
        panel.contentView = body
        self.webView = webView
        panel.onUserResize = { [weak self] start, end in self?.userDidResize(from: start, to: end) }
        panel.onUserMove = { [weak self] in self?.userDidBeginPanelDrag() }
        panel.onUserMoveEnded = { [weak self] in self?.userDidEndPanelDrag() }
        panel.onClose = { [weak self] in self?.hide() }

        placePanel()
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
        let zoom = CGFloat(settings.zoom)
        panel.minSize = NSSize(
            width: (NotesPanel.minimumWidth * zoom).rounded(), height: (Self.autoMinimumHeight * zoom).rounded())
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
        cancelPendingShow()
        let wasVisible = panel.isVisible
        if !wasVisible {
            placePanel()
        }
        panel.orderFrontRegardless()
        panel.makeKey()
        if let webView, panel.firstResponder !== webView {
            panel.makeFirstResponder(webView)
        }
        if !wasVisible {
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
        applyOverhang(0)
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

    /// Places the panel on the display under the pointer: at that display's remembered top
    /// left point, else at the legacy last used point when it is on this display, else
    /// centered with its top just under the menu bar.
    private func placePanel() {
        guard let screen = screenUnderPointer else { return }
        let visible = screen.visibleFrame
        // A placed display reruns its placement against this display's current visible
        // frame instead of reusing the stale absolute numbers it was stored at. The entry
        // is found by display UUID, so it survives a resolution change, and it is rewritten
        // under the display's current key.
        if let savedFrame = settings.panelFrame,
            let entry = savedFrame.displays[screen.positionKey]
                ?? savedFrame.rememberedPoint(forDisplayUUID: PanelFrame.displayUUID(fromKey: screen.positionKey)),
            let placement = entry.placement
        {
            let current = NSRect(
                x: visible.minX, y: visible.minY,
                width: CGFloat(savedFrame.width),
                height: CGFloat(targetHeight(on: screen)))
            let placed = PanelGeometry.frame(
                for: placement, currentFrame: current, visibleFrame: visible,
                minimumSize: CGSize(width: NotesPanel.minimumWidth, height: Self.autoMinimumHeight),
                zoom: settings.zoom)
            setFrame(
                NSRect(
                    x: placed.minX, y: placed.minY - overhang, width: placed.width,
                    height: placed.height + overhang))
            storePlacedFrame(placed, on: screen, placement: placement)
            return
        }
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

    /// The note's frame: the window without the room a hanging dropdown borrows below it.
    var noteFrame: NSRect {
        var frame = panel.frame
        frame.origin.y += overhang
        frame.size.height -= overhang
        return frame
    }

    /// Lets a dropdown hang `height` points past the note's bottom edge: the window grows
    /// downward by that much (never past the display's visible area), while the note keeps its
    /// size and place. Zero gives the room back.
    func applyOverhang(_ height: CGFloat) {
        guard let bodyView else { return }
        var wanted = max(0, height.rounded(.up))
        if wanted > 0, let screen = panel.screen ?? screenUnderPointer {
            wanted = min(wanted, max(0, noteFrame.minY - screen.visibleFrame.minY))
        }
        guard abs(wanted - overhang) >= 1 else { return }
        let note = noteFrame
        overhang = wanted
        bodyView.overhang = wanted
        setFrame(NSRect(x: note.minX, y: note.minY - wanted, width: note.width, height: note.height + wanted))
        bodyView.placeBodyViews()
        panel.invalidateShadow()
        if wanted == 0 {
            // Heights that arrived while the dropdown was open apply now.
            applyHeight()
        }
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
        let zoom = CGFloat(settings.zoom)
        var height: CGFloat
        if let temporaryHeight {
            height = min(max(temporaryHeight, Self.autoMinimumHeight * zoom), Self.autoMaximumHeight * zoom)
        } else if settings.windowAutoSize {
            let content = contentHeight ?? (panel.isVisible ? panel.frame.height : NotesPanel.defaultHeight)
            height = min(max(content, Self.autoMinimumHeight * zoom), Self.autoMaximumHeight * zoom)
        } else if let saved = settings.panelFrame?.height {
            height = CGFloat(saved)
        } else {
            // No stored height yet: the first open size, or whatever the panel had before a
            // temporary growth.
            height = heightBeforeTemporary ?? panel.frame.height
        }
        return min(max(height, panel.minSize.height), screen.visibleFrame.height).rounded()
    }

    /// Clamps the width to the display and nudges the frame fully onto it, keeping the top
    /// edge where it was whenever the frame fits.
    private func keepOnScreen(_ frame: NSRect, visible: NSRect) -> NSRect {
        var result = frame
        result.size.width = min(max(frame.width, panel.minSize.width), visible.width)
        result.size.height = min(frame.height, visible.height)
        result.origin.y = frame.maxY - result.height
        if result.maxY > visible.maxY { result.origin.y = visible.maxY - result.height }
        if result.minY < visible.minY { result.origin.y = visible.minY }
        if result.maxX > visible.maxX { result.origin.x = visible.maxX - result.width }
        if result.minX < visible.minX { result.origin.x = visible.minX }
        return result
    }

    private func setFrame(_ frame: NSRect) {
        // Record the target before the window can report it back, so the delegate
        // handlers below recognise this frame as one of ours.
        expectedFrame = frame
        guard frame != panel.frame else { return }
        // No animation: height steps land at once.
        panel.setFrame(frame, display: panel.isVisible, animate: false)
        panel.invalidateShadow()
    }

    /// A panel drag started through a drag region or the drag strip. Only recorded:
    /// ticket T4 (window placement) consumes the pending signal below, and no
    /// placement behaviour is built on it here.
    private func userDidBeginPanelDrag() {
        panelDragMoveCount += 1
        userMovePendingPlacement = true
        panelDragInProgress = true
    }

    /// Hands the pending user move signal to the placement work (ticket T4) and
    /// clears it, reporting whether one was pending.
    func consumeUserMoveForPlacement() -> Bool {
        defer { userMovePendingPlacement = false }
        return userMovePendingPlacement
    }

    /// Applies the current target height with the top edge fixed.
    private func applyHeight(force: Bool = false) {
        // While a dropdown hangs below the note, the note keeps its size; heights apply after.
        guard overhang == 0, !panel.isUserResizing, let screen = panel.screen ?? screenUnderPointer else { return }
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
    /// A stored placement survives this save only while the current frame is still the
    /// frame that placement asks for on this display, and only when `preservingPlacement`
    /// is true: the unsnap paths (a user resize, an adopted external frame, a panel drag)
    /// pass false, so the placement is cleared while the resulting frame is kept.
    private func saveFrameNow(preservingPlacement: Bool = true) {
        saveFrameWork?.cancel()
        saveFrameWork = nil
        guard let screen = panel.screen else { return }
        let frame = noteFrame
        var saved = settings.panelFrame ?? PanelFrame(x: frame.minX, y: frame.maxY, width: frame.width)
        saved.x = frame.minX
        saved.y = frame.maxY
        saved.width = frame.width
        // A temporary height is never the user's height.
        if settings.windowAutoSize {
            saved.height = nil
        } else if temporaryHeight == nil {
            saved.height = frame.height
        }
        var point = PanelPoint(x: frame.minX, y: frame.maxY)
        if preservingPlacement,
            let existing = saved.displays[screen.positionKey]
                ?? saved.rememberedPoint(forDisplayUUID: PanelFrame.displayUUID(fromKey: screen.positionKey)),
            let placement = existing.placement
        {
            let placed = PanelGeometry.frame(
                for: placement, currentFrame: frame, visibleFrame: screen.visibleFrame,
                minimumSize: CGSize(width: NotesPanel.minimumWidth, height: Self.autoMinimumHeight),
                zoom: settings.zoom)
            let tolerance = Self.heightTolerance
            if abs(placed.minX - frame.minX) <= tolerance, abs(placed.maxY - frame.maxY) <= tolerance,
                abs(placed.width - frame.width) <= tolerance, abs(placed.height - frame.height) <= tolerance
            {
                point = PanelPoint(
                    x: frame.minX, y: frame.maxY, width: frame.width, height: frame.height, placement: placement)
                let uuid = PanelFrame.displayUUID(fromKey: screen.positionKey)
                saved.displays = saved.displays.filter { PanelFrame.displayUUID(fromKey: $0.key) != uuid }
            }
        }
        saved.displays[screen.positionKey] = point
        guard saved != settings.panelFrame else { return }
        do {
            settings = try repository.setSettings(["panelFrame": saved.json])
        } catch {
            logger.log("Could not save the panel frame: \(error)")
        }
    }

    /// A panel drag ended: a pending user move unsnaps the panel, clearing any stored
    /// placement for the display it ended on while keeping the resulting frame.
    private func userDidEndPanelDrag() {
        panelDragInProgress = false
        guard consumeUserMoveForPlacement() else { return }
        saveFrameNow(preservingPlacement: false)
    }

    /// Clears the stored placement for the display the panel is on, keeping its frame.
    private func clearStoredPlacementForCurrentDisplay() {
        guard var saved = settings.panelFrame, let screen = panel.screen ?? screenUnderPointer else { return }
        let key = screen.positionKey
        guard let entry = saved.displays[key], entry.placement != nil else { return }
        saved.displays[key] = PanelPoint(x: entry.x, y: entry.y, width: entry.width, height: entry.height)
        do {
            settings = try repository.setSettings(["panelFrame": saved.json])
        } catch {
            logger.log("Could not clear the panel placement: \(error)")
        }
    }

    /// Stores `placedNote` (an AppKit note frame) as the placement for `screen`: the legacy
    /// top level mirrors it exactly as `saveFrameNow` mirrors the current frame, stale keys
    /// for the same display are dropped, and a non-centre placement turns auto-sizing off.
    private func storePlacedFrame(_ placedNote: NSRect, on screen: NSScreen, placement: PanelPlacement) {
        let turnsAutoOff = placement != .center && settings.windowAutoSize
        var saved = settings.panelFrame ?? PanelFrame(x: placedNote.minX, y: placedNote.maxY, width: placedNote.width)
        saved.x = placedNote.minX
        saved.y = placedNote.maxY
        saved.width = placedNote.width
        if placement == .center, settings.windowAutoSize {
            saved.height = nil
        } else if placement != .center {
            saved.height = placedNote.height
        } else if temporaryHeight == nil {
            saved.height = placedNote.height
        }
        let uuid = PanelFrame.displayUUID(fromKey: screen.positionKey)
        saved.displays = saved.displays.filter { PanelFrame.displayUUID(fromKey: $0.key) != uuid }
        saved.displays[screen.positionKey] = PanelPoint(
            x: placedNote.minX, y: placedNote.maxY, width: placedNote.width, height: placedNote.height,
            placement: placement)
        guard turnsAutoOff || saved != settings.panelFrame else { return }
        do {
            if turnsAutoOff {
                settings = try repository.setSettings(["windowAutoSize": false, "panelFrame": saved.json])
                emitEvent("settings.changed", settings.json)
            } else {
                settings = try repository.setSettings(["panelFrame": saved.json])
            }
        } catch {
            logger.log("Could not save the placed panel frame: \(error)")
        }
    }

    /// A user made height change turns auto-sizing off and keeps that height; a width only
    /// change leaves auto-sizing on. Called at the end of a drag in the resize
    /// zones; programmatic resizes never get here.
    func userDidResize(from start: NSRect, to end: NSRect) {
        // The overlay drives `panel.setFrame` itself, so resync the record to the
        // frame it ended on before applying the shared rules.
        expectedFrame = panel.frame
        let classification = PanelGeometry.classify(
            oldFrame: start, newFrame: end, tolerance: Self.heightTolerance,
            oldOverhang: overhang, newOverhang: overhang)
        applyAdoptedFrame(classification, from: start, to: end)
    }

    /// The one set of rules for a frame somebody else chose, whether a user drag in
    /// the resize zones ended there or an external change is adopted in
    /// `adoptExternalFrameIfNeeded`. Both frames are window frames (bottom left
    /// origin); the stored geometry is the note frame inside them, so the overhang
    /// borrowed below the note is stripped before anything is remembered.
    private func applyAdoptedFrame(_ classification: ExternalFrameChange, from start: NSRect, to end: NSRect) {
        switch classification {
        case .none:
            return
        case .heightChanged:
            // The chosen height wins over a temporary growth that was in effect.
            temporaryHeight = nil
            heightBeforeTemporary = nil
            if settings.windowAutoSize {
                let noteEnd = PanelGeometry.noteFrame(fromWindowFrame: end, overhang: overhang)
                var frame = settings.panelFrame ?? PanelFrame(x: noteEnd.minX, y: noteEnd.maxY, width: noteEnd.width)
                frame.height = noteEnd.height
                do {
                    settings = try repository.setSettings(["windowAutoSize": false, "panelFrame": frame.json])
                    emitEvent("settings.changed", settings.json)
                } catch {
                    logger.log("Could not turn auto-sizing off: \(error)")
                }
            }
            saveFrameNow(preservingPlacement: false)
        case .widthOnly, .moveOnly:
            // Width only keeps auto-sizing and any stored height exactly as they
            // were; a move only remembers the per display top left point. Both are
            // what `saveFrameNow` stores from the note frame.
            saveFrameNow(preservingPlacement: false)
        }
    }

    /// Adopts a frame the controller did not set, reported through
    /// `windowDidResize` or `windowDidMove`. The comparison frame is
    /// `expectedFrame`: anything within the 2 pt tolerance of it is ours (or a
    /// wobble) and is ignored without moving the record, so small drifts add up
    /// against the same record instead of being forgiven one by one.
    private func adoptExternalFrameIfNeeded() {
        if panel.isUserResizing || panelDragInProgress {
            // The resize overlay is mid drag (its end calls `userDidResize`), or the
            // panel itself is being dragged by a drag region (the debounced save in
            // `windowDidMove` remembers its point). Neither is an external change.
            expectedFrame = panel.frame
            return
        }
        guard let expected = expectedFrame else {
            expectedFrame = panel.frame
            return
        }
        let current = panel.frame
        let classification = PanelGeometry.classify(
            oldFrame: expected, newFrame: current, tolerance: Self.heightTolerance,
            oldOverhang: overhang, newOverhang: overhang)
        guard classification != .none else { return }
        lastAdoptionClassification = classification
        lastExternalAdoptionAt = ProcessInfo.processInfo.systemUptime
        expectedFrame = current
        if classification == .moveOnly {
            // Remembering a point is all a move needs, on the usual debounce.
            scheduleFrameSave()
            return
        }
        applyAdoptedFrame(classification, from: expected, to: current)
    }

    // MARK: - NSWindowDelegate

    func windowDidMove(_ notification: Notification) {
        adoptExternalFrameIfNeeded()
        if panel.isVisible { scheduleFrameSave() }
    }

    func windowDidResize(_ notification: Notification) {
        adoptExternalFrameIfNeeded()
    }

    func windowDidChangeScreen(_ notification: Notification) {
        // A screen change that arrives with an external adoption must not snap the
        // adopted frame back to the content height. That is either a change whose
        // resize or move has not been adopted yet (the frame already differs from
        // the recorded one), or the tail of an adoption a moment ago.
        if let expectedFrame,
            PanelGeometry.classify(
                oldFrame: expectedFrame, newFrame: panel.frame, tolerance: Self.heightTolerance,
                oldOverhang: overhang, newOverhang: overhang) != .none
        {
            return
        }
        if lastExternalAdoptionAt > 0,
            ProcessInfo.processInfo.systemUptime - lastExternalAdoptionAt < 1
        {
            lastExternalAdoptionAt = 0
            return
        }
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

    /// Places the panel inside its target display and returns the frame it occupies, or,
    /// while hidden, the frame it will open at, in the persisted convention (`x` is the
    /// left edge, `y` is the top edge).
    /// The target is the panel's current screen while visible and the pointer's screen
    /// while hidden.
    /// Geometry runs on the note frame with the overhang preserved below it.
    /// A non-centre placement clears any temporary height and turns auto-sizing off
    /// through `applyAdoptedFrame`, the same path a user height change takes; centre
    /// changes no size and never touches auto-sizing.
    /// While hidden the panel is not shown: the placement is stored against the pointer's
    /// screen and `placePanel` reruns it when the panel opens.
    func placeWindow(_ placement: PanelPlacement) async -> PanelFrame {
        guard let screen = panel.isVisible ? (panel.screen ?? screenUnderPointer) : screenUnderPointer else {
            let frame = noteFrame
            return PanelFrame(
                x: Double(frame.minX), y: Double(frame.maxY), width: Double(frame.width),
                height: Double(frame.height))
        }
        let placedNote = PanelGeometry.frame(
            for: placement, currentFrame: noteFrame, visibleFrame: screen.visibleFrame,
            minimumSize: CGSize(width: NotesPanel.minimumWidth, height: Self.autoMinimumHeight),
            zoom: settings.zoom)
        let placedWindow = NSRect(
            x: placedNote.minX, y: placedNote.minY - overhang, width: placedNote.width,
            height: placedNote.height + overhang)
        if panel.isVisible {
            let start = panel.frame
            setFrame(placedWindow)
            if placement != .center {
                applyAdoptedFrame(.heightChanged, from: start, to: placedWindow)
            }
        } else if placement != .center {
            temporaryHeight = nil
            heightBeforeTemporary = nil
        }
        storePlacedFrame(placedNote, on: screen, placement: placement)
        return PanelFrame(
            x: Double(placedNote.minX), y: Double(placedNote.maxY), width: Double(placedNote.width),
            height: Double(placedNote.height))
    }

    /// Content driven height. Always programmatic: it never turns auto-sizing off.
    /// A temporary report grows the panel even with auto-sizing off; the next normal report
    /// clears it, which restores the content height (auto-sizing on) or the user's stored
    /// height (auto-sizing off).
    func resizeWindow(contentHeight height: Double, temporary: Bool) async {
        if recordEvents { resizeReports.append(height) }
        let rounded = CGFloat(height).rounded(.up)
        if overhang > 0 {
            // The note keeps its size while a dropdown hangs below it; remember the content height.
            if !temporary { contentHeight = rounded }
            return
        }
        if temporary {
            // Temporary growth only grows: a panel that is already tall enough stays as it is,
            // and so does an earlier, taller temporary growth.
            let zoom = CGFloat(settings.zoom)
            let wanted = min(max(rounded, Self.autoMinimumHeight * zoom), Self.autoMaximumHeight * zoom)
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

    func setOverhang(_ height: Double) async {
        applyOverhang(CGFloat(height))
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
        // Turning auto-sizing back on unsnaps the panel from any stored placement.
        let turnedAutoSizeOn = newSettings.windowAutoSize && !settings.windowAutoSize
        settings = newSettings
        if turnedAutoSizeOn { clearStoredPlacementForCurrentDisplay() }
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
    }

    func emit(_ event: String, _ payload: JSONValue) async {
        emitEvent(event, payload)
    }

    func requestShutdown() async {
        onShutdown()
    }
}
