import Foundation

/// Owns `notes.sqlite`: every write in the system goes through here.
///
/// All calls are serialized by a lock, so the repository is safe to use from the socket
/// threads and the main thread at once. SQLite calls are short and local, so a lock is
/// simpler and cheaper here than an actor hop. Every write that changes `title` or `text`
/// also writes the folded copies used for filtering, in the same statement.
///
/// Errors thrown are always `RPCError`; SQLite failures surface as code 500.
public final class NotesRepository: @unchecked Sendable {
    public typealias Clock = @Sendable () -> Millis

    /// Trashed notes deleted strictly before `now - trashRetention` are purged.
    public static let trashRetention: Millis = 60 * 24 * 60 * 60 * 1000
    public static let defaultListLimit = 100
    public static let maxListLimit = 1000
    /// Gap between pin keys; the first pin gets this key.
    public static let pinSpacing = 1000.0
    /// Settings key holding the persisted current note id.
    static let currentNoteKey = "currentNoteId"

    private let lock = NSLock()
    private let db: SQLiteDatabase
    private let clock: Clock
    private var ulid = ULIDGenerator()

    public static let systemClock: Clock = { Millis((Date().timeIntervalSince1970 * 1000).rounded(.down)) }

    /// Opens (creating if needed) the database at `path` and migrates it to the latest schema.
    /// With `backups`, a database that holds notes is backed up (reason `pre-migration`) before
    /// any migration runs; if that backup fails, the migration does not run.
    public init(path: String, clock: @escaping Clock = NotesRepository.systemClock, backups: BackupStore? = nil) throws {
        self.clock = clock
        do {
            db = try SQLiteDatabase(path: path)
            try db.execute("PRAGMA journal_mode = WAL")
            try db.execute("PRAGMA synchronous = NORMAL")
            try db.execute("PRAGMA foreign_keys = ON")
            let current = try db.userVersion
            if let backups, current > 0, current < Migrations.latestVersion, try Self.holdsNotes(db) {
                _ = try backups.create(reason: .preMigration) { try Self.write(db, to: $0) }
            }
            try Migrations.migrate(db)
        } catch let error as Migrations.NewerSchemaError {
            throw RPCError.internal(error.description)
        } catch {
            throw RPCError.internal("Cannot open database at \(path): \(error)")
        }
    }

    public func close() {
        lock.withLock { db.close() }
    }

    /// The schema version recorded in the database.
    public func schemaVersion() throws -> Int {
        try locked { try db.userVersion }
    }

    // MARK: - Locking and error mapping

    private func locked<T>(_ body: () throws -> T) throws -> T {
        lock.lock()
        defer { lock.unlock() }
        do {
            return try body()
        } catch let error as RPCError {
            throw error
        } catch {
            throw RPCError.internal("\(error)")
        }
    }

    private func transaction<T>(_ body: () throws -> T) throws -> T {
        try locked { try db.transaction(body) }
    }

    // MARK: - Row mapping

    private static let noteColumns =
        "id, title, text, markdown, raw_content, pinned, created_at, updated_at, deleted_at, last_accessed_at, caret_position"

    /// Columns 0 through 8, read by `readSummary`.
    private static let summaryColumns = """
        id, title, substr(text, 1, \(NoteSummary.previewLength)), length(text), pinned, created_at, updated_at, \
        deleted_at, last_accessed_at
        """

    private static func readNote(_ row: Statement) -> Note {
        Note(
            id: row.text(0),
            content: NoteContent(rawContent: row.text(4), markdown: row.text(3), text: row.text(2), title: row.text(1)),
            pinned: row.optionalDouble(5),
            createdAt: row.int(6),
            updatedAt: row.int(7),
            deletedAt: row.optionalInt(8),
            lastAccessedAt: row.optionalInt(9),
            caretPosition: row.optionalInt(10)
        )
    }

    private static func readSummary(_ row: Statement) -> NoteSummary {
        NoteSummary(
            id: row.text(0),
            title: row.text(1),
            preview: row.text(2),
            charCount: Int(row.int(3)),
            pinned: row.optionalDouble(4),
            createdAt: row.int(5),
            updatedAt: row.int(6),
            deletedAt: row.optionalInt(7),
            lastAccessedAt: row.optionalInt(8)
        )
    }

