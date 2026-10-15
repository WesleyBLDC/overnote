import AppKit

/// The floating notes panel: a titled window with a hidden title bar (for system rounded
/// corners and shadow), non activating so showing it never steals activation from the
/// frontmost app, yet able to become key so it receives typing.
final class NotesPanel: NSPanel {
    static let minimumHeight: CGFloat = 140
    static let minimumWidth: CGFloat = 360
    static let defaultWidth: CGFloat = 560
    static let defaultHeight: CGFloat = 320
    /// The height of the invisible strip along the top edge that drags the panel.
    static let dragStripHeight: CGFloat = 12

    init(contentRect: NSRect) {
        super.init(
            contentRect: contentRect,
            styleMask: [.titled, .fullSizeContentView, .nonactivatingPanel, .resizable],
            backing: .buffered,
            defer: false
        )
        titleVisibility = .hidden
        titlebarAppearsTransparent = true
        for button in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton] {
            standardWindowButton(button)?.isHidden = true
        }
        isFloatingPanel = true
        level = .floating
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        hidesOnDeactivate = false
        becomesKeyOnlyIfNeeded = false
        isReleasedWhenClosed = false
        isMovableByWindowBackground = false
        animationBehavior = .utilityWindow
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
