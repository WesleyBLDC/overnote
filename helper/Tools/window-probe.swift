// Window server probe for scripts/e2e-window.sh. Compiled on demand with swiftc; not part
// of the package. It only reads public window list metadata, plus Accessibility metadata
// in ax mode.
//
//   window-probe windows <pid>   JSON array of that process's windows (id, layer, onscreen, bounds, sharing)
//   window-probe frontmost       pid of the frontmost application
//   window-probe ax [<pid>]      stable JSON Accessibility report for that process
//   window-probe ax-set <pid> <index> <x> <y> <width> <height>
//       Sets one Accessibility window to a frame given in AppKit global coordinates
//       (bottom left origin, y up, so y is the bottom edge), converting to the
//       Accessibility top left coordinates itself. This is the one mode that writes
//       through Accessibility, and only when a caller asks for it on purpose.
//
// The ax mode is read only by default. It walks the Accessibility window list for the
// given pid and reports, per window, the role, the subrole, whether the position and
// size attributes are settable, and the current position and size when readable. It
// also reports whether this probe process itself is Accessibility trusted, because
// without trust the window list and the settable flags cannot be read. When the
// environment variable WINDOW_PROBE_AX_TRY_SET_SIZE is set to 1, ax mode additionally
// tries to set each window size to the size it already has and reports the result per
// window. That attempt changes nothing visually, still uses only the Accessibility
// API, and stays off unless a caller opts in on purpose. No mode synthesizes global
// input and no mode performs a window server drag.
import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

func axCopy(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else { return nil }
    return value
}

func axString(_ element: AXUIElement, _ attribute: String) -> String? {
    axCopy(element, attribute) as? String
}

func axIsSettable(_ element: AXUIElement, _ attribute: String) -> Bool? {
    var flag: DarwinBoolean = false
    guard AXUIElementIsAttributeSettable(element, attribute as CFString, &flag) == .success else { return nil }
    return flag.boolValue
}

func axPoint(_ element: AXUIElement, _ attribute: String) -> [String: Double]? {
    guard let value = axCopy(element, attribute), CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero
    guard AXValueGetValue(value as! AXValue, .cgPoint, &point) else { return nil }
    return ["x": Double(point.x), "y": Double(point.y)]
}

func axSize(_ element: AXUIElement, _ attribute: String) -> [String: Double]? {
    guard let value = axCopy(element, attribute), CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
    var size = CGSize.zero
    guard AXValueGetValue(value as! AXValue, .cgSize, &size) else { return nil }
    return ["width": Double(size.width), "height": Double(size.height)]
}

func axCurrentSizeValue(_ element: AXUIElement) -> AXValue? {
    guard let value = axCopy(element, kAXSizeAttribute as String), CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
    return (value as! AXValue)
}

func jsonOrNull(_ value: Any?) -> Any {
    value ?? NSNull()
}