    // MARK: - Internal helpers (call with the lock held)

    private func fetchNote(_ id: String) throws -> Note? {
        try db.queryFirst("SELECT \(Self.noteColumns) FROM notes WHERE id = ?", [.text(id)], map: Self.readNote)
    }

    private func requireNote(_ id: String) throws -> Note {
        guard let note = try fetchNote(id) else { throw RPCError.noteNotFound(id) }
        return note
    }

    private func requireLiveNote(_ id: String) throws -> Note {
        let note = try requireNote(id)
        guard note.deletedAt == nil else { throw RPCError.conflict("Note is in Recently Deleted: \(id)") }
        return note
    }

    /// Inserts a live, unpinned note with every timestamp at `now` and the caret at 0.
    private func insertNote(_ content: NoteContent, now: Millis) throws -> String {
        let id = ulid.next(now: now)
        try db.run(
            """
            INSERT INTO notes (id, title, text, markdown, raw_content, title_fold, text_fold, pinned,
                               created_at, updated_at, deleted_at, last_accessed_at, caret_position)
            VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, ?, 0)
            """,
            [
                .text(id), .text(content.title), .text(content.text), .text(content.markdown), .text(content.rawContent),
                .text(TextFolding.fold(content.title)), .text(TextFolding.fold(content.text)),
                .int(now), .int(now), .int(now),
            ]
        )
        return id
    }

    private func persistCurrentNote(_ id: String) throws {
        try db.run(
            "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
            [.text(Self.currentNoteKey), .text(JSONValue.string(id).serialized())])
    }

    private func storedCurrentNoteId() throws -> String? {
        let raw = try db.queryFirst("SELECT value FROM settings WHERE key = ?", [.text(Self.currentNoteKey)]) { $0.text(0) }
        return raw.flatMap { try? JSONValue.parse($0) }?.stringValue
    }

    // MARK: - CRUD

    /// Creates a note. It becomes the persisted current note only when `makeCurrent` is true (a
    /// create that shows the panel), so a background write never moves the note the panel opens on.
    public func create(_ content: NoteContent, makeCurrent: Bool = false) throws -> Note {
        try transaction {
            let id = try insertNote(content, now: clock())
            if makeCurrent {
                try persistCurrentNote(id)
            }
            return try requireNote(id)
        }
    }

    /// Returns a note, including a trashed one. Throws 404 when it does not exist.
    public func get(_ id: String) throws -> Note {
        try locked { try requireNote(id) }
    }

    /// Applies a partial update (protocol `notes.update`).
    ///
    /// - A patch with content fields writes them and sets `updatedAt` to now, even when the
    ///   content is identical. Within the same millisecond it steps 1 ms past the old value
    ///   so `expectedUpdatedAt` checks always see a change.
    /// - A caret only patch writes the caret for live notes only and never moves `updatedAt`.
    /// - With `expectedUpdatedAt` set and different from the stored value, nothing is
    ///   written and the stored note comes back as a conflict.
    public func update(_ id: String, _ patch: NotePatch) throws -> UpdateResult {
        try transaction {
            let existing = try requireNote(id)
            if let expected = patch.expectedUpdatedAt, expected != existing.updatedAt {
                return .conflict(existing)
            }
            if patch.hasContent {
                var content = existing.content
                if let value = patch.rawContent { content.rawContent = value }
                if let value = patch.markdown { content.markdown = value }
                if let value = patch.text { content.text = value }
                if let value = patch.title { content.title = value }
                let updatedAt = max(clock(), existing.updatedAt + 1)
                try db.run(
                    """
                    UPDATE notes SET title = ?, text = ?, markdown = ?, raw_content = ?, title_fold = ?, text_fold = ?,
                                     updated_at = ?, caret_position = COALESCE(?, caret_position)
                    WHERE id = ?
                    """,
                    [
                        .text(content.title), .text(content.text), .text(content.markdown), .text(content.rawContent),
                        .text(TextFolding.fold(content.title)), .text(TextFolding.fold(content.text)),
                        .int(updatedAt), patch.caretPosition.map(SQLValue.int) ?? .null, .text(id),
                    ]
                )
            } else if let caret = patch.caretPosition {
                try db.run(
                    "UPDATE notes SET caret_position = ? WHERE id = ? AND deleted_at IS NULL", [.int(caret), .text(id)])
            }
            return .ok(try requireNote(id))
        }
    }

