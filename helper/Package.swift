// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "OvernoteHelper",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "OvernoteHelper", targets: ["OvernoteHelper"]),
        .library(name: "OvernoteCore", targets: ["OvernoteCore"]),
    ],
    targets: [
        // Everything that does not need AppKit or WebKit: storage, RPC, sockets, lifecycle utilities.
        .target(
            name: "OvernoteCore",
            linkerSettings: [.linkedLibrary("sqlite3")]
        ),
        // The accessory app: floating panel, WKWebView host, bridge, and process lifecycle.
        .executableTarget(
            name: "OvernoteHelper",
            dependencies: ["OvernoteCore"],
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("WebKit"),
            ]
        ),
        // swift-testing suite. With only the Command Line Tools, run it through ./test.sh,
        // which adds the framework search paths that SwiftPM does not add on its own.
        .testTarget(
            name: "OvernoteCoreTests",
            dependencies: ["OvernoteCore"]
        ),
    ]
)
