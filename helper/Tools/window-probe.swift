// Window server probe for scripts/e2e-window.sh. Compiled on demand with swiftc; not part
// of the package. It only reads public window list metadata.
//
//   window-probe windows <pid>   JSON array of that process's windows (id, layer, onscreen, bounds, sharing)
//   window-probe frontmost       pid of the frontmost application
import AppKit
import CoreGraphics
import Foundation

let arguments = CommandLine.arguments
guard arguments.count >= 2 else {
    FileHandle.standardError.write(Data("usage: window-probe windows <pid> | frontmost\n".utf8))
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
default:
    exit(64)
}