    /// Moves a live note to the trash: sets `deletedAt`, clears the pin, and steps `updatedAt`
    /// by 1 ms so the note keeps its place in the window order. No effect on a trashed note.
    public func delete(_ id: String) throws {
        try transaction {
            _ = try requireNote(id)
            try db.run(
                "UPDATE notes SET deleted_at = ?, pinned = NULL, updated_at = updated_at + 1 WHERE id = ? AND deleted_at IS NULL",
                [.int(clock()), .text(id)])
        }
    }

    /// Trashes every live note the same way as `delete`. Returns the ids that moved.
    public func deleteAll() throws -> [String] {
        try transaction {
            let ids = try db.query("SELECT id FROM notes WHERE deleted_at IS NULL") { $0.text(0) }
            try db.run(
                "UPDATE notes SET deleted_at = ?, pinned = NULL, updated_at = updated_at + 1 WHERE deleted_at IS NULL",
                [.int(clock())])
            return ids
        }
    }

    /// Restores a trashed note (its pin stays cleared) and steps `updatedAt` by 1 ms.
    /// No effect on a live note.
    public func recover(_ id: String) throws -> Note {
        try transaction {
            _ = try requireNote(id)
            try db.run(
                "UPDATE notes SET deleted_at = NULL, updated_at = updated_at + 1 WHERE id = ? AND deleted_at IS NOT NULL",
                [.text(id)])
            return try requireNote(id)
        }
    }

    /// Removes a trashed note for good. A live note is left untouched.
    /// Returns true when a row was removed.
    @discardableResult
    public func permanentlyDelete(_ id: String) throws -> Bool {
        try transaction {
            _ = try requireNote(id)
            return try db.run("DELETE FROM notes WHERE id = ? AND deleted_at IS NOT NULL", [.text(id)]) > 0
        }
    }

    /// Permanently removes every trashed note. Returns the removed ids.
    public func emptyTrash() throws -> [String] {
        try transaction { try purge(where: "deleted_at IS NOT NULL", []) }
    }

    /// Permanently removes notes whose `deletedAt` is strictly older than now minus 60 days.
    /// Returns the removed ids.
    @discardableResult
    public func purgeExpiredTrash() throws -> [String] {
        try transaction {
            let cutoff = clock() - Self.trashRetention
            return try purge(where: "deleted_at IS NOT NULL AND deleted_at < ?", [.int(cutoff)])
        }
    }

    private func purge(where condition: String, _ values: [SQLValue]) throws -> [String] {
        let ids = try db.query("SELECT id FROM notes WHERE \(condition)", values) { $0.text(0) }
        guard !ids.isEmpty else { return [] }
        try db.run("DELETE FROM notes WHERE \(condition)", values)
        return ids
    }

    /// Copies a note's content into a new live note with fresh timestamps, no pin, and caret 0.
    /// `titleSuffix`, when given, is appended to the stored title only. The current note does not
    /// change; a caller that opens the copy persists it with `setCurrentNote`.
    public func duplicate(_ id: String, titleSuffix: String? = nil) throws -> Note {
        try transaction {
            var content = try requireNote(id).content
            if let titleSuffix {
                content.title += titleSuffix
            }
            let newId = try insertNote(content, now: clock())
            return try requireNote(newId)
        }
    }

    /// The number of live notes.
    public func count() throws -> Int {
        try locked {
            Int(try db.queryFirst("SELECT count(*) FROM notes WHERE deleted_at IS NULL") { $0.int(0) } ?? 0)
        }
    }

    // MARK: - Pins (never touch updatedAt)

    /// Appends a live note to the end of the pinned list (largest key plus 1000, first pin 1000).
    /// Pinning an already pinned note keeps its place.
    public func pin(_ id: String) throws -> Note {
        try transaction {
            let note = try requireLiveNote(id)
            if note.pinned == nil {
                let maxKey = try db.queryFirst("SELECT max(pinned) FROM notes WHERE pinned IS NOT NULL") {
                    $0.optionalDouble(0)
                } ?? nil
                try db.run(
                    "UPDATE notes SET pinned = ? WHERE id = ?",
                    [.double((maxKey ?? 0) + Self.pinSpacing), .text(id)])
            }
            return try requireNote(id)
        }
    }