func printStableJSON(_ object: [String: Any]) {
    let data = (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data("{}".utf8)
    print(String(decoding: data, as: UTF8.self))
}

func axRow(_ element: AXUIElement, index: Int, trySetSize: Bool) -> [String: Any] {
    let currentSize = axSize(element, kAXSizeAttribute as String)
    var sizeSetAttempted = false
    var sizeSetError: Any = NSNull()
    var sizeSetSucceeded: Any = NSNull()
    if trySetSize, let rawSize = axCurrentSizeValue(element) {
        sizeSetAttempted = true
        let setError = AXUIElementSetAttributeValue(element, kAXSizeAttribute as CFString, rawSize)
        sizeSetError = setError == .success ? NSNull() : Int(setError.rawValue) as Any
        sizeSetSucceeded = setError == .success
    }
    return [
        "index": index,
        "position": jsonOrNull(axPoint(element, kAXPositionAttribute as String)),
        "positionSettable": jsonOrNull(axIsSettable(element, kAXPositionAttribute as String)),
        "role": jsonOrNull(axString(element, kAXRoleAttribute as String)),
        "size": jsonOrNull(currentSize),
        "sizeSetAttempted": sizeSetAttempted,
        "sizeSetError": sizeSetError,
        "sizeSetSucceeded": sizeSetSucceeded,
        "sizeSettable": jsonOrNull(axIsSettable(element, kAXSizeAttribute as String)),
        "subrole": jsonOrNull(axString(element, kAXSubroleAttribute as String)),
    ]
}

func axWindows(pid: Int32) -> (windows: [AXUIElement], error: Any) {
    let application = AXUIElementCreateApplication(pid)
    var copied: CFTypeRef?
    let copyError = AXUIElementCopyAttributeValue(application, kAXWindowsAttribute as CFString, &copied)
    if copyError != .success { return ([], Int(copyError.rawValue)) }
    if let elements = copied as? [AXUIElement] { return (elements, NSNull()) }
    if copied != nil { return ([], Int(AXError.failure.rawValue)) }
    return ([], NSNull())
}

/// Sets one window to an AppKit frame (bottom left origin) through Accessibility,
/// whose position is the top left corner in coordinates below the primary screen's
/// top edge. Position is set, then size, then position again, because a size set
/// can leave the top left corner wherever the window manager anchored the resize.
func runAXSetMode(arguments: [String]) {
    guard arguments.count >= 8, let pid = Int32(arguments[2]), let index = Int(arguments[3]),
        let x = Double(arguments[4]), let y = Double(arguments[5]),
        let width = Double(arguments[6]), let height = Double(arguments[7]),
        x.isFinite, y.isFinite, width > 0, height > 0
    else { exit(64) }
    let trusted = AXIsProcessTrusted()
    let (elements, windowsError) = axWindows(pid: pid)
    var before: Any = NSNull()
    var after: Any = NSNull()
    var positionSetError: Any = NSNull()
    var sizeSetError: Any = NSNull()
    var attempted = false
    if elements.indices.contains(index) {
        let element = elements[index]
        before = axRow(element, index: index, trySetSize: false)
        attempted = true
        let primaryHeight = Double(NSScreen.screens.first?.frame.height ?? 0)
        let top = y + height
        var axPosition = CGPoint(x: x, y: primaryHeight - top)
        var axSizeValue = CGSize(width: width, height: height)
        if let positionValue = AXValueCreate(.cgPoint, &axPosition) {
            let error = AXUIElementSetAttributeValue(element, kAXPositionAttribute as CFString, positionValue)
            if error != .success { positionSetError = Int(error.rawValue) }
        }
        if let sizeValue = AXValueCreate(.cgSize, &axSizeValue) {
            let error = AXUIElementSetAttributeValue(element, kAXSizeAttribute as CFString, sizeValue)
            if error != .success { sizeSetError = Int(error.rawValue) }
        }
        if let positionValue = AXValueCreate(.cgPoint, &axPosition) {
            let error = AXUIElementSetAttributeValue(element, kAXPositionAttribute as CFString, positionValue)
            if error != .success, positionSetError is NSNull { positionSetError = Int(error.rawValue) }
        }
        after = axRow(element, index: index, trySetSize: false)
    }
    printStableJSON([
        "accessibilityTrusted": trusted,
        "after": after,
        "before": before,
        "index": index,
        "pid": Int(pid),
        "positionSetAttempted": attempted,
        "positionSetError": positionSetError,
        "requestedAppKitFrame": ["height": height, "width": width, "x": x, "y": y],
        "sizeSetAttempted": attempted,
        "sizeSetError": sizeSetError,
        "windowsError": windowsError,
    ])
}

func runAXMode(arguments: [String]) {
    let trySetSize = ProcessInfo.processInfo.environment["WINDOW_PROBE_AX_TRY_SET_SIZE"] == "1"
    let trusted = AXIsProcessTrusted()
    var pidValue: Any = NSNull()
    var windowsError: Any = NSNull()
    var rows: [[String: Any]] = []
    if arguments.count >= 3 {
        guard let pid = Int32(arguments[2]) else { exit(64) }
        pidValue = Int(pid)
        let (elements, error) = axWindows(pid: pid)
        windowsError = error
        rows = elements.enumerated().map { axRow($0.element, index: $0.offset, trySetSize: trySetSize) }
    }
    printStableJSON([
        "accessibilityTrusted": trusted,
        "pid": pidValue,
        "trySetSize": trySetSize,
        "windows": rows,
        "windowsError": windowsError,
    ])
}

let arguments = CommandLine.arguments
guard arguments.count >= 2 else {
    FileHandle.standardError.write(Data("usage: window-probe windows <pid> | frontmost | ax [<pid>] | ax-set <pid> <index> <x> <y> <width> <height>\n".utf8))
    exit(64)
}

switch arguments[1] {
case "frontmost":
    print(NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1)
case "windows":
    guard arguments.count >= 3, let pid = Int32(arguments[2]) else { exit(64) }
    let list = (CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]]) ?? []
    var rows: [[String: Any]] = []
    for window in list where (window[kCGWindowOwnerPID as String] as? Int32) == pid {
        let bounds = window[kCGWindowBounds as String] as? [String: Any] ?? [:]
        rows.append([
            "id": window[kCGWindowNumber as String] as? Int ?? 0,
            "layer": window[kCGWindowLayer as String] as? Int ?? 0,
            "onscreen": window[kCGWindowIsOnscreen as String] as? Bool ?? false,
            "sharing": window[kCGWindowSharingState as String] as? Int ?? -1,
            "x": bounds["X"] as? Double ?? 0, "y": bounds["Y"] as? Double ?? 0,
            "width": bounds["Width"] as? Double ?? 0, "height": bounds["Height"] as? Double ?? 0,
        ])
    }
    let data = (try? JSONSerialization.data(withJSONObject: rows)) ?? Data("[]".utf8)
    print(String(decoding: data, as: UTF8.self))
case "ax":
    runAXMode(arguments: arguments)
case "ax-set":
    runAXSetMode(arguments: arguments)
default:
    exit(64)
}
