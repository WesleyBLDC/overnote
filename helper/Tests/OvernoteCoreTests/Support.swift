import Foundation
@testable import OvernoteCore

/// A clock the tests move by hand.
final class TestClock: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Millis

    init(_ start: Millis = 1_800_000_000_000) {
        value = start
    }

    var now: Millis {
        get { lock.withLock { value } }
        set { lock.withLock { value = newValue } }
    }

    func advance(_ millis: Millis = 1) {
        lock.withLock { value += millis }
    }

    var function: NotesRepository.Clock {
        { [self] in now }
    }
}

/// A fresh short temp directory (socket paths must stay under 104 bytes), removed on deinit.
final class TempDirectory {
    let path: String

    init() {
        let name = "bn-test-" + String(UUID().uuidString.prefix(8))
        path = "/tmp/" + name
        try? FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true)
    }

    func file(_ name: String) -> String {
        (path as NSString).appendingPathComponent(name)
    }

    deinit {
        try? FileManager.default.removeItem(atPath: path)
    }
}

/// A repository on a temp database with a manual clock. Every note created through
/// `make` advances the clock 1 ms first, so creation order is unambiguous.
final class Fixture {
    let directory = TempDirectory()
    let clock = TestClock()
    let repository: NotesRepository

    init() throws {
        repository = try NotesRepository(path: directory.file("notes.sqlite"), clock: clock.function)
    }

    @discardableResult
    func make(_ text: String, title: String? = nil) throws -> Note {
        clock.advance()
        return try repository.create(Fixture.content(text, title: title))
    }

    static func content(_ text: String, title: String? = nil) -> NoteContent {
        NoteContent(
            rawContent: #"{"type":"doc"}"#, markdown: text, text: text,
            title: title ?? String(text.split(separator: "\n").first ?? ""))
    }

    func listIds(filter: String? = nil) throws -> [String] {
        try repository.list(filter: filter).items.map(\.id)
    }

    func browseIds(filter: String? = nil) throws -> [String] {
        try repository.browse(filter: filter).items.map(\.id)
    }
}
