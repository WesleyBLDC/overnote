import AppKit
import WebKit

/// The floating notes panel.
///
/// Borderless, so the whole body is ours: no title bar region swallows clicks over the
/// editor's top bar, and the editor draws its own Close control. Non activating, so showing
/// it never activates the helper or changes the menu bar, yet it can become key and take
/// typing. It sits at the modal panel level, one step above ordinary floating windows.
final class NotesPanel: NSPanel {
    /// Smallest size a user can drag to, at 100%, matching the auto-height minimum.
    static let minimumWidth: CGFloat = 396
    static let minimumHeight: CGFloat = 128
    /// First open size when no frame is stored: roomy, since auto-sizing is off by default.
    static let defaultWidth: CGFloat = 640
    static let defaultHeight: CGFloat = 560
    /// The height of the invisible strip along the top edge that drags the panel.
    static let dragStripHeight: CGFloat = 12

    /// macOS 26 windows use a large continuous corner; earlier systems use the standard
    /// window radius, so the panel looks native on each.
    static let cornerRadius: CGFloat = {
        let tahoe = OperatingSystemVersion(majorVersion: 26, minorVersion: 0, patchVersion: 0)
        return ProcessInfo.processInfo.isOperatingSystemAtLeast(tahoe) ? 26 : 10
    }()

    init(contentRect: NSRect) {
        super.init(
            contentRect: contentRect,
            // Not `.resizable`: AppKit's own edge resize for borderless windows is a sliver
            // that tracks the window server pointer. ResizeOverlayView owns all resizing.
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        isFloatingPanel = true
        level = .modalPanel
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        hidesOnDeactivate = false
        becomesKeyOnlyIfNeeded = false
        isReleasedWhenClosed = false
        isMovableByWindowBackground = false
        // Show and hide are instant.
        animationBehavior = .none
        isOpaque = false
        backgroundColor = .clear
        hasShadow = true
        minSize = NSSize(width: Self.minimumWidth, height: Self.minimumHeight)
    }

    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }

    /// True while the user drags one of our resize zones, so content driven height changes
    /// never fight the pointer.
    var isUserResizing = false
    /// Called once a user resize through the resize zones ends, with the start and end frames.
    var onUserResize: ((NSRect, NSRect) -> Void)?
    /// Called for Close Window (⌘W) and any other performClose, since the borderless panel
    /// has no close button for AppKit to press.
    var onClose: (() -> Void)?
    /// Test hooks only: replaces the window server drag, so a synthetic mouse down never
    /// starts a real drag that would follow the user's pointer.
    var dragInterceptor: ((NSEvent) -> Void)?

    /// Moves the panel with the pointer, the way a title bar does.
    func beginDrag(with event: NSEvent) {
        if let dragInterceptor {
            dragInterceptor(event)
        } else {
            performDrag(with: event)
        }
    }

    override func performClose(_ sender: Any?) {
        onClose?()
    }

    /// Standard editing shortcuts reach the main menu even while the app is not active.
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        if super.performKeyEquivalent(with: event) {
            return true
        }
        return NSApp.mainMenu?.performKeyEquivalent(with: event) ?? false
    }
}

/// The panel's root view: clips its subviews to the rounded body and draws the 1 pt rim.
///
/// While a dropdown hangs past the note (`overhang` > 0, `window.setOverhang`), the window is
/// taller than the note: the body (background, rim, resize zones) keeps the note's size at the
/// top, and below it only the web view shows, through a mask, so the dropdown appears to hang
/// past the bottom edge while the note itself never changes size.
final class PanelBodyView: NSView {
    private let rim = CALayer()
    private let overhangMask = CAShapeLayer()
    /// Points of window below the note's bottom edge.
    var overhang: CGFloat = 0 {
        didSet { placeBodyViews() }
    }
    /// The views that keep the note's size while a dropdown hangs below it.
    weak var background: NSView?
    weak var resizeOverlay: NSView?

    /// The note's area, at the top of the window.
    var bodyRect: NSRect {
        NSRect(x: 0, y: overhang, width: bounds.width, height: max(0, bounds.height - overhang))
    }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.cornerRadius = NotesPanel.cornerRadius
        layer?.cornerCurve = .continuous
        layer?.masksToBounds = true
        rim.cornerRadius = NotesPanel.cornerRadius
        rim.cornerCurve = .continuous
        rim.borderWidth = 1
        rim.zPosition = 1000
        layer?.addSublayer(rim)
        updateRim()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    override func layout() {
        super.layout()
        placeBodyViews()
    }

    override func resizeSubviews(withOldSize oldSize: NSSize) {
        super.resizeSubviews(withOldSize: oldSize)
        placeBodyViews()
    }

