import Foundation

/// A remembered top left point on one display. `y` is the **top** edge.
/// After `window.place` it also carries the placed `width` and `height` and the `placement`,
/// which the next open on that display runs again. A point without them (every point stored
/// before `window.place` existed) reads and writes back exactly as it was.
public struct PanelPoint: Equatable, Sendable {
    public var x: Double
    public var y: Double
    public var width: Double?
    public var height: Double?
    public var placement: PanelPlacement?

    public init(x: Double, y: Double, width: Double? = nil, height: Double? = nil, placement: PanelPlacement? = nil) {
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

    init(json value: JSONValue) throws {
        guard let x = value["x"]?.doubleValue, let y = value["y"]?.doubleValue, x.isFinite, y.isFinite else {
            throw RPCError.badParams("panelFrame.displays values must be { x, y }")
        }
        func size(_ key: String) throws -> Double? {
            guard let raw = value[key], !raw.isNull else { return nil }
            guard let number = raw.doubleValue, number.isFinite, number > 0 else {
                throw RPCError.badParams("panelFrame.displays \(key) must be a positive number when present")
            }
            return number
        }
        var placement: PanelPlacement?
        if let raw = value["placement"], !raw.isNull {
            guard let name = raw.stringValue, let parsed = PanelPlacement(rawValue: name) else {
                throw RPCError.badParams("panelFrame.displays placement must be left, right, fill, or center")
            }
            placement = parsed
        }
        self.init(x: x, y: y, width: try size("width"), height: try size("height"), placement: placement)
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
///   `"<display uuid>@<width>x<height>"` (the display identity plus its size in points), with
///   the placed size and placement after `window.place`.
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
                displays[key] = try PanelPoint(json: value)
            }
        }
        self.init(x: x, y: y, width: width, height: height, displays: displays)
    }
}

public enum CountMode: String, Sendable, CaseIterable {
    case characters
    case words
    /// Hides the corner count (v3.8).
    case off
}

/// The panel's appearance (v3.8): follow the system, or force light or dark.
public enum Appearance: String, Sendable, CaseIterable {
    case auto
    case light
    case dark
}

/// The interface font (v3.8): the bundled Geist, or the system font.
public enum InterfaceFont: String, Sendable, CaseIterable {
    case geist
    case system
}

public struct Settings: Equatable, Sendable {
    public var escapeLosesFocus = false
    public var hideWhileScreenSharing = false
    public var zoom = 1.0
    public var showFormatBar = false
    public var countMode = CountMode.words
    public var appearance = Appearance.auto
    /// On by default: the panel floats above other apps' windows.
    public var floatOnTop = true
    /// On by default: the panel shows on every Space.
    public var allSpaces = true
    public var font = InterfaceFont.geist
    public var spellcheck = true
    public var smartTypography = true
    /// Off by default: the first open uses a roomy fixed size instead.
    public var windowAutoSize = false
    public var panelFrame: PanelFrame?
    /// Whether the terminal drawer is open (`terminal: { open }`), so it reopens after a restart.
    public var terminalOpen = false
    /// Search's sort menu (`searchSort: { field, direction, pinnedFirst }`); the design's default is Modified.
    public var searchSort = BrowseOrder(field: .modified, direction: .desc, pinnedFirst: true)

    public static let zoomRange = 0.75...2.0
    public static let zoomStep = 0.05
    public static let defaults = Settings()

    public init() {}

    /// Every key, in the order used for storage and JSON.
    public static let keys = [
        "escapeLosesFocus", "hideWhileScreenSharing", "zoom", "showFormatBar", "countMode", "appearance", "floatOnTop",
        "allSpaces", "font", "spellcheck", "smartTypography", "windowAutoSize", "panelFrame", "terminal", "searchSort",
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
        case "appearance": return .string(appearance.rawValue)
        case "floatOnTop": return .bool(floatOnTop)
        case "allSpaces": return .bool(allSpaces)
        case "font": return .string(font.rawValue)
        case "spellcheck": return .bool(spellcheck)
        case "smartTypography": return .bool(smartTypography)
        case "windowAutoSize": return .bool(windowAutoSize)
        case "panelFrame": return .optional(panelFrame) { $0.json }
        case "terminal": return ["open": .bool(terminalOpen)]
        case "searchSort":
            return [
                "field": .string(searchSort.field.rawValue), "direction": .string(searchSort.direction.rawValue),
                "pinnedFirst": .bool(searchSort.pinnedFirst),
            ]
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
        func choice<T: RawRepresentable & CaseIterable>(_: T.Type) throws -> T where T.RawValue == String {
            guard let raw = value.stringValue, let result = T(rawValue: raw) else {
                let names = T.allCases.map { "\"\($0.rawValue)\"" }.joined(separator: ", ")
                throw RPCError.badParams("\(key) must be one of \(names)")
            }
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
            countMode = try choice(CountMode.self)
        case "appearance":
            appearance = try choice(Appearance.self)
        case "font":
            font = try choice(InterfaceFont.self)
        case "floatOnTop":
            floatOnTop = try bool()
        case "allSpaces":
            allSpaces = try bool()
        case "spellcheck":
            spellcheck = try bool()
        case "smartTypography":
            smartTypography = try bool()
        case "panelFrame":
            panelFrame = value.isNull ? nil : try PanelFrame(json: value)
        case "terminal":
            guard let object = value.objectValue, object.count == 1, let open = object["open"]?.boolValue else {
                throw RPCError.badParams("terminal must be { open: boolean }")
            }
            terminalOpen = open
        case "searchSort":
            guard let object = value.objectValue, object.count == 3, let pinnedFirst = object["pinnedFirst"]?.boolValue,
                let order = try? BrowseOrder(sort: value, pinnedFirst: pinnedFirst)
            else {
                throw RPCError.badParams("searchSort must be { field, direction, pinnedFirst }")
            }
            searchSort = order
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
