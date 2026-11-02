import Foundation

/// A remembered top left point on one display. `y` is the **top** edge.
/// `width`, `height`, and `placement` are optional, so a point stored before they existed
/// reads back unchanged and writes back without them until a placement is stored.
public struct PanelPoint: Equatable, Sendable {
    public var x: Double
    public var y: Double
    public var width: Double?
    public var height: Double?
    public var placement: PanelPlacement?

    public init(
        x: Double, y: Double, width: Double? = nil, height: Double? = nil, placement: PanelPlacement? = nil
    ) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
        self.placement = placement
    }

    public var json: JSONValue {
        var object: [String: JSONValue] = ["x": .double(x), "y": .double(y)]
        if let width { object["width"] = .double(width) }
        if let height { object["height"] = .double(height) }
        if let placement { object["placement"] = .string(placement.rawValue) }
        return .object(object)
    }
}

/// The panel geometry the helper remembers, in AppKit global coordinates (origin at the
/// bottom left of the primary screen). Every `y` is the panel's **top** edge, because the
/// height is content driven and the top edge is what stays put while it changes.
///
/// - `x`, `y`: the last used top left point, on whatever display that was.
/// - `width`: the panel width, shared by all displays.
/// - `height`: the user's height, stored only when `windowAutoSize` is off.
/// - `displays`: one remembered top left point per display, keyed by
///   `"<display uuid>@<width>x<height>"` (the display identity plus its size in points).
///   Each point may also carry the width, height, and placement it was placed at.
///   Optional, so an older `{ x, y, width, height? }` value without it still reads and writes fine.
public struct PanelFrame: Equatable, Sendable {
    public var x: Double
    public var y: Double
    public var width: Double
    public var height: Double?
    public var displays: [String: PanelPoint]

    public init(x: Double, y: Double, width: Double, height: Double? = nil, displays: [String: PanelPoint] = [:]) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
        self.displays = displays
    }

    /// Builds the per display key from a display UUID and its size in points, matching the
    /// format the panel controller already writes from a screen.
    public static func displayKey(uuid: String, displayWidth: Double, displayHeight: Double) -> String {
        "\(uuid)@\(Int(displayWidth))x\(Int(displayHeight))"
    }

    /// The display UUID inside a per display key, or the whole key when it carries no size.
    public static func displayUUID(fromKey key: String) -> String {
        guard let separator = key.firstIndex(of: "@") else { return key }
        return String(key[..<separator])
    }

    /// The remembered point for a display UUID, whatever size the stored key was written at.
    /// A display keeps its UUID when its size changes, so matching on the UUID alone lets a
    /// remembered point survive a resolution change instead of being lost with the old key.
    /// When stale keys for several sizes of one display are present, the point under the
    /// lexicographically smallest key wins, so the answer never depends on dictionary order.
    public func rememberedPoint(forDisplayUUID uuid: String) -> PanelPoint? {
        for key in displays.keys.sorted() where Self.displayUUID(fromKey: key) == uuid {
            return displays[key]
        }
        return nil
    }

    public var json: JSONValue {
        var object: [String: JSONValue] = ["x": .double(x), "y": .double(y), "width": .double(width)]
        if let height { object["height"] = .double(height) }
        if !displays.isEmpty {
            object["displays"] = .object(displays.mapValues(\.json))
        }
        return .object(object)
    }

    init(json: JSONValue) throws {
        guard let object = json.objectValue,
            let x = object["x"]?.doubleValue, let y = object["y"]?.doubleValue,
            let width = object["width"]?.doubleValue,
            x.isFinite, y.isFinite, width.isFinite, width > 0
        else {
            throw RPCError.badParams("panelFrame must be null or { x, y, width } with finite numbers and width > 0")
        }
        var height: Double?
        if let raw = object["height"], !raw.isNull {
            guard let value = raw.doubleValue, value.isFinite, value > 0 else {
                throw RPCError.badParams("panelFrame.height must be a positive number when present")
            }
            height = value
        }
        var displays: [String: PanelPoint] = [:]
        if let raw = object["displays"], !raw.isNull {
            guard let map = raw.objectValue else { throw RPCError.badParams("panelFrame.displays must be an object") }
            for (key, value) in map {
                guard let px = value["x"]?.doubleValue, let py = value["y"]?.doubleValue, px.isFinite, py.isFinite else {
                    throw RPCError.badParams("panelFrame.displays values must be { x, y }")
                }
                var pointWidth: Double?
                if let rawWidth = value["width"], !rawWidth.isNull {
                    guard let parsed = rawWidth.doubleValue, parsed.isFinite, parsed > 0 else {
                        throw RPCError.badParams("panelFrame.displays width must be a positive number when present")
                    }
                    pointWidth = parsed
                }
                var pointHeight: Double?
                if let rawHeight = value["height"], !rawHeight.isNull {
                    guard let parsed = rawHeight.doubleValue, parsed.isFinite, parsed > 0 else {
                        throw RPCError.badParams("panelFrame.displays height must be a positive number when present")
                    }
                    pointHeight = parsed
                }
                var pointPlacement: PanelPlacement?
                if let rawPlacement = value["placement"], !rawPlacement.isNull {
                    guard let rawValue = rawPlacement.stringValue, let parsed = PanelPlacement(rawValue: rawValue) else {
                        let names = PanelPlacement.allCases.map(\.rawValue).joined(separator: ", ")
                        throw RPCError.badParams("panelFrame.displays placement must be one of \(names)")
                    }
                    pointPlacement = parsed
                }
                displays[key] = PanelPoint(
                    x: px, y: py, width: pointWidth, height: pointHeight, placement: pointPlacement)
            }
        }
        self.init(x: x, y: y, width: width, height: height, displays: displays)
    }
}

