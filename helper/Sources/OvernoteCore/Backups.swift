import Darwin
import Foundation

/// Why a backup was written. The raw value is the last part of the file name.
public enum BackupReason: String, Sendable, CaseIterable {
    case manual
    case daily
    case preMigration = "pre-migration"
    case preUpdate = "pre-update"
    case preRestore = "pre-restore"

    /// Automatic backups skip a database that holds no notes.
    var skipsEmptyDatabase: Bool { self == .daily || self == .preMigration }
}

/// One backup file: `notes-<UTC timestamp>-v<version>-<reason>.sqlite` (docs/architecture.md section 9).
public struct BackupInfo: Equatable, Sendable {
    public var path: String
    public var name: String
    public var createdAt: Millis
    public var version: String
    public var reason: BackupReason
    public var sizeBytes: Int64

    public var json: JSONValue {
        [
            "path": .string(path), "name": .string(name), "createdAt": .int(createdAt), "version": .string(version),
            "reason": .string(reason.rawValue), "sizeBytes": .int(sizeBytes),
        ]
    }
}

/// Builds and parses backup file names. The timestamp is ISO 8601 basic format in UTC with
/// milliseconds (`20261015T023000.123Z`), so names sort in creation order.
public enum BackupName {
    static let prefix = "notes-"
    static let suffix = ".sqlite"
    static let timestampLength = 20

    private static func formatter() -> DateFormatter {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.dateFormat = "yyyyMMdd'T'HHmmss.SSS'Z'"
        return formatter
    }

    public static func make(createdAt: Millis, version: String, reason: BackupReason) -> String {
        let date = Date(timeIntervalSince1970: Double(createdAt) / 1000)
        return "\(prefix)\(formatter().string(from: date))-v\(version)-\(reason.rawValue)\(suffix)"
    }

    /// The parts of a backup name, or nil for any other file.
    public static func parse(_ name: String) -> (createdAt: Millis, version: String, reason: BackupReason)? {
        guard name.hasPrefix(prefix), name.hasSuffix(suffix) else { return nil }
        var middle = String(name.dropFirst(prefix.count).dropLast(suffix.count))
        // Reasons are a closed set and none is a suffix of another, so a version with hyphens
        // (0.3.0-beta.1) still parses.
        guard let reason = BackupReason.allCases.first(where: { middle.hasSuffix("-" + $0.rawValue) }) else { return nil }
        middle.removeLast(reason.rawValue.count + 1)
        guard middle.count > timestampLength + 2 else { return nil }
        let stamp = String(middle.prefix(timestampLength))
        let rest = middle.dropFirst(timestampLength)
        guard rest.hasPrefix("-v"), let date = formatter().date(from: stamp) else { return nil }
        let version = String(rest.dropFirst(2))
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: ".+-"))
        guard !version.isEmpty, version.unicodeScalars.allSatisfy(allowed.contains) else { return nil }
        return (Millis((date.timeIntervalSince1970 * 1000).rounded()), version, reason)
    }
}

/// Which backups to keep: the newest `keepLatest`, plus the newest backup of each of the last
/// `weeks` ISO weeks in UTC (the week containing `now` and the ones before it).
public enum BackupRetention {
    public static let keepLatest = 10
    public static let weeks = 4

    public static func kept(_ backups: [(name: String, createdAt: Millis)], now: Millis) -> Set<String> {
        let newestFirst = backups.sorted { $0.createdAt != $1.createdAt ? $0.createdAt > $1.createdAt : $0.name > $1.name }
        var kept = Set(newestFirst.prefix(keepLatest).map(\.name))
        var calendar = Calendar(identifier: .iso8601)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        func week(_ millis: Millis) -> DateComponents {
            calendar.dateComponents([.yearForWeekOfYear, .weekOfYear], from: Date(timeIntervalSince1970: Double(millis) / 1000))
        }
        let day: Millis = 24 * 60 * 60 * 1000
        var recentWeeks = (0..<weeks).map { week(now - Millis($0) * 7 * day) }
        for backup in newestFirst {
            if let index = recentWeeks.firstIndex(of: week(backup.createdAt)) {
                kept.insert(backup.name)
                recentWeeks.remove(at: index)
            }
        }
        return kept
    }
}

