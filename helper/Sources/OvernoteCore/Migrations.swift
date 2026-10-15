import Foundation

/// Schema migrations, tracked with `PRAGMA user_version`.
///
/// Each entry upgrades the schema from `version - 1` to `version`, inside one transaction
/// together with the `user_version` bump. Append new versions; never edit shipped ones.
enum Migrations {
    struct Migration {
        let version: Int
        let sql: String
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
        )
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
    @discardableResult
    static func migrate(_ database: SQLiteDatabase, upTo target: Int = latestVersion) throws -> [Int] {
        let current = try database.userVersion
        guard current <= latestVersion else {
            throw NewerSchemaError(found: current, supported: latestVersion)
        }
        var applied: [Int] = []
        for migration in all where migration.version > current && migration.version <= target {
            try database.transaction {
                try database.execute(migration.sql)
                // PRAGMA does not accept bound parameters; the value is an integer constant.
                try database.execute("PRAGMA user_version = \(migration.version)")
            }
            applied.append(migration.version)
        }
        return applied
    }
}
