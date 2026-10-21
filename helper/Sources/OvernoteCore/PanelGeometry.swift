import CoreGraphics

/// The panel's placement and frame memory as plain geometry, free of AppKit so it is unit
/// tested. Rects are AppKit screen rects (points, origin at the bottom left of the primary
/// display, y up); a stored `PanelFrame` keeps the **top** edge in `y`.
public enum PanelGeometry {
    /// Grows the frame to the minimum size (`PanelSizing`), clamps it to the display, and
    /// nudges it fully onto its visible area, keeping the top edge where it was whenever the
    /// frame fits. A frame already inside the visible area and at least the minimum (a tiled
    /// half, a frame flush with any edge) comes back unchanged.
    public static func keepOnScreen(_ frame: CGRect, visible: CGRect, minimum: CGSize) -> CGRect {
        var result = frame
        result.size = PanelSizing.clamped(frame.size, minimum: minimum, available: visible.size)
        result.origin.y = frame.maxY - result.height
        if result.maxY > visible.maxY { result.origin.y = visible.maxY - result.height }
        if result.minY < visible.minY { result.origin.y = visible.minY }
        if result.maxX > visible.maxX { result.origin.x = visible.maxX - result.width }
        if result.minX < visible.minX { result.origin.x = visible.minX }
        return result
    }

    /// Where the panel opens on a display: at that display's remembered top left point, else
    /// at the legacy last used point when it lies on this display, else centered with its top
    /// just under the menu bar; then kept on screen.
    public static func placement(
        stored: PanelFrame?, displayKey: String, visible: CGRect, width: CGFloat, height: CGFloat,
        minimum: CGSize
    ) -> CGRect {
        var topLeft = CGPoint(x: visible.midX - width / 2, y: visible.maxY)
        if let saved = stored?.displays[displayKey] {
            topLeft = CGPoint(x: saved.x, y: saved.y)
        } else if let stored, stored.displays.isEmpty, visible.contains(CGPoint(x: stored.x + 1, y: stored.y - 1)) {
            topLeft = CGPoint(x: stored.x, y: stored.y)
        }
        let frame = CGRect(x: topLeft.x, y: topLeft.y - height, width: width, height: height)
        return keepOnScreen(frame, visible: visible, minimum: minimum)
    }

    /// The stored frame once the note settled at `note` on display `displayKey`, however it got
    /// there (a drag, the resize zones, system tiling, or a window manager): its top left point,
    /// for that display and as the last used point, its width, and its height. Auto-sizing owns
    /// the height while `autoSize` is on, so none is stored, and a temporary growth (`temporary`)
    /// is never the person's height, so the stored one stays.
    public static func recording(
        _ note: CGRect, displayKey: String, in stored: PanelFrame?, autoSize: Bool, temporary: Bool
    ) -> PanelFrame {
        var saved = stored ?? PanelFrame(x: note.minX, y: note.maxY, width: note.width)
        saved.x = note.minX
        saved.y = note.maxY
        saved.width = note.width
        if autoSize {
            saved.height = nil
        } else if !temporary {
            saved.height = note.height
        }
        saved.displays[displayKey] = PanelPoint(x: note.minX, y: note.maxY)
        return saved
    }

    /// Whether a frame change set a new height (beyond `tolerance`), which ends auto-sizing:
    /// the person chose that height, through the resize zones, a system resize, tiling, or a
    /// window manager.
    public static func changesHeight(from start: CGRect, to end: CGRect, tolerance: CGFloat) -> Bool {
        abs(end.height - start.height) > tolerance
    }
}
