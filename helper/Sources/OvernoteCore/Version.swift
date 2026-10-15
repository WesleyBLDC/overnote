/// The helper version reported by `--version` and `system.ping`.
///
/// Keep this in sync with `helper/VERSION`; the extension restarts a running helper whose
/// version differs from the one it ships with.
public enum HelperVersion {
    public static let current = "0.3.0"

    /// The database schema this helper writes (`PRAGMA user_version`), printed by
    /// `--schema-version` and recorded per release in `assets/prebuilt.json`.
    public static var schemaVersion: Int { Migrations.latestVersion }
}
