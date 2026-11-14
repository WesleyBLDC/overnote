import Darwin
import Foundation

/// Which packaging runs this process (docs/architecture.md section 1).
///
/// One binary ships twice: inside the Raycast extension (`assets/bin/OvernoteHelper`) and as
/// `Overnote.app`. App mode turns on when the process runs from the app bundle, or with `--app`.
public enum HelperHostKind: String, Sendable {
    case app
    case `extension`
}

/// What the process knows about where it runs, read once at startup. Tests pass their own.
public struct LaunchContext: Equatable, Sendable {
    /// `CFBundleIdentifier` of `Bundle.main`, nil for a bare executable.
    public var bundleIdentifier: String?
    /// `Bundle.main.resourcePath` when the process runs from a bundle.
    public var resourcePath: String?
    public var home: String
    public var uid: uid_t

    public init(bundleIdentifier: String?, resourcePath: String?, home: String, uid: uid_t) {
        self.bundleIdentifier = bundleIdentifier
        self.resourcePath = resourcePath
        self.home = home
        self.uid = uid
    }

    public static var current: LaunchContext {
        let environmentHome = ProcessInfo.processInfo.environment["HOME"].flatMap { $0.isEmpty ? nil : $0 }
        return LaunchContext(
            bundleIdentifier: Bundle.main.bundleIdentifier,
            resourcePath: Bundle.main.bundleIdentifier == nil ? nil : Bundle.main.resourcePath,
            home: environmentHome ?? NSHomeDirectory(),
            uid: getuid())
    }

    /// True inside `Overnote.app`.
    public var isAppBundle: Bool { bundleIdentifier == AppMode.bundleIdentifier }
}

public enum AppMode {
    /// `CFBundleIdentifier` of `Overnote.app` (scripts/build-app.sh writes it into Info.plist).
    public static let bundleIdentifier = "com.wesleybldc.overnote"

    /// The one data folder both packagings share: `~/Library/Application Support/Overnote`.
    public static func supportDirectory(home: String) -> String {
        (home as NSString).appendingPathComponent("Library/Application Support/Overnote")
    }
}
