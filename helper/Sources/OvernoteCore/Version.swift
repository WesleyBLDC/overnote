/// The helper version reported by `--version` and `system.ping`.
///
/// Keep this in sync with `helper/VERSION`; the extension restarts a running helper whose
/// version differs from the one it ships with.
public enum HelperVersion {
    public static let current = "0.2.0"
}
