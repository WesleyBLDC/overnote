import CoreGraphics
import Foundation

/// The panel's size limits, kept free of AppKit so they are unit tested.
///
/// One minimum covers every way the size is set: user resizing, auto-sizing, temporary growth,
/// restored frames, and zoom. It is what the editor reports through `window.setMinimumSize`
/// (its bars plus one line of the note at the current zoom), never below `floorSize`.
public enum PanelSizing {
    /// The smallest panel at any zoom: the toolbar, the first line or two of the note, and the
    /// bottom bar at 100%, wide enough for the toolbar and the format bar.
    public static let floorSize = CGSize(width: 405, height: 197)
    /// The tallest auto-sized panel at 100% zoom; it scales with zoom.
    public static let autoMaximumHeight: CGFloat = 860

    /// The minimum for an editor report (nil before the first one), rounded up to whole points.
    public static func minimumSize(reported: CGSize?) -> CGSize {
        CGSize(
            width: max(floorSize.width, (reported?.width ?? 0).rounded(.up)),
            height: max(floorSize.height, (reported?.height ?? 0).rounded(.up)))
    }

    /// A content driven height (auto-sizing or temporary growth): at least `minimum`, at most
    /// `autoMaximumHeight` times zoom.
    public static func autoHeight(_ content: CGFloat, minimum: CGFloat, zoom: Double) -> CGFloat {
        min(max(content, minimum), max(minimum, autoMaximumHeight * CGFloat(zoom)))
    }

    /// A size, such as a restored frame's, grown to at least `minimum` and then capped to the
    /// display's visible area.
    public static func clamped(_ size: CGSize, minimum: CGSize, available: CGSize) -> CGSize {
        CGSize(
            width: min(max(size.width, minimum.width), available.width),
            height: min(max(size.height, minimum.height), available.height))
    }
}
