import Foundation

/// The panel position the helper remembers. `y` is the **top** edge in AppKit global
/// coordinates (origin at the bottom left of the primary screen), because the height is
/// content driven and the top edge is what stays put while it changes.
/// `height` is stored only when `windowAutoSize` is off and the user sized the panel.
public struct PanelFrame: Equatable, Sendable {
    public var x: Double
    public var y: Double
    public var width: Double
    public var height: Double?

    public init(x: Double, y: Double, width: Double, height: Double? = nil) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }

    public var json: JSONValue {
        var object: [String: JSONValue] = ["x": .double(x), "y": .double(y), "width": .double(width)]
        if let height { object["height"] = .double(height) }
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
        self.init(x: x, y: y, width: width, height: height)
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
    public var windowAutoSize = true
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
