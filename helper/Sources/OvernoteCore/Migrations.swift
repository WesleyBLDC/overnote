import Foundation

/// Schema migrations, tracked with `PRAGMA user_version`.
///
/// Each entry upgrades the schema from `version - 1` to `version`, inside one transaction
/// together with the `user_version` bump. Append new versions; never edit shipped ones.
enum Migrations {
    struct Migration {
        let version: Int
        let sql: String
        /// Full text index statements for this version, run only when FTS5 with the trigram
        /// tokenizer is available in the linked SQLite.
        var ftsSQL: String? = nil
    }

    static let all: [Migration] = [
        Migration(
            version: 1,
            sql: """
                CREATE TABLE notes (
                  id               TEXT PRIMARY KEY,
                  title            TEXT NOT NULL DEFAULT '',
                  text             TEXT NOT NULL DEFAULT '',
                  markdown         TEXT NOT NULL DEFAULT '',
                  raw_content      TEXT NOT NULL,
                  title_fold       TEXT NOT NULL DEFAULT '',
                  text_fold        TEXT NOT NULL DEFAULT '',
                  pinned           REAL,
                  created_at       INTEGER NOT NULL,
                  updated_at       INTEGER NOT NULL,
                  deleted_at       INTEGER,
                  last_accessed_at INTEGER,
                  caret_position   INTEGER
                ) STRICT, WITHOUT ROWID;

                CREATE INDEX notes_list_order   ON notes (deleted_at, pinned, updated_at DESC, id);
                CREATE INDEX notes_browse_order ON notes (deleted_at, pinned, last_accessed_at DESC, id);

                CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
                """
        ),
        Migration(
            version: 2,
            sql: """
                ALTER TABLE notes ADD COLUMN sort_pin_group INTEGER GENERATED ALWAYS AS (pinned IS NULL) VIRTUAL;
                ALTER TABLE notes ADD COLUMN sort_pin_key REAL GENERATED ALWAYS AS (COALESCE(pinned, 0.0)) VIRTUAL;
                ALTER TABLE notes ADD COLUMN sort_updated_neg INTEGER GENERATED ALWAYS AS (-updated_at) VIRTUAL;
                ALTER TABLE notes ADD COLUMN sort_accessed_neg INTEGER GENERATED ALWAYS AS (-COALESCE(last_accessed_at, -1)) VIRTUAL;
                CREATE INDEX notes_list_page ON notes (
                  deleted_at, sort_pin_group, sort_pin_key, sort_updated_neg, id);
                CREATE INDEX notes_browse_page ON notes (
                  deleted_at, sort_pin_group, sort_pin_key, sort_accessed_neg, id);
                """,
            ftsSQL: """
                CREATE VIRTUAL TABLE notes_fts USING fts5(
                  id UNINDEXED, title_fold, text_fold, tokenize = 'trigram');
                INSERT INTO notes_fts (id, title_fold, text_fold)
                  SELECT id, title_fold, text_fold FROM notes;
                CREATE TRIGGER notes_fts_after_insert AFTER INSERT ON notes BEGIN
                  INSERT INTO notes_fts (id, title_fold, text_fold)
                    VALUES (NEW.id, NEW.title_fold, NEW.text_fold);
                END;
                CREATE TRIGGER notes_fts_after_update AFTER UPDATE OF title_fold, text_fold ON notes BEGIN
                  DELETE FROM notes_fts WHERE id = OLD.id;
                  INSERT INTO notes_fts (id, title_fold, text_fold)
                    VALUES (NEW.id, NEW.title_fold, NEW.text_fold);
                END;
                CREATE TRIGGER notes_fts_after_delete AFTER DELETE ON notes BEGIN
                  DELETE FROM notes_fts WHERE id = OLD.id;
                END;
                """
        ),
    ]

    static var latestVersion: Int { all.last?.version ?? 0 }

    struct NewerSchemaError: Error, CustomStringConvertible {
        let found: Int
        let supported: Int
        var description: String {
            "Database schema version \(found) is newer than this helper supports (\(supported)). Update Overnote."
        }
    }

    /// Brings `database` up to `latestVersion`. Returns the versions that were applied.
    /// `fts` overrides the tokenizer probe; tests pass false to build a database as a SQLite
    /// without the trigram tokenizer would.
    @discardableResult
    static func migrate(_ database: SQLiteDatabase, upTo target: Int = latestVersion, fts: Bool? = nil) throws -> [Int] {
        let current = try database.userVersion
        guard current <= latestVersion else {
            throw NewerSchemaError(found: current, supported: latestVersion)
        }
        var applied: [Int] = []
        for migration in all where migration.version > current && migration.version <= target {
            // Probe outside the migration transaction, so a missing FTS5 or trigram tokenizer
            // leaves no probe table behind and the version still advances without the index.
            // Filtered queries detect the missing table and keep the folded LIKE path.
            let ftsAvailable = migration.ftsSQL == nil || (fts ?? Self.ftsAvailable(database))
            try database.transaction {
                try database.execute(migration.sql)
                if ftsAvailable, let ftsSQL = migration.ftsSQL {
                    try database.execute(ftsSQL)
                }
                // PRAGMA does not accept bound parameters; the value is an integer constant.
                try database.execute("PRAGMA user_version = \(migration.version)")
            }
            applied.append(migration.version)
        }
        return applied
    }

    /// Whether the linked SQLite can build an FTS5 table with the trigram tokenizer.
    static func ftsAvailable(_ database: SQLiteDatabase) -> Bool {
        do {
            try database.execute("CREATE VIRTUAL TABLE temp.overnote_fts_probe USING fts5(probe, tokenize = 'trigram')")
            try database.execute("DROP TABLE temp.overnote_fts_probe")
            return true
        } catch {
            return false
        }
    }
}