    /// Sizes the note's own views to `bodyRect`, and clips to the rounded note plus the strip below.
    func placeBodyViews() {
        let body = bodyRect
        background?.frame = body
        resizeOverlay?.frame = body
        // No resizing while a dropdown is open: its edges are not the note's edges.
        resizeOverlay?.isHidden = overhang > 0
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        rim.frame = body
        if overhang > 0 {
            let radius = NotesPanel.cornerRadius
            let path = CGMutablePath()
            path.addRoundedRect(in: body, cornerWidth: radius, cornerHeight: radius)
            path.addRect(NSRect(x: 0, y: 0, width: bounds.width, height: overhang))
            overhangMask.frame = bounds
            overhangMask.path = path
            layer?.mask = overhangMask
            layer?.masksToBounds = false
        } else {
            layer?.mask = nil
            layer?.masksToBounds = true
        }
        CATransaction.commit()
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        updateRim()
    }

    private func updateRim() {
        let dark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        rim.borderColor = (dark ? NSColor.white.withAlphaComponent(0.12) : NSColor.black.withAlphaComponent(0.10)).cgColor
    }
}

/// The editor's web view.
///
/// It never takes the first click into an unfocused panel: that click only focuses the
/// panel, so a click meant to focus never moves the caret or presses a button.
/// The one exception is a drag region, which behaves like a title bar.
///
/// A mouse down inside one of the editor's drag regions (`window.setDragRegions`, the empty
/// toolbar area) moves the window instead of reaching the page.
final class NotesWebView: WKWebView {
    /// Drag regions in points, top left origin, relative to this view.
    var dragRects: [NSRect] = []
    weak var resizeOverlay: ResizeOverlayView?

    /// The point of `event` in this view, with a top left origin.
    private func topLeftPoint(of event: NSEvent) -> NSPoint {
        let point = convert(event.locationInWindow, from: nil)
        return NSPoint(x: point.x, y: isFlipped ? point.y : bounds.height - point.y)
    }

    func isInDragRegion(_ event: NSEvent) -> Bool {
        let point = topLeftPoint(of: event)
        return dragRects.contains { $0.contains(point) }
    }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool {
        guard let event else { return false }
        return isInDragRegion(event)
    }

    override func mouseDown(with event: NSEvent) {
        if isInDragRegion(event), let panel = window as? NotesPanel {
            panel.beginDrag(with: event)
            return
        }
        super.mouseDown(with: event)
    }

    /// Over a resize zone the page must not see the pointer, or WebKit would replace the
    /// resize cursor with its own.
    override func mouseMoved(with event: NSEvent) {
        if let resizeOverlay, resizeOverlay.edge(atWindowPoint: event.locationInWindow) != nil {
            return
        }
        super.mouseMoved(with: event)
    }
}

/// An invisible strip at the top of the panel that moves the window when dragged,
/// since the web view covers the whole content area. A fallback for the editor's drag regions.
final class DragStripView: NSView {
    override func mouseDown(with event: NSEvent) {
        (window as? NotesPanel)?.beginDrag(with: event)
    }

    /// Like a title bar, it drags even an unfocused panel.
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override var mouseDownCanMoveWindow: Bool { true }
}

/// Which edges a resize zone moves.
struct ResizeEdge: OptionSet, Hashable {
    let rawValue: Int
    static let top = ResizeEdge(rawValue: 1 << 0)
    static let left = ResizeEdge(rawValue: 1 << 1)
    static let bottom = ResizeEdge(rawValue: 1 << 2)
    static let right = ResizeEdge(rawValue: 1 << 3)

    /// Along each edge.
    static let edgeThickness: CGFloat = 10
    /// The square at each corner.
    static let cornerSize: CGFloat = 24

    var name: String {
        let parts: [(ResizeEdge, String)] = [(.top, "top"), (.bottom, "bottom"), (.left, "left"), (.right, "right")]
        return parts.filter { contains($0.0) }.map(\.1).joined(separator: "-")
    }

    /// The zone at `point` (bottom left origin) in a view of `size`, or nil in the interior.
    static func zone(at point: NSPoint, in size: NSSize) -> ResizeEdge? {
        guard point.x >= 0, point.y >= 0, point.x <= size.width, point.y <= size.height else { return nil }
        let nearLeft = point.x < cornerSize, nearRight = point.x > size.width - cornerSize
        let nearBottom = point.y < cornerSize, nearTop = point.y > size.height - cornerSize
        if (nearLeft || nearRight) && (nearTop || nearBottom) {
            return [nearLeft ? .left : .right, nearTop ? .top : .bottom]
        }
        var edge: ResizeEdge = []
        if point.x < edgeThickness { edge.insert(.left) }
        if point.x > size.width - edgeThickness { edge.insert(.right) }
        if point.y < edgeThickness { edge.insert(.bottom) }
        if point.y > size.height - edgeThickness { edge.insert(.top) }
        return edge.isEmpty ? nil : edge
    }

    /// The frame after the pointer moved by `delta` (screen points, y up) from where the
    /// resize started. The opposite edges stay put; the size respects `minSize` and the frame
    /// stays inside `bounds` (the display's visible area).
    func resized(_ start: NSRect, by delta: NSPoint, minSize: NSSize, within bounds: NSRect) -> NSRect {
        var frame = start
        if contains(.right) {
            frame.size.width = min(max(start.width + delta.x, minSize.width), bounds.maxX - start.minX)
        }
        if contains(.left) {
            frame.size.width = min(max(start.width - delta.x, minSize.width), start.maxX - bounds.minX)
            frame.origin.x = start.maxX - frame.width
        }
        if contains(.top) {
            frame.size.height = min(max(start.height + delta.y, minSize.height), bounds.maxY - start.minY)
        }
        if contains(.bottom) {
            frame.size.height = min(max(start.height - delta.y, minSize.height), start.maxY - bounds.minY)
            frame.origin.y = start.maxY - frame.height
        }
        return frame.integral
    }

