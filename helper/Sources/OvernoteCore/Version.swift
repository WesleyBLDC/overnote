/// The helper version reported by `--version` and `system.ping`.
///
/// `HelperVersion.current` is generated from `helper/VERSION` into
/// `GeneratedVersion.swift` by `scripts/generate-helper-version.sh`, which the build
/// runs before SwiftPM compiles. The extension restarts a running helper whose version
/// differs from the one it ships with.
public enum HelperVersion {
    /// The database schema this helper writes (`PRAGMA user_version`), printed by
    /// `--schema-version` and recorded per release in `assets/prebuilt.json`.
    public static var schemaVersion: Int { Migrations.latestVersion }
}