public enum CountMode: String, Sendable, CaseIterable {
    case characters
    case words
}

public struct Settings: Equatable, Sendable {
    public var escapeLosesFocus = false
    public var hideWhileScreenSharing = false
    public var zoom = 1.0
    public var showFormatBar = false
    public var countMode = CountMode.characters
    /// Off by default: the first open uses a roomy fixed size instead.
    public var windowAutoSize = false
    public var panelFrame: PanelFrame?

    public static let zoomRange = 0.75...2.0
    public static let zoomStep = 0.05
    public static let defaults = Settings()

    public init() {}

    /// Every key, in the order used for storage and JSON.
    public static let keys = [
        "escapeLosesFocus", "hideWhileScreenSharing", "zoom", "showFormatBar", "countMode", "windowAutoSize", "panelFrame",
    ]

    public var json: JSONValue {
        .object(Dictionary(uniqueKeysWithValues: Settings.keys.map { ($0, value(forKey: $0)) }))
    }

    func value(forKey key: String) -> JSONValue {
        switch key {
        case "escapeLosesFocus": return .bool(escapeLosesFocus)
        case "hideWhileScreenSharing": return .bool(hideWhileScreenSharing)
        case "zoom": return .double(zoom)
        case "showFormatBar": return .bool(showFormatBar)
        case "countMode": return .string(countMode.rawValue)
        case "windowAutoSize": return .bool(windowAutoSize)
        case "panelFrame": return .optional(panelFrame) { $0.json }
        default: return .null
        }
    }

    /// Applies one key from a `settings.set` patch, validating its type.
    /// `zoom` is snapped to `zoomStep` and clamped into `zoomRange` rather than rejected,
    /// so zoom in and out shortcuts can step past the ends safely.
    mutating func apply(key: String, value: JSONValue) throws {
        func bool() throws -> Bool {
            guard let result = value.boolValue else { throw RPCError.badParams("\(key) must be a boolean") }
            return result
        }
        switch key {
        case "escapeLosesFocus":
            escapeLosesFocus = try bool()
        case "hideWhileScreenSharing":
            hideWhileScreenSharing = try bool()
        case "showFormatBar":
            showFormatBar = try bool()
        case "windowAutoSize":
            windowAutoSize = try bool()
        case "zoom":
            guard let number = value.doubleValue, number.isFinite else {
                throw RPCError.badParams("zoom must be a number")
            }
            zoom = Settings.normalizedZoom(number)
        case "countMode":
            guard let raw = value.stringValue, let mode = CountMode(rawValue: raw) else {
                throw RPCError.badParams("countMode must be \"characters\" or \"words\"")
            }
            countMode = mode
        case "panelFrame":
            panelFrame = value.isNull ? nil : try PanelFrame(json: value)
        default:
            throw RPCError.badParams("Unknown setting: \(key)")
        }
    }

    /// Rounds to the nearest `zoomStep` (avoiding binary noise such as 1.1500000001)
    /// and clamps into `zoomRange`.
    public static func normalizedZoom(_ value: Double) -> Double {
        let steps = (value / zoomStep).rounded()
        let snapped = (steps * zoomStep * 100).rounded() / 100
        return min(max(snapped, zoomRange.lowerBound), zoomRange.upperBound)
    }

    /// Returns a copy with every key in `patch` applied, or throws without partial effects.
    public func applying(_ patch: [String: JSONValue]) throws -> Settings {
        var copy = self
        for key in patch.keys.sorted() {
            if let value = patch[key] {
                try copy.apply(key: key, value: value)
            }
        }
        return copy
    }
}