    public func unpin(_ id: String) throws -> Note {
        try transaction {
            _ = try requireNote(id)
            try db.run("UPDATE notes SET pinned = NULL WHERE id = ?", [.text(id)])
            return try requireNote(id)
        }
    }

    public enum PinMove: Sendable {
        case up
        case down
    }

    /// Swaps a pinned note's key with its neighbor in pin order. No-op at either end.
    /// Throws 409 when the note is not a live pinned note.
    public func movePinned(_ id: String, _ move: PinMove) throws {
        try transaction {
            let note = try requireLiveNote(id)
            guard let key = note.pinned else { throw RPCError.conflict("Note is not pinned: \(id)") }
            let sql =
                switch move {
                case .up:
                    """
                    SELECT id, pinned FROM notes WHERE deleted_at IS NULL AND pinned IS NOT NULL
                      AND (pinned < ?1 OR (pinned = ?1 AND id < ?2)) ORDER BY pinned DESC, id DESC LIMIT 1
                    """
                case .down:
                    """
                    SELECT id, pinned FROM notes WHERE deleted_at IS NULL AND pinned IS NOT NULL
                      AND (pinned > ?1 OR (pinned = ?1 AND id > ?2)) ORDER BY pinned ASC, id ASC LIMIT 1
                    """
                }
            guard let neighbor = try db.queryFirst(sql, [.double(key), .text(id)], map: { ($0.text(0), $0.double(1)) })
            else { return }
            var mine = neighbor.1
            var theirs = key
            if mine == theirs {
                // Equal keys (never produced here, but possible in imported data): separate them.
                mine = move == .up ? key - Self.pinSpacing / 2 : key + Self.pinSpacing / 2
                theirs = key
            }
            try db.run("UPDATE notes SET pinned = ? WHERE id = ?", [.double(mine), .text(id)])
            try db.run("UPDATE notes SET pinned = ? WHERE id = ?", [.double(theirs), .text(neighbor.0)])
        }
    }

    // MARK: - Lists

    /// Live notes for Search Notes: pinned by key, then `updatedAt` desc, then `id` asc.
    public func list(filter: String? = nil, limit: Int = defaultListLimit, cursor: String? = nil) throws -> NotePage {
        try page(kind: .list, filter: filter, limit: limit, cursor: cursor)
    }

    /// Live notes for ⌘P: pinned by key, then `lastAccessedAt` desc, then `id` asc.
    /// With a filter, notes whose title matches come before text only matches.
    public func browse(filter: String? = nil, limit: Int = defaultListLimit, cursor: String? = nil) throws -> NotePage {
        try page(kind: .browse, filter: filter, limit: limit, cursor: cursor)
    }

    private func page(kind: ListCursor.Kind, filter: String?, limit: Int, cursor: String?) throws -> NotePage {
        let after = try cursor.map { try ListCursor.decode($0, kind: kind) }
        let limit = Self.clampLimit(limit)
        let pattern = TextFolding.likePattern(for: filter)
        let matchGroup: String
        let timestamp: String
        switch kind {
        case .list:
            matchGroup = "0"
            timestamp = "updated_at"
        case .browse:
            matchGroup = "(CASE WHEN ?1 IS NULL OR title_fold LIKE ?1 ESCAPE '\\' THEN 0 ELSE 1 END)"
            timestamp = "COALESCE(last_accessed_at, -1)"
        }
        let sql = """
            SELECT * FROM (
              SELECT \(Self.summaryColumns),
                     \(matchGroup) AS mg, (pinned IS NULL) AS g, COALESCE(pinned, 0.0) AS pk, -\(timestamp) AS nts
              FROM notes
              WHERE deleted_at IS NULL
                AND (?1 IS NULL OR title_fold LIKE ?1 ESCAPE '\\' OR text_fold LIKE ?1 ESCAPE '\\')
            )
            WHERE ?2 IS NULL OR (mg, g, pk, nts, id) > (?3, ?4, ?5, ?6, ?2)
            ORDER BY mg, g, pk, nts, id
            LIMIT ?7
            """
        return try locked {
            var keys: [ListCursor] = []
            var items = try db.query(
                sql,
                [
                    pattern.map(SQLValue.text) ?? .null, after.map { .text($0.id) } ?? .null,
                    .int(after?.matchGroup ?? 0), .int(after?.pinGroup ?? 0), .double(after?.pinKey ?? 0),
                    .int(after?.negatedTimestamp ?? 0), .int(Int64(limit + 1)),
                ]
            ) { row -> NoteSummary in
                let summary = Self.readSummary(row)
                keys.append(
                    ListCursor(
                        kind: kind, matchGroup: row.int(9), pinGroup: row.int(10), pinKey: row.double(11),
                        negatedTimestamp: row.int(12), id: summary.id))
                return summary
            }
            guard items.count > limit else { return NotePage(items: items, nextCursor: nil) }
            items.removeLast(items.count - limit)
            return NotePage(items: items, nextCursor: keys[limit - 1].encoded)
        }
    }

