import AppKit
import WebKit

/// The floating notes panel (spec/window.md section 11).
///
/// Borderless, so the whole body is ours: no title bar region swallows clicks over the
/// editor's top bar, and the editor draws its own Close control. Non activating, so showing
/// it never activates the helper or changes the menu bar, yet it can become key and take
/// typing. It sits at the modal panel level, one step above ordinary floating windows.
final class NotesPanel: NSPanel {
    /// Smallest size a user can drag to, at 100% (spec/window.md 5.3 and the auto-height minimum).
    static let minimumWidth: CGFloat = 396
    static let minimumHeight: CGFloat = 128
    /// First run size (spec/window.md 12.2).
    static let defaultWidth: CGFloat = 600
    static let defaultHeight: CGFloat = 440
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
            styleMask: [.borderless, .nonactivatingPanel, .resizable],
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
        // Show and hide are instant (spec/window.md 3.1).
        animationBehavior = .none
        isOpaque = false
        backgroundColor = .clear
        hasShadow = true
        minSize = NSSize(width: Self.minimumWidth, height: Self.minimumHeight)
    }

    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }

    /// Standard editing shortcuts reach the main menu even while the app is not active.
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        if super.performKeyEquivalent(with: event) {
            return true
        }
        return NSApp.mainMenu?.performKeyEquivalent(with: event) ?? false
    }
}

/// The panel's root view: clips its subviews to the rounded body and draws the 1 pt rim.
final class PanelBodyView: NSView {
    private let rim = CALayer()

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
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        rim.frame = bounds
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

/// A web view that never takes the first click into an unfocused panel: that click only
/// focuses the panel, so a click meant to focus never moves the caret (spec/window.md 2.5).
final class NotesWebView: WKWebView {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { false }
}

/// An invisible strip at the top of the panel that moves the window when dragged,
/// since the web view covers the whole content area.
final class DragStripView: NSView {
    override func mouseDown(with event: NSEvent) {
        window?.performDrag(with: event)
    }

    override func resetCursorRects() {
        addCursorRect(bounds, cursor: .openHand)
    }

    override var mouseDownCanMoveWindow: Bool { true }
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
