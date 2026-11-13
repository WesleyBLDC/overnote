import Darwin
import Foundation
import SQLite3

/// The one time move to the shared data folder (docs/architecture.md section 9).
///
/// Extension releases before the shared folder kept `notes.sqlite` in Raycast's support folder.
/// A shared database that holds no note at all, live or deleted, counts as not migrated yet:
/// Overnote.app may have created it empty before the extension ever passed its old folder.
/// The legacy file is only read: it is never deleted or modified, so an older release still
/// finds its notes there.
public enum LegacyMigration {
    public enum Decision: Equatable, Sendable {
        /// No shared database yet: copy the legacy file into place before opening it.
        case copy(from: String)
        /// The shared database holds no note and the legacy one does: back up the shared one,
        /// then copy the legacy one into its live connection.
        case importInto(from: String)
        /// The shared database holds a note (or cannot be read, so it might); never touch it.
        case alreadyMigrated
        /// No legacy folder was given, or it is the shared folder itself.
        case noLegacyFolder
        /// The legacy folder has no database to copy, or one with no note to import.
        case nothingToCopy
    }

    public static let databaseName = "notes.sqlite"

    /// `holdsNotes` answers whether the database at a path holds any note, live or deleted, or
    /// nil when it cannot be read. An unreadable shared database counts as holding notes, and an
    /// unreadable legacy one as holding none, so a doubt never overwrites anything.
    public static func decide(
        supportDir: String, legacySupportDir: String?, fileExists: (String) -> Bool, holdsNotes: (String) -> Bool?
    ) -> Decision {
        guard let legacySupportDir,
            (legacySupportDir as NSString).standardizingPath != (supportDir as NSString).standardizingPath
        else { return .noLegacyFolder }
        let target = (supportDir as NSString).appendingPathComponent(databaseName)
        let source = (legacySupportDir as NSString).appendingPathComponent(databaseName)
        guard fileExists(target) else { return fileExists(source) ? .copy(from: source) : .nothingToCopy }
        if holdsNotes(target) ?? true { return .alreadyMigrated }
        guard fileExists(source), holdsNotes(source) == true else { return .nothingToCopy }
        return .importInto(from: source)
    }

    /// Whether the database at `path` holds any note, live or deleted; nil when it cannot be
    /// opened read only or has no notes table.
    public static func holdsNotes(at path: String) -> Bool? {
        guard let database = try? SQLiteDatabase(path: path, readOnly: true) else { return nil }
        defer { database.close() }
        return (try? database.queryFirst("SELECT EXISTS (SELECT 1 FROM notes)") { $0.int(0) != 0 }) ?? nil
    }

    /// What `importLegacy` did.
    public struct ImportOutcome: Sendable {
        public var decision: Decision
        /// The backup of the empty shared database, written before the import.
        public var backup: BackupInfo?
        /// Every note id after the import; nil when nothing was imported.
        public var ids: [String]?
        public var imported: Bool { ids != nil }
    }

    /// Imports `<legacySupportDir>/notes.sqlite` into the open shared database when, and only
    /// when, the shared one holds no note and the legacy one holds at least one. Backs up the
    /// shared database first (reason `pre-import`), then copies the legacy one into the live
    /// connection the way a restore does. The emptiness check is repeated under the
    /// repository's lock, so a note written meanwhile is never overwritten.
    public static func importLegacy(
        legacySupportDir: String, into repository: NotesRepository, backups: BackupStore?
    ) throws -> ImportOutcome {
        let supportDir = (repository.databasePath as NSString).deletingLastPathComponent
        let decision = decide(
            supportDir: supportDir, legacySupportDir: legacySupportDir,
            fileExists: { FileManager.default.fileExists(atPath: $0) },
            holdsNotes: { path in
                path == repository.databasePath ? (try? repository.holdsAnyNote()) : holdsNotes(at: path)
            })
        let source: String
        switch decision {
        case .importInto(let path), .copy(let path): source = path
        default: return ImportOutcome(decision: decision)
        }
        let backup = try backups?.create(reason: .preImport) { try repository.backup(to: $0) }
        guard let ids = try repository.restoreIntoEmpty(from: source) else {
            return ImportOutcome(decision: .alreadyMigrated, backup: backup)
        }
        return ImportOutcome(decision: .importInto(from: source), backup: backup, ids: ids)
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