    static func clampLimit(_ limit: Int) -> Int {
        min(max(limit, 1), maxListLimit)
    }

    /// Every trashed note, most recently deleted first, with markdown and the document for previews.
    public func listDeleted() throws -> [DeletedNoteSummary] {
        try locked {
            try db.query(
                "SELECT \(Self.summaryColumns), markdown, raw_content FROM notes WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC, id ASC"
            ) { row in
                DeletedNoteSummary(summary: Self.readSummary(row), markdown: row.text(9), rawContent: row.text(10))
            }
        }
    }

    // MARK: - Current note and window data

    /// Persists the current note id. Does not validate it or touch timestamps.
    public func setCurrentNote(_ id: String) throws {
        try transaction { try persistCurrentNote(id) }
    }

    /// The persisted current note id, if any (it may refer to a missing or trashed note).
    public func currentNoteId() throws -> String? {
        try locked { try storedCurrentNoteId() }
    }

    /// Sets `lastAccessedAt` to now on a live note; no effect otherwise.
    public func touchAccessed(_ id: String) throws {
        _ = try transaction {
            try db.run("UPDATE notes SET last_accessed_at = ? WHERE id = ? AND deleted_at IS NULL", [.int(clock()), .text(id)])
        }
    }

    /// Window data for `noteId`, or for the persisted current note when nil. A missing or
    /// trashed note falls back to the most recently updated live note.
    public func windowData(noteId: String? = nil) throws -> WindowData {
        try locked {
            let requested = try noteId ?? storedCurrentNoteId()
            var current = try requested.flatMap(fetchNote)
            if current?.deletedAt != nil {
                current = nil
            }
            if current == nil {
                current = try db.queryFirst(
                    "SELECT \(Self.noteColumns) FROM notes WHERE deleted_at IS NULL ORDER BY updated_at DESC, id ASC LIMIT 1",
                    map: Self.readNote)
            }
            var previous: String?
            var next: String?
            if let current {
                let values: [SQLValue] = [.int(current.updatedAt), .text(current.id)]
                previous = try db.queryFirst(
                    """
                    SELECT id FROM notes WHERE deleted_at IS NULL
                      AND (updated_at > ?1 OR (updated_at = ?1 AND id < ?2))
                    ORDER BY updated_at ASC, id DESC LIMIT 1
                    """, values
                ) { $0.text(0) }
                next = try db.queryFirst(
                    """
                    SELECT id FROM notes WHERE deleted_at IS NULL
                      AND (updated_at < ?1 OR (updated_at = ?1 AND id > ?2))
                    ORDER BY updated_at DESC, id ASC LIMIT 1
                    """, values
                ) { $0.text(0) }
            }
            let pinned = try db.query(
                "SELECT id FROM notes WHERE pinned IS NOT NULL AND deleted_at IS NULL ORDER BY pinned, id LIMIT ?",
                [.int(Int64(WindowData.maxPinShortcuts))]
            ) { $0.text(0) }
            return WindowData(current: current, previousNoteId: previous, nextNoteId: next, pinnedShortcutNoteIds: pinned)
        }
    }

    // MARK: - Backups

    /// Settings key set when the helper started without a database while backups existed.
    static let restoreOfferKey = "restoreOffer"

    private static func holdsNotes(_ db: SQLiteDatabase) throws -> Bool {
        try db.queryFirst("SELECT EXISTS (SELECT 1 FROM notes)") { $0.int(0) != 0 } ?? false
    }

