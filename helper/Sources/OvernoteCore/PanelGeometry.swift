import CoreGraphics

/// Where `window.place` puts the panel inside one display's visible area, named exactly as the
/// protocol names it on the wire.
public enum PanelPlacement: String, Sendable, CaseIterable {
    case left, right, fill, center

    /// Left, right, and fill set the size from the display, so they end auto-sizing and any
    /// temporary growth; center keeps the size the panel has.
    public var setsSize: Bool { self != .center }
}

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
    /// is never the person's height, so the stored one stays. With `keepsPlacement` the display's
    /// stored placement stays (the helper moved or resized the panel itself), carried over from
    /// the same display uuid at another resolution when this key has none; otherwise the point
    /// becomes the plain top left point, which clears its placement.
    public static func recording(
        _ note: CGRect, displayKey: String, in stored: PanelFrame?, autoSize: Bool, temporary: Bool,
        keepsPlacement: Bool = false
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
        if keepsPlacement, let placement = storedPlacement(in: saved, displayKey: displayKey) {
            if saved.displays[displayKey]?.placement == nil {
                // The display changed resolution while the panel was open: carry the placement
                // stored under its other key over to this one.
                saved.displays[displayKey] = PanelPoint(
                    x: note.minX, y: note.maxY, width: note.width, height: note.height, placement: placement)
            }
        } else {
            saved.displays[displayKey] = PanelPoint(x: note.minX, y: note.maxY)
        }
        return saved
    }

    /// Whether a frame change set a new height (beyond `tolerance`), which ends auto-sizing:
    /// the person chose that height, through the resize zones, a system resize, tiling, or a
    /// window manager.
    public static func changesHeight(from start: CGRect, to end: CGRect, tolerance: CGFloat) -> Bool {
        abs(end.height - start.height) > tolerance
    }

    /// The frame `placement` gives a panel of size `current` inside `visible`, in whole points.
    /// Fill is the visible frame. Left and right split its width so the halves meet exactly,
    /// the left half taking the extra point of an odd width; a half narrower than the minimum
    /// grows to it from its own screen edge. Center keeps the current size, clamped to the
    /// minimum and the visible frame, and centers it.
    public static func placed(
        _ placement: PanelPlacement, current: CGSize, visible: CGRect, minimum: CGSize
    ) -> CGRect {
        // The whole point frame inside the visible frame: each edge moves inward, so a
        // fractional max edge (from display scaling) never leaves a placed frame past it.
        let area = CGRect(
            x: visible.minX.rounded(.up), y: visible.minY.rounded(.up),
            width: visible.maxX.rounded(.down) - visible.minX.rounded(.up),
            height: visible.maxY.rounded(.down) - visible.minY.rounded(.up))
        let total = Int(area.width)
        let leftWidth = CGFloat((total + 1) / 2)
        func sized(_ size: CGSize) -> CGSize {
            PanelSizing.clamped(size, minimum: minimum, available: area.size)
        }
        switch placement {
        case .fill:
            return area
        case .left:
            let size = sized(CGSize(width: leftWidth, height: area.height))
            return CGRect(x: area.minX, y: area.maxY - size.height, width: size.width, height: size.height)
        case .right:
            let size = sized(CGSize(width: area.width - leftWidth, height: area.height))
            return CGRect(x: area.maxX - size.width, y: area.maxY - size.height, width: size.width, height: size.height)
        case .center:
            let size = sized(CGSize(width: current.width.rounded(), height: current.height.rounded()))
            return CGRect(
                x: area.minX + ((area.width - size.width) / 2).rounded(.down),
                y: area.minY + ((area.height - size.height) / 2).rounded(.up),
                width: size.width, height: size.height)
        }
    }

    /// The placement stored for a display: the point under its exact key when there is one
    /// (a point without a placement means none), else a placed point stored for the same display
    /// at another size, matched by the display uuid before the `@` in the key, so a placement
    /// survives a resolution change.
    public static func storedPlacement(in stored: PanelFrame?, displayKey: String) -> PanelPlacement? {
        guard let displays = stored?.displays else { return nil }
        if let point = displays[displayKey] { return point.placement }
        let identity = displayIdentity(displayKey)
        return displays.sorted { $0.key < $1.key }
            .first { displayIdentity($0.key) == identity && $0.value.placement != nil }?.value.placement
    }

    /// The display identity part of a `"<display uuid>@<w>x<h>"` key.
    static func displayIdentity(_ key: String) -> Substring {
        key.split(separator: "@", maxSplits: 1, omittingEmptySubsequences: false).first ?? Substring(key)
    }

    /// The stored frame with the placement for `displayKey` cleared and every other display
    /// left alone: the display's point stays, as its plain top left point. A frame with no
    /// placement there (or no frame at all) comes back unchanged.
    public static func clearingPlacement(in stored: PanelFrame?, displayKey: String) -> PanelFrame? {
        guard var saved = stored, let point = saved.displays[displayKey], point.placement != nil else { return stored }
        saved.displays[displayKey] = PanelPoint(x: point.x, y: point.y)
        return saved
    }

    /// The stored frame with every display's placement cleared, each point kept as its plain
    /// top left point: turning auto-sizing on, which owns the height on every display, so no
    /// stored placement describes a frame any longer.
    public static func clearingAllPlacements(in stored: PanelFrame?) -> PanelFrame? {
        guard var saved = stored else { return nil }
        for (key, point) in saved.displays where point.placement != nil {
            saved.displays[key] = PanelPoint(x: point.x, y: point.y)
        }
        return saved
    }

    /// The stored frame after `placement` put the panel at `placed` on display `displayKey`: the
    /// same as `recording`, plus the display's point carrying the placed size and the placement,
    /// so the next open on that display runs the placement again.
    public static func placing(
        _ placement: PanelPlacement, frame placed: CGRect, displayKey: String, in stored: PanelFrame?,
        autoSize: Bool, temporary: Bool
    ) -> PanelFrame {
        var saved = recording(placed, displayKey: displayKey, in: stored, autoSize: autoSize, temporary: temporary)
        saved.displays[displayKey] = PanelPoint(
            x: placed.minX, y: placed.maxY, width: placed.width, height: placed.height, placement: placement)
        return saved
    }
}
