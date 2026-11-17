import CoreGraphics

/// Whether the panel is on screen, as the show rules see it, free of AppKit so it is unit tested.
/// `PanelController` derives it from the window and its waiting show; it is never stored apart
/// from them.
public enum PanelShowState: Equatable, Sendable {
    case hidden
    /// A show waits for the editor's first height report, so a cold start never flashes the
    /// default height before shrinking to the content.
    case awaitingFirstReport
    case visible

    /// What can end a waiting show.
    public enum Event: Equatable, Sendable {
        /// The editor reported a height (`window.resize`).
        case heightReport(temporary: Bool)
        /// `window.place` set the frame the panel opens at.
        case placed
        /// The settings changed; `autoSize` is the new auto-sizing setting.
        case settingsChanged(autoSize: Bool)
        /// The first report did not come within the timeout.
        case timedOut
    }

    public init(visible: Bool, awaitingFirstReport: Bool) {
        self = awaitingFirstReport ? .awaitingFirstReport : visible ? .visible : .hidden
    }

    /// Whether a show waits for the first height report instead of ordering the panel in: only
    /// for a panel that is not on screen yet, with auto-sizing on, an editor that will report,
    /// and no height known (neither a content report nor a temporary growth).
    public func showWaits(autoSize: Bool, knowsHeight: Bool, hasEditor: Bool) -> Bool {
        self != .visible && autoSize && !knowsHeight && hasEditor
    }

    /// Whether `event` ends a waiting show by ordering the panel in. A normal height report is
    /// the one the show waited for; a temporary one is not. A placement opens the panel at the
    /// placed frame, auto-sizing turned off leaves nothing to wait for, and the timeout shows
    /// the panel at the default height rather than not at all.
    public func completesShow(on event: Event) -> Bool {
        guard self == .awaitingFirstReport else { return false }
        switch event {
        case .heightReport(let temporary): return !temporary
        case .placed, .timedOut: return true
        case .settingsChanged(let autoSize): return !autoSize
        }
    }
}

/// The panel's height mode: normal, following the editor's content reports, or a temporary
/// growth (⌘K, browse, dialogs) that wins until the next normal report. Free of AppKit so it is
/// unit tested.
public struct PanelHeightState: Equatable, Sendable {
    /// A temporary growth and the note's height before it.
    public struct Temporary: Equatable, Sendable {
        public var height: CGFloat
        public var before: CGFloat
    }

    /// The latest normal content height the editor reported, nil until the first report.
    public private(set) var content: CGFloat?
    /// The temporary growth in effect, if any.
    public private(set) var temporary: Temporary?

    public init() {}

    public var isTemporary: Bool { temporary != nil }
    /// Whether any height report arrived, so a show has nothing to wait for.
    public var knowsHeight: Bool { content != nil || temporary != nil }

    /// A temporary report of `wanted` (already limited by `PanelSizing.autoHeight`) for a note
    /// `current` tall. Temporary growth only grows: a note already tall enough, or an earlier
    /// taller growth, stays as it is. Returns whether the panel should take the new height.
    /// The height before the first growth is kept across later ones.
    public mutating func growTemporarily(to wanted: CGFloat, current: CGFloat, tolerance: CGFloat) -> Bool {
        guard current < wanted.rounded() - tolerance else { return false }
        temporary = Temporary(height: wanted, before: temporary?.before ?? current)
        return true
    }

    /// A normal content report: it ends any temporary growth and returns the height from before
    /// it, which a note with auto-sizing off and no stored height goes back to.
    @discardableResult
    public mutating func report(content height: CGFloat) -> CGFloat? {
        let before = temporary?.before
        temporary = nil
        content = height
        return before
    }

    /// Ends a temporary growth without a report: the person's height, a sizing placement, or a
    /// forgotten frame wins over it.
    public mutating func endTemporary() {
        temporary = nil
    }

    /// The height the note should have now, before keeping it on screen. A temporary growth
    /// wins; then, with auto-sizing on, the content height (`beforeFirstReport` until the first
    /// report); then the stored height; else `current`, the note's height (or the height before
    /// a temporary growth that just ended). The result is at least `minimum`, at most
    /// `available`, in whole points.
    public func target(
        autoSize: Bool, storedHeight: CGFloat?, current: CGFloat, beforeFirstReport: CGFloat, minimum: CGFloat,
        zoom: Double, available: CGFloat
    ) -> CGFloat {
        let height: CGFloat
        if let temporary {
            height = PanelSizing.autoHeight(temporary.height, minimum: minimum, zoom: zoom)
        } else if autoSize {
            height = PanelSizing.autoHeight(content ?? beforeFirstReport, minimum: minimum, zoom: zoom)
        } else {
            height = storedHeight ?? current
        }
        return min(max(height, minimum), available).rounded()
    }
}