    /// Copies `db` into a new file at `path` and switches the copy to rollback journal mode, so it
    /// is one self contained file.
    private static func write(_ db: SQLiteDatabase, to path: String) throws {
        let copy = try SQLiteDatabase(path: path)
        defer { copy.close() }
        try db.copy(into: copy)
        try copy.execute("PRAGMA journal_mode = DELETE")
    }

    /// Writes a consistent copy of the database to `path` with the online backup API.
    public func backup(to path: String) throws {
        try locked { try Self.write(db, to: path) }
    }

    /// Writes a backup into `store`. Automatic reasons (`daily`, `pre-migration`) skip a database
    /// with no notes at all and return nil.
    public func backup(into store: BackupStore, reason: BackupReason) throws -> BackupInfo? {
        if reason.skipsEmptyDatabase, try !locked({ try Self.holdsNotes(db) }) { return nil }
        return try store.create(reason: reason) { try backup(to: $0) }
    }

    /// Replaces the whole database (notes and settings) with the backup at `path`, through the
    /// live connection with the online backup API, then migrates it if it is older. The backup
    /// must pass `quick_check` and must not have a newer schema. Returns every note id after.
    public func restore(from path: String) throws -> [String] {
        try locked {
            let source: SQLiteDatabase
            do {
                source = try SQLiteDatabase(path: path, readOnly: true)
            } catch {
                throw RPCError.badParams("Cannot open the backup: \(error)")
            }
            defer { source.close() }
            let check = (try? source.queryFirst("PRAGMA quick_check") { $0.text(0) }) ?? nil
            guard check == "ok" else { throw RPCError.badParams("The backup is damaged (\(check ?? "not a database"))") }
            let version = try source.userVersion
            guard version >= 1 else { throw RPCError.badParams("The backup has no Overnote notes") }
            guard version <= Migrations.latestVersion else {
                throw RPCError.conflict(Migrations.NewerSchemaError(found: version, supported: Migrations.latestVersion).description)
            }
            try source.copy(into: db)
            try db.execute("PRAGMA journal_mode = WAL")
            try Migrations.migrate(db)
            try db.run("DELETE FROM settings WHERE key = ?", [.text(Self.restoreOfferKey)])
            return try db.query("SELECT id FROM notes ORDER BY id") { $0.text(0) }
        }
    }

    /// Whether the extension should offer to restore a backup (see `restoreOfferKey`).
    public func restoreOffered() throws -> Bool {
        try locked {
            try db.queryFirst("SELECT value FROM settings WHERE key = ?", [.text(Self.restoreOfferKey)]) { $0.text(0) } == "1"
        }
    }

    public func setRestoreOffered(_ offered: Bool) throws {
        try locked {
            if offered {
                _ = try db.run(
                    "INSERT INTO settings (key, value) VALUES (?, '1') ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                    [.text(Self.restoreOfferKey)])
            } else {
                _ = try db.run("DELETE FROM settings WHERE key = ?", [.text(Self.restoreOfferKey)])
            }
        }
    }

    // MARK: - Settings

    public func settings() throws -> Settings {
        try locked { try loadSettings() }
    }

    /// Validates and applies a partial settings update atomically. Returns the full settings.
    public func setSettings(_ patch: [String: JSONValue]) throws -> Settings {
        try transaction {
            let updated = try loadSettings().applying(patch)
            for key in patch.keys.sorted() {
                try db.run(
                    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                    [.text(key), .text(updated.value(forKey: key).serialized())])
            }
            return updated
        }
    }

    /// Removes every stored setting, so each one reads as its default. The current note and the
    /// restore offer live in the same table under other keys and stay.
    public func resetSettings() throws -> Settings {
        try transaction {
            for key in Settings.keys {
                try db.run("DELETE FROM settings WHERE key = ?", [.text(key)])
            }
            return Settings.defaults
        }
    }

    /// Reads stored settings over the defaults. Unknown or invalid stored values are ignored,
    /// so a bad row can never stop the helper from starting.
    private func loadSettings() throws -> Settings {
        var settings = Settings.defaults
        let rows = try db.query("SELECT key, value FROM settings") { ($0.text(0), $0.text(1)) }
        for (key, raw) in rows where Settings.keys.contains(key) {
            guard let value = try? JSONValue.parse(raw) else { continue }
            try? settings.apply(key: key, value: value)
        }
        return settings
    }
}