    /// macOS 15 has proper frame resize cursors; macOS 14 falls back to the two axis ones.
    var cursor: NSCursor {
        if #available(macOS 15.0, *) {
            let position: NSCursor.FrameResizePosition
            switch self {
            case [.top, .left]: position = .topLeft
            case [.top, .right]: position = .topRight
            case [.bottom, .left]: position = .bottomLeft
            case [.bottom, .right]: position = .bottomRight
            case .top: position = .top
            case .bottom: position = .bottom
            case .left: position = .left
            default: position = .right
            }
            return .frameResize(position: position, directions: .all)
        }
        if self == .left || self == .right { return .resizeLeftRight }
        if self == .top || self == .bottom { return .resizeUpDown }
        return .crosshair
    }
}

/// Invisible resize zones along the edges and corners of the borderless panel, above the
/// web view. It only claims events inside the zones; everywhere else hit testing falls
/// through to the views below.
final class ResizeOverlayView: NSView {
    private var showingResizeCursor = false

    override func hitTest(_ point: NSPoint) -> NSView? {
        let local = convert(point, from: superview)
        return ResizeEdge.zone(at: local, in: bounds.size) == nil ? nil : self
    }

    func edge(atWindowPoint point: NSPoint) -> ResizeEdge? {
        isHidden ? nil : ResizeEdge.zone(at: convert(point, from: nil), in: bounds.size)
    }

    /// Resizing works on an unfocused panel too, like any window edge.
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override var mouseDownCanMoveWindow: Bool { false }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach(removeTrackingArea)
        // Always active: the helper is never the active app, so key only areas would not fire.
        addTrackingArea(
            NSTrackingArea(
                rect: .zero, options: [.mouseMoved, .mouseEnteredAndExited, .cursorUpdate, .activeAlways, .inVisibleRect],
                owner: self))
    }

    private func updateCursor(_ event: NSEvent) {
        if let edge = edge(atWindowPoint: event.locationInWindow) {
            edge.cursor.set()
            showingResizeCursor = true
        } else if showingResizeCursor {
            NSCursor.arrow.set()
            showingResizeCursor = false
        }
    }

    override func mouseMoved(with event: NSEvent) { updateCursor(event) }
    override func mouseEntered(with event: NSEvent) { updateCursor(event) }
    override func cursorUpdate(with event: NSEvent) { updateCursor(event) }

    override func mouseExited(with event: NSEvent) {
        if showingResizeCursor {
            NSCursor.arrow.set()
            showingResizeCursor = false
        }
    }

    /// The event's global position in AppKit screen coordinates. It comes from the event
    /// itself, not from the window, so the window moving during the resize never skews it.
    private static func screenLocation(of event: NSEvent) -> NSPoint {
        guard let location = event.cgEvent?.location, let primary = NSScreen.screens.first else {
            return NSEvent.mouseLocation
        }
        return NSPoint(x: location.x, y: primary.frame.maxY - location.y)
    }

    /// Runs the resize until the mouse goes up. The frame follows the pointer's screen
    /// position, so moving the window's own origin never feeds back into the math.
    override func mouseDown(with event: NSEvent) {
        guard let panel = window as? NotesPanel, let edge = edge(atWindowPoint: event.locationInWindow) else {
            super.mouseDown(with: event)
            return
        }
        let start = panel.frame
        let origin = Self.screenLocation(of: event)
        let bounds = (panel.screen ?? NSScreen.main)?.visibleFrame ?? .infinite
        panel.isUserResizing = true
        edge.cursor.set()
        while let next = panel.nextEvent(matching: [.leftMouseDragged, .leftMouseUp]) {
            let point = Self.screenLocation(of: next)
            let frame = edge.resized(
                start, by: NSPoint(x: point.x - origin.x, y: point.y - origin.y), minSize: panel.minSize, within: bounds)
            if frame != panel.frame {
                panel.setFrame(frame, display: true, animate: false)
            }
            if next.type == .leftMouseUp { break }
        }
        panel.isUserResizing = false
        panel.invalidateShadow()
        panel.onUserResize?(start, panel.frame)
    }
}

extension NSScreen {
    /// A stable key for remembering positions per display: the display UUID (falling back to
    /// the display id) plus the display size in points, so a resolution change starts fresh.
    var positionKey: String {
        let number = deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber
        let displayId = number.map { CGDirectDisplayID($0.uint32Value) } ?? 0
        var identity = "display-\(displayId)"
        if let uuid = CGDisplayCreateUUIDFromDisplayID(displayId)?.takeRetainedValue(),
            let text = CFUUIDCreateString(nil, uuid) as String?
        {
            identity = text
        }
        return "\(identity)@\(Int(frame.width))x\(Int(frame.height))"
    }
}
