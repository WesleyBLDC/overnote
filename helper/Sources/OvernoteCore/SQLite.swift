import Foundation
import SQLite3

/// A value bound to or read from a SQLite statement.
enum SQLValue: Equatable {
    case null
    case int(Int64)
    case double(Double)
    case text(String)
}

struct SQLiteError: Error, CustomStringConvertible {
    let code: Int32
    let message: String

    var description: String { "SQLite error \(code): \(message)" }
}

/// `SQLITE_TRANSIENT`: tells SQLite to copy bound strings immediately.
private let transientDestructor = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

/// A minimal wrapper over one SQLite connection. Not thread safe: the owner serializes access.
final class SQLiteDatabase {
    private(set) var handle: OpaquePointer?
    private var statementCache: [String: Statement] = [:]

    init(path: String) throws {
        var db: OpaquePointer?
        let flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_NOMUTEX
        let status = sqlite3_open_v2(path, &db, flags, nil)
        guard status == SQLITE_OK, let db else {
            let message = db.map { String(cString: sqlite3_errmsg($0)) } ?? "cannot open database"
            sqlite3_close_v2(db)
            throw SQLiteError(code: status, message: message)
        }
        handle = db
        sqlite3_extended_result_codes(db, 1)
        sqlite3_busy_timeout(db, 3000)
    }

    deinit {
        close()
    }

    func close() {
        statementCache.removeAll()
        if let handle {
            sqlite3_close_v2(handle)
        }
        handle = nil
    }

    private func requireHandle() throws -> OpaquePointer {
        guard let handle else { throw SQLiteError(code: SQLITE_MISUSE, message: "database is closed") }
        return handle
    }

    func lastError() -> SQLiteError {
        guard let handle else { return SQLiteError(code: SQLITE_MISUSE, message: "database is closed") }
        return SQLiteError(code: sqlite3_extended_errcode(handle), message: String(cString: sqlite3_errmsg(handle)))
    }

    /// Runs one or more statements with no parameters and no results.
    func execute(_ sql: String) throws {
        let db = try requireHandle()
        var errorMessage: UnsafeMutablePointer<CChar>?
        let status = sqlite3_exec(db, sql, nil, nil, &errorMessage)
        if status != SQLITE_OK {
            let message = errorMessage.map { String(cString: $0) } ?? "unknown error"
            sqlite3_free(errorMessage)
            throw SQLiteError(code: status, message: message)
        }
    }

    /// Returns a cached prepared statement, reset and with its bindings cleared.
    func prepare(_ sql: String) throws -> Statement {
        if let cached = statementCache[sql] {
            cached.reset()
            return cached
        }
        let db = try requireHandle()
        var pointer: OpaquePointer?
        let status = sqlite3_prepare_v2(db, sql, -1, &pointer, nil)
        guard status == SQLITE_OK, let pointer else {
            throw lastError()
        }
        let statement = Statement(pointer: pointer, database: self)
        statementCache[sql] = statement
        return statement
    }

    /// Runs a statement for its side effects.
    @discardableResult
    func run(_ sql: String, _ values: [SQLValue] = []) throws -> Int {
        let statement = try prepare(sql)
        try statement.bind(values)
        while try statement.step() {}
        return changes
    }

    /// Runs a query and maps every row.
    func query<T>(_ sql: String, _ values: [SQLValue] = [], map: (Statement) throws -> T) throws -> [T] {
        let statement = try prepare(sql)
        try statement.bind(values)
        var rows: [T] = []
        while try statement.step() {
            rows.append(try map(statement))
        }
        return rows
    }

    func queryFirst<T>(_ sql: String, _ values: [SQLValue] = [], map: (Statement) throws -> T) throws -> T? {
        let statement = try prepare(sql)
        try statement.bind(values)
        defer { statement.reset() }
        guard try statement.step() else { return nil }
        return try map(statement)
    }

    var changes: Int {
        guard let handle else { return 0 }
        return Int(sqlite3_changes(handle))
    }

    var userVersion: Int {
        get throws {
            try queryFirst("PRAGMA user_version") { Int($0.int(0)) } ?? 0
        }
    }

    /// Runs `body` in an immediate transaction, rolling back if it throws.
    func transaction<T>(_ body: () throws -> T) throws -> T {
        try execute("BEGIN IMMEDIATE")
        do {
            let result = try body()
            try execute("COMMIT")
            return result
        } catch {
            try? execute("ROLLBACK")
            throw error
        }
    }
}

final class Statement {
    private let pointer: OpaquePointer
    private unowned let database: SQLiteDatabase

    init(pointer: OpaquePointer, database: SQLiteDatabase) {
        self.pointer = pointer
        self.database = database
    }

    deinit {
        sqlite3_finalize(pointer)
    }

    func reset() {
        sqlite3_reset(pointer)
        sqlite3_clear_bindings(pointer)
    }

    func bind(_ values: [SQLValue]) throws {
        for (offset, value) in values.enumerated() {
            let index = Int32(offset + 1)
            let status: Int32
            switch value {
            case .null: status = sqlite3_bind_null(pointer, index)
            case .int(let number): status = sqlite3_bind_int64(pointer, index, number)
            case .double(let number): status = sqlite3_bind_double(pointer, index, number)
            case .text(let text):
                // The implicit C string conversion carries the whole UTF-8 buffer, so passing
                // the byte length explicitly keeps embedded NUL characters.
                status = sqlite3_bind_text(pointer, index, text, Int32(text.utf8.count), transientDestructor)
            }
            guard status == SQLITE_OK else { throw database.lastError() }
        }
    }

    /// Steps once. Returns true when a row is available.
    func step() throws -> Bool {
        switch sqlite3_step(pointer) {
        case SQLITE_ROW: return true
        case SQLITE_DONE: return false
        default:
            let error = database.lastError()
            sqlite3_reset(pointer)
            throw error
        }
    }

    func isNull(_ column: Int32) -> Bool {
        sqlite3_column_type(pointer, column) == SQLITE_NULL
    }

    func int(_ column: Int32) -> Int64 {
        sqlite3_column_int64(pointer, column)
    }

    func optionalInt(_ column: Int32) -> Int64? {
        isNull(column) ? nil : int(column)
    }

    func double(_ column: Int32) -> Double {
        sqlite3_column_double(pointer, column)
    }

    func optionalDouble(_ column: Int32) -> Double? {
        isNull(column) ? nil : double(column)
    }

    func text(_ column: Int32) -> String {
        guard let base = sqlite3_column_text(pointer, column) else { return "" }
        let count = Int(sqlite3_column_bytes(pointer, column))
        return String(decoding: UnsafeBufferPointer(start: base, count: count), as: UTF8.self)
    }
}
