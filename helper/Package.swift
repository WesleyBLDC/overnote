// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "BetterNotesHelper",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "BetterNotesHelper", targets: ["BetterNotesHelper"]),
        .library(name: "BetterNotesCore", targets: ["BetterNotesCore"]),
    ],
    targets: [
        // Everything that does not need AppKit or WebKit: storage, RPC, sockets, lifecycle utilities.
        .target(
            name: "BetterNotesCore",
            linkerSettings: [.linkedLibrary("sqlite3")]
        ),
        // The accessory app: floating panel, WKWebView host, bridge, and process lifecycle.
        .executableTarget(
            name: "BetterNotesHelper",
            dependencies: ["BetterNotesCore"],
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("WebKit"),
            ]
        ),
        // swift-testing suite. With only the Command Line Tools, run it through ./test.sh,
        // which adds the framework search paths that SwiftPM does not add on its own.
        .testTarget(
            name: "BetterNotesCoreTests",
            dependencies: ["BetterNotesCore"]
        ),
    ]
)