/// The backups folder, outside the extension's support directory so it survives removing the
/// extension: `~/Library/Application Support/Overnote/backups`, or `OVERNOTE_BACKUP_DIR`.
///
/// Every backup is a self contained SQLite file (rollback journal mode, no `-wal`) written with
/// the online backup API, in a 0700 directory with mode 0600.
public final class BackupStore: @unchecked Sendable {
    public static let environmentKey = "OVERNOTE_BACKUP_DIR"

    public let directory: String
    private let version: String
    private let clock: NotesRepository.Clock
    private let lock = NSLock()

    public init(directory: String, version: String = HelperVersion.current, clock: @escaping NotesRepository.Clock = NotesRepository.systemClock) {
        self.directory = directory
        self.version = version
        self.clock = clock
    }

    public static func defaultDirectory(environment: [String: String] = ProcessInfo.processInfo.environment) -> String {
        if let override = environment[environmentKey], !override.isEmpty {
            return (override as NSString).expandingTildeInPath
        }
        let home = environment["HOME"].flatMap { $0.isEmpty ? nil : $0 } ?? NSHomeDirectory()
        return (home as NSString).appendingPathComponent("Library/Application Support/Overnote/backups")
    }

    /// Every backup, newest first. A missing folder has none.
    public func list() throws -> [BackupInfo] {
        guard FileManager.default.fileExists(atPath: directory) else { return [] }
        let names: [String]
        do {
            names = try FileManager.default.contentsOfDirectory(atPath: directory)
        } catch {
            throw RPCError.internal("Cannot read the backups folder \(directory): \(error)")
        }
        return names.compactMap { name -> BackupInfo? in
            guard let parts = BackupName.parse(name) else { return nil }
            let path = (directory as NSString).appendingPathComponent(name)
            var info = stat()
            guard lstat(path, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG else { return nil }
            return BackupInfo(
                path: path, name: name, createdAt: parts.createdAt, version: parts.version, reason: parts.reason,
                sizeBytes: Int64(info.st_size))
        }
        .sorted { $0.createdAt != $1.createdAt ? $0.createdAt > $1.createdAt : $0.name > $1.name }
    }

    /// Writes a new backup: `write` fills a fresh 0600 file at the path it is given (with
    /// `NotesRepository.backup(to:)`), which is then renamed into place. Prunes old backups after.
    public func create(reason: BackupReason, write: (String) throws -> Void) throws -> BackupInfo {
        try lock.withLock {
            let backup = try createLocked(reason: reason, write: write)
            _ = pruneLocked()
            return backup
        }
    }

    /// Restores the backup at `path` (validated with `validatedRestorePath`): writes a
    /// `pre-restore` backup of the current notes with `write`, then runs `restore` on the backup's
    /// real path. The store stays locked throughout, so no other backup can prune the file being
    /// restored, and pruning waits until the restore is done.
    public func restore<T>(
        _ path: String, write: (String) throws -> Void, restore: (String) throws -> T
    ) throws -> (restored: BackupInfo, preRestore: BackupInfo, result: T) {
        try lock.withLock {
            let resolved = try validatedRestorePath(path)
            let name = (resolved as NSString).lastPathComponent
            guard let restored = try list().first(where: { $0.name == name }) else {
                throw RPCError.notFound("No backup at \(path)")
            }
            let preRestore = try createLocked(reason: .preRestore, write: write)
            defer { _ = pruneLocked() }
            return (restored, preRestore, try restore(resolved))
        }
    }

    private func createLocked(reason: BackupReason, write: (String) throws -> Void) throws -> BackupInfo {
        try prepareDirectory()
        var createdAt = clock()
        var name = BackupName.make(createdAt: createdAt, version: version, reason: reason)
        while FileManager.default.fileExists(atPath: (directory as NSString).appendingPathComponent(name)) {
            createdAt += 1
            name = BackupName.make(createdAt: createdAt, version: version, reason: reason)
        }
        let path = (directory as NSString).appendingPathComponent(name)
        let partial = (directory as NSString).appendingPathComponent(".\(name).partial")
        unlink(partial)
        let fd = open(partial, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw RPCError.internal("Cannot create \(partial): \(String(cString: strerror(errno)))") }
        close(fd)
        // The copy briefly takes the source's WAL header before switching to rollback mode,
        // which can leave sidecar files behind.
        func removeSidecars() {
            unlink(partial + "-wal")
            unlink(partial + "-shm")
            unlink(partial + "-journal")
        }
        defer { removeSidecars() }
        do {
            try write(partial)
            removeSidecars()
            chmod(partial, 0o600)
            guard rename(partial, path) == 0 else {
                throw RPCError.internal("Cannot move the backup into place: \(String(cString: strerror(errno)))")
            }
        } catch {
            unlink(partial)
            throw error
        }
        var info = stat()
        let size = lstat(path, &info) == 0 ? Int64(info.st_size) : 0
        return BackupInfo(path: path, name: name, createdAt: createdAt, version: version, reason: reason, sizeBytes: size)
    }

    /// Removes backups outside the retention policy, and partial files left by a crash.
    @discardableResult
    public func prune() -> [String] {
        lock.withLock { pruneLocked() }
    }

    private func pruneLocked() -> [String] {
        guard let all = try? list() else { return [] }
        let keep = BackupRetention.kept(all.map { ($0.name, $0.createdAt) }, now: clock())
        var removed: [String] = []
        for backup in all where !keep.contains(backup.name) {
            if unlink(backup.path) == 0 { removed.append(backup.name) }
        }
        let hourAgo = Date().addingTimeInterval(-3600)
        for name in (try? FileManager.default.contentsOfDirectory(atPath: directory)) ?? [] where name.hasSuffix(".partial") {
            let path = (directory as NSString).appendingPathComponent(name)
            if let modified = (try? FileManager.default.attributesOfItem(atPath: path))?[.modificationDate] as? Date,
                modified < hourAgo
            {
                unlink(path)
            }
        }
        return removed
    }

    /// Creates the folder (and its parents) with mode 0700, and closes an existing one to other users.
    private func prepareDirectory() throws {
        do {
            try FileManager.default.createDirectory(
                atPath: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        } catch {
            throw RPCError.internal("Cannot create the backups folder \(directory): \(error)")
        }
        var info = stat()
        guard lstat(directory, &info) == 0, (info.st_mode & S_IFMT) == S_IFDIR else {
            throw RPCError.internal("The backups folder \(directory) is not a directory")
        }
        if info.st_mode & 0o077 != 0 { chmod(directory, 0o700) }
    }

    /// The real path of a backup that `system.restoreBackup` may read: a regular file named like
    /// a backup, directly inside the backups folder once symlinks and `..` are resolved.
    public func validatedRestorePath(_ path: String) throws -> String {
        guard path.hasPrefix("/") else { throw RPCError.badParams("path must be absolute") }
        guard let resolvedDirectory = Self.realPath(directory) else {
            throw RPCError.notFound("There is no backups folder at \(directory)")
        }
        guard let resolved = Self.realPath(path) else { throw RPCError.notFound("No backup at \(path)") }
        let name = (resolved as NSString).lastPathComponent
        guard (resolved as NSString).deletingLastPathComponent == resolvedDirectory else {
            throw RPCError.badParams("Only backups inside \(directory) can be restored")
        }
        guard BackupName.parse(name) != nil else { throw RPCError.badParams("\(name) is not an Overnote backup") }
        var info = stat()
        guard lstat(resolved, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG else {
            throw RPCError.badParams("\(name) is not a regular file")
        }
        return resolved
    }

    static func realPath(_ path: String) -> String? {
        guard let pointer = realpath(path, nil) else { return nil }
        defer { free(pointer) }
        return String(cString: pointer)
    }
}

/// Writes a `daily` backup when the newest backup is at least 24 hours old: shortly after
/// startup, then checking every hour while the helper runs.
public final class BackupScheduler: @unchecked Sendable {
    public static let maxAge: Millis = 24 * 60 * 60 * 1000
    public static let checkInterval: TimeInterval = 60 * 60

    private let timer: DispatchSourceTimer

    public init(
        store: BackupStore, repository: NotesRepository, clock: @escaping NotesRepository.Clock = NotesRepository.systemClock,
        log: @escaping @Sendable (String) -> Void
    ) {
        timer = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "overnote.backup", qos: .utility))
        // A small leeway, so the first check really runs right after startup.
        timer.schedule(deadline: .now() + 0.5, repeating: Self.checkInterval, leeway: .seconds(1))
        timer.setEventHandler {
            do {
                if let newest = try store.list().first, clock() - newest.createdAt < Self.maxAge { return }
                if let backup = try repository.backup(into: store, reason: .daily) {
                    log("Daily backup: \(backup.path)")
                }
            } catch {
                log("Daily backup failed: \(error)")
            }
        }
        timer.resume()
    }

    public func cancel() {
        timer.cancel()
    }
}
