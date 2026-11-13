import Darwin
import Foundation
import SQLite3

/// The one time move to the shared data folder (docs/architecture.md section 9).
///
/// Extension releases before the shared folder kept `notes.sqlite` in Raycast's support folder.
/// At startup, when the shared folder has no database and the legacy folder has one, the helper
/// copies it with SQLite's online backup API and continues. The legacy file is only read: it is
/// never deleted or modified, so an older release still finds its notes there.
public enum LegacyMigration {
    public enum Decision: Equatable, Sendable {
        case copy(from: String)
        /// The shared folder already has a database; nothing to do, ever again.
        case alreadyMigrated
        /// No legacy folder was given, or it is the shared folder itself.
        case noLegacyFolder
        /// The legacy folder has no database to copy.
        case nothingToCopy
    }

    public static let databaseName = "notes.sqlite"

    public static func decide(supportDir: String, legacySupportDir: String?, fileExists: (String) -> Bool) -> Decision {
        let target = (supportDir as NSString).appendingPathComponent(databaseName)
        if fileExists(target) { return .alreadyMigrated }
        guard let legacySupportDir,
            (legacySupportDir as NSString).standardizingPath != (supportDir as NSString).standardizingPath
        else { return .noLegacyFolder }
        let source = (legacySupportDir as NSString).appendingPathComponent(databaseName)
        return fileExists(source) ? .copy(from: source) : .nothingToCopy
    }

    /// Copies `source` to `<supportDir>/notes.sqlite` through a hidden partial file renamed into
    /// place, so an interrupted copy never looks like a migrated database.
    public static func copy(from source: String, toSupportDir supportDir: String) throws {
        let target = (supportDir as NSString).appendingPathComponent(databaseName)
        let partial = (supportDir as NSString).appendingPathComponent(".\(databaseName).migrating")
        func removePartial() {
            for suffix in ["", "-wal", "-shm", "-journal"] { unlink(partial + suffix) }
        }
        removePartial()
        defer { removePartial() }
        let legacy = try SQLiteDatabase(path: source, readOnly: true)
        defer { legacy.close() }
        let fd = open(partial, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw SQLiteError(code: SQLITE_CANTOPEN, message: "Cannot create \(partial)") }
        close(fd)
        let copy = try SQLiteDatabase(path: partial)
        do {
            try legacy.copy(into: copy)
            // Rollback journal mode makes the copy one self contained file; the repository
            // switches it back to WAL when it opens it.
            try copy.execute("PRAGMA journal_mode = DELETE")
            copy.close()
        } catch {
            copy.close()
            throw error
        }
        guard rename(partial, target) == 0 else {
            throw SQLiteError(code: SQLITE_IOERR, message: "Cannot move the copy to \(target)")
        }
    }
}
