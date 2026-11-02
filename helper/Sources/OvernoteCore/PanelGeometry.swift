import CoreGraphics
import Foundation

/// Where the panel should sit inside one display, named exactly as a future `window.place`
/// protocol method will name it on the wire.
public enum PanelPlacement: String, Sendable, CaseIterable {
    case left
    case right
    case fill
    case center
}

/// How an externally observed frame differs from the frame the helper last knew, judged on
/// the note frame rather than on the raw window frame.
/// A future PanelController ticket can feed this from a user resize or from an adopted
/// external frame and apply one set of rules to both: `heightChanged` is the only case that
/// carries the meaning a user height change carries today.
/// Cases are listed in the order `PanelGeometry.classify` checks them.
public enum ExternalFrameChange: String, Sendable, CaseIterable {
    case heightChanged
    case widthOnly
    case moveOnly
    case none
}

/// Pure panel geometry in AppKit global coordinates, where the origin is at the bottom left
/// of the primary display and `y` grows upward.
/// Every function here is free of AppKit state so it can be tested headlessly: callers pass
/// frames in and get frames out, and only the caller talks to a real window or screen.
public enum PanelGeometry {
    /// Height changes at or below this many points are ignored, matching the tolerance the
    /// panel controller already uses for content driven heights and user resizes.
    public static let defaultTolerance: CGFloat = 2

    /// The frame `placement` asks for inside `visibleFrame`.
    ///
    /// `currentFrame` is the current note frame and is read only by `.center`.
    /// `minimumSize` is the unzoomed minimum note size, for example 396 by 128 points.
    /// `zoom` scales both minimum dimensions linearly, mirroring how the panel builds
    /// its minimum size, where the minimum height already scales with zoom.
    /// The result is always integral and always inside the integral visible frame, except
    /// that a degenerate visible frame is returned integral and unchanged in size.
    public static func frame(
        for placement: PanelPlacement,
        currentFrame: CGRect,
        visibleFrame: CGRect,
        minimumSize: CGSize,
        zoom: Double
    ) -> CGRect {
        let visible = visibleFrame.integral
        guard visible.width > 0, visible.height > 0 else { return visible }

        switch placement {
        case .fill:
            return visible
        case .left, .right:
            // Partition by integer points so the halves meet exactly at any visible width.
            // The left half takes the extra point when the width is odd.
            let total = Int(visible.width.rounded())
            let leftWidth = (total + 1) / 2
            if placement == .left {
                return CGRect(x: visible.minX, y: visible.minY, width: CGFloat(leftWidth), height: visible.height)
            }
            return CGRect(
                x: visible.minX + CGFloat(leftWidth), y: visible.minY,
                width: CGFloat(total - leftWidth), height: visible.height)
        case .center:
            let size = centeredSize(currentFrame: currentFrame, visible: visible, minimumSize: minimumSize, zoom: zoom)
            let origin = CGPoint(
                x: visible.minX + (visible.width - size.width) / 2,
                y: visible.minY + (visible.height - size.height) / 2)
            // The centred rect is inside the integral visible frame, so its integral stays
            // inside too, and grows by at most one point per dimension.
            return CGRect(origin: origin, size: size).integral
        }
    }

    /// Classifies an external frame change where both frames share one overhang value.
    /// See the overload taking separate overhangs for the full rules.
    public static func classify(
        oldFrame: CGRect,
        newFrame: CGRect,
        tolerance: CGFloat = defaultTolerance,
        overhang: CGFloat = 0
    ) -> ExternalFrameChange {
        classify(oldFrame: oldFrame, newFrame: newFrame, tolerance: tolerance, oldOverhang: overhang, newOverhang: overhang)
    }

    /// Classifies an external frame change after stripping the overhang from each window
    /// frame, so growth borrowed by a hanging dropdown is never mistaken for a note resize.
    /// Callers that already hold note frames pass zero overhangs.
    /// A height difference above `tolerance` wins over every other difference, because a
    /// height change is the case that changes the stored height behaviour.
    /// Next a width difference above `tolerance` is `widthOnly`, even when the origin also
    /// moved, as it does when the left edge is dragged.
    /// Next an origin difference above `tolerance` on either axis is `moveOnly`.
    /// Anything at or below `tolerance` on every axis is `none`, so a one point wobble with
    /// the existing two point tolerance classifies as `none`.
    public static func classify(
        oldFrame: CGRect,
        newFrame: CGRect,
        tolerance: CGFloat = defaultTolerance,
        oldOverhang: CGFloat,
        newOverhang: CGFloat
    ) -> ExternalFrameChange {
        let limit = tolerance.isFinite ? max(0, tolerance) : 0
        let old = noteFrame(fromWindowFrame: oldFrame, overhang: oldOverhang)
        let new = noteFrame(fromWindowFrame: newFrame, overhang: newOverhang)
        if abs(new.height - old.height) > limit { return .heightChanged }
        if abs(new.width - old.width) > limit { return .widthOnly }
        if abs(new.minX - old.minX) > limit || abs(new.minY - old.minY) > limit { return .moveOnly }
        return .none
    }

    /// The note frame inside a window frame that borrows `overhang` points below the note.
    /// This mirrors the note frame the panel controller derives from its window frame.
    public static func noteFrame(fromWindowFrame frame: CGRect, overhang: CGFloat) -> CGRect {
        let borrowed = overhang.isFinite ? max(0, overhang) : 0
        return CGRect(
            x: frame.minX, y: frame.minY + borrowed, width: frame.width,
            height: max(0, frame.height - borrowed))
    }

    private static func centeredSize(currentFrame: CGRect, visible: CGRect, minimumSize: CGSize, zoom: Double) -> CGSize {
        let safeZoom = zoom.isFinite && zoom > 0 ? CGFloat(zoom) : 1
        let minimumWidth = minimumSize.width.isFinite ? max(0, minimumSize.width) * safeZoom : 0
        let minimumHeight = minimumSize.height.isFinite ? max(0, minimumSize.height) * safeZoom : 0
        func clamped(_ value: CGFloat, minimum: CGFloat, limit: CGFloat) -> CGFloat {
            let wanted = value.isFinite ? value : minimum
            // Containment wins when even the minimum cannot fit inside the display.
            return min(max(wanted, minimum), limit)
        }
        return CGSize(
            width: clamped(currentFrame.width, minimum: minimumWidth, limit: visible.width),
            height: clamped(currentFrame.height, minimum: minimumHeight, limit: visible.height))
    }
}
