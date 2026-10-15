import Foundation
import Testing
@testable import BetterNotesCore

@Suite("Repository CRUD")
struct RepositoryCRUDTests {
    @Test func createStoresContentVerbatimWithFreshTimestamps() throws {
        let f = try Fixture()
        let content = NoteContent(rawContent: #"{"x":1}"#, markdown: "# Hi\u{0}", text: "Hi\u{0} there", title: "Hi")
        let note = try f.repository.create(content)
        #expect(note.content == content)
        #expect(ULIDGenerator.isValid(note.id))
        #expect(note.createdAt == f.clock.now)
        #expect(note.updatedAt == f.clock.now)
        #expect(note.lastAccessedAt == f.clock.now)
        #expect(note.caretPosition == 0)
        #expect(note.pinned == nil)
        #expect(note.deletedAt == nil)
        #expect(try f.repository.get(note.id) == note)
        #expect(try f.repository.currentNoteId() == note.id)
    }

    @Test func getMissingIs404() throws {
        let f = try Fixture()
        #expect(throws: RPCError.noteNotFound("nope")) { try f.repository.get("nope") }
    }

    @Test func contentUpdateAlwaysSetsUpdatedAtToNow() throws {
        let f = try Fixture()
        let note = try f.make("one")
        f.clock.advance(500)
        let same = try f.repository.update(note.id, NotePatch(text: "one"))
        #expect(same == .ok(try f.repository.get(note.id)))
        #expect(same.note.updatedAt == f.clock.now)
        f.clock.advance(10)
        let changed = try f.repository.update(note.id, NotePatch(rawContent: "{}", markdown: "two", text: "two", title: "two"))
        #expect(changed.note.content == NoteContent(rawContent: "{}", markdown: "two", text: "two", title: "two"))
        #expect(changed.note.updatedAt == f.clock.now)
        #expect(changed.note.createdAt == note.createdAt)
    }

    @Test func updateWithinTheSameMillisecondStillMovesUpdatedAt() throws {
        let f = try Fixture()
        let note = try f.make("one")
        let first = try f.repository.update(note.id, NotePatch(text: "a"))
        #expect(first.note.updatedAt == note.updatedAt + 1)
    }

    @Test func caretOnlyUpdateKeepsUpdatedAtAndSkipsTrashedNotes() throws {
        let f = try Fixture()
        let note = try f.make("one")
        f.clock.advance(100)
        let result = try f.repository.update(note.id, NotePatch(caretPosition: 7))
        #expect(result.note.caretPosition == 7)
        #expect(result.note.updatedAt == note.updatedAt)

        try f.repository.delete(note.id)
        let trashed = try f.repository.update(note.id, NotePatch(caretPosition: 99))
        #expect(trashed.note.caretPosition == 7)
    }

    @Test func staleExpectedUpdatedAtIsAConflictAndWritesNothing() throws {
        let f = try Fixture()
        let note = try f.make("one")
        f.clock.advance()
        _ = try f.repository.update(note.id, NotePatch(text: "two"))
        let stored = try f.repository.get(note.id)
        let result = try f.repository.update(note.id, NotePatch(text: "three", expectedUpdatedAt: note.updatedAt))
        #expect(result == .conflict(stored))
        #expect(try f.repository.get(note.id).content.text == "two")

        f.clock.advance()
        let fresh = try f.repository.update(note.id, NotePatch(text: "four", expectedUpdatedAt: stored.updatedAt))
        #expect(fresh.note.content.text == "four")
        #expect(result.json["status"] == "conflict")
        #expect(fresh.json["status"] == "ok")
    }

    @Test func deleteClearsPinStepsUpdatedAtAndIsIdempotent() throws {
        let f = try Fixture()
        let note = try f.make("one")
        _ = try f.repository.pin(note.id)
        f.clock.advance(1000)
        try f.repository.delete(note.id)
        let deleted = try f.repository.get(note.id)
        #expect(deleted.deletedAt == f.clock.now)
        #expect(deleted.pinned == nil)
        #expect(deleted.updatedAt == note.updatedAt + 1)

        f.clock.advance(1000)
        try f.repository.delete(note.id)
        #expect(try f.repository.get(note.id) == deleted)
    }

    @Test func recoverLeavesTheNoteUnpinnedAndNearItsPlace() throws {
        let f = try Fixture()
        let a = try f.make("a")
        f.clock.advance(10)
        let b = try f.make("b")
        f.clock.advance(10)
        let c = try f.make("c")
        _ = try f.repository.pin(b.id)
        f.clock.advance(5000)
        try f.repository.delete(b.id)
        #expect(try f.listIds() == [c.id, a.id])
        let recovered = try f.repository.recover(b.id)
        #expect(recovered.deletedAt == nil)
        #expect(recovered.pinned == nil)
        #expect(recovered.updatedAt == b.updatedAt + 2)
        #expect(recovered.lastAccessedAt == b.lastAccessedAt)
        #expect(try f.listIds() == [c.id, b.id, a.id])

        // Recover on a live note changes nothing.
        #expect(try f.repository.recover(b.id) == recovered)
    }

    @Test func deleteAllTrashesEveryLiveNote() throws {
        let f = try Fixture()
        let a = try f.make("a")
        let b = try f.make("b")
        try f.repository.delete(a.id)
        let moved = try f.repository.deleteAll()
        #expect(moved == [b.id])
        #expect(try f.repository.count() == 0)
        #expect(try f.repository.get(b.id).updatedAt == b.updatedAt + 1)
    }

    @Test func permanentlyDeleteOnlyRemovesTrashedNotes() throws {
        let f = try Fixture()
        let note = try f.make("keep")
        #expect(try f.repository.permanentlyDelete(note.id) == false)
        #expect(try f.repository.get(note.id).id == note.id)
        try f.repository.delete(note.id)
        #expect(try f.repository.permanentlyDelete(note.id) == true)
        #expect(throws: RPCError.noteNotFound(note.id)) { try f.repository.get(note.id) }
        #expect(throws: RPCError.noteNotFound(note.id)) { try f.repository.permanentlyDelete(note.id) }
    }

    @Test func emptyTrashRemovesOnlyTrashedNotes() throws {
        let f = try Fixture()
        let a = try f.make("a")
        let b = try f.make("b")
        let c = try f.make("c")
        try f.repository.delete(a.id)
        try f.repository.delete(c.id)
        #expect(Set(try f.repository.emptyTrash()) == [a.id, c.id])
        #expect(try f.listIds() == [b.id])
        #expect(try f.repository.listDeleted().isEmpty)
    }

    @Test func duplicateGetsFreshStateAndOptionalTitleSuffix() throws {
        let f = try Fixture()
        let source = try f.make("Shopping\nmilk")
        _ = try f.repository.pin(source.id)
        _ = try f.repository.update(source.id, NotePatch(caretPosition: 5))
        f.clock.advance(1000)
        let copy = try f.repository.duplicate(source.id)
        #expect(copy.id != source.id)
        #expect(copy.content == source.content)
        #expect(copy.pinned == nil)
        #expect(copy.caretPosition == 0)
        #expect(copy.createdAt == f.clock.now)
        #expect(copy.updatedAt == f.clock.now)
        #expect(copy.lastAccessedAt == f.clock.now)
        #expect(try f.repository.currentNoteId() == copy.id)

        let suffixed = try f.repository.duplicate(source.id, titleSuffix: " copy")
        #expect(suffixed.content.title == "Shopping copy")
        #expect(suffixed.content.text == source.content.text)
    }

    @Test func countIsLiveNotesOnly() throws {
        let f = try Fixture()
        let a = try f.make("a")
        try f.make("b")
        try f.repository.delete(a.id)
        #expect(try f.repository.count() == 1)
    }

    @Test func touchAccessedOnlyAffectsLiveNotes() throws {
        let f = try Fixture()
        let note = try f.make("a")
        f.clock.advance(50)
        try f.repository.touchAccessed(note.id)
        #expect(try f.repository.get(note.id).lastAccessedAt == f.clock.now)
        #expect(try f.repository.get(note.id).updatedAt == note.updatedAt)

        try f.repository.delete(note.id)
        let before = try f.repository.get(note.id)
        f.clock.advance(50)
        try f.repository.touchAccessed(note.id)
        #expect(try f.repository.get(note.id) == before)
        try f.repository.touchAccessed("missing")
    }
}

@Suite("Pins")
struct PinTests {
    @Test func pinAppendsWithThousandSpacingAndKeepsUpdatedAt() throws {
        let f = try Fixture()
        let a = try f.make("a")
        let b = try f.make("b")
        f.clock.advance(100)
        let pinnedA = try f.repository.pin(a.id)
        #expect(pinnedA.pinned == 1000)
        #expect(pinnedA.updatedAt == a.updatedAt)
        #expect(try f.repository.pin(b.id).pinned == 2000)
        // Pinning again keeps the place.
        #expect(try f.repository.pin(a.id).pinned == 1000)
        let unpinned = try f.repository.unpin(a.id)
        #expect(unpinned.pinned == nil)
        #expect(unpinned.updatedAt == a.updatedAt)
        #expect(try f.repository.pin(a.id).pinned == 3000)
    }

    @Test func pinningATrashedNoteIsAConflict() throws {
        let f = try Fixture()
        let a = try f.make("a")
        try f.repository.delete(a.id)
        #expect(throws: RPCError.self) { try f.repository.pin(a.id) }
        #expect(throws: RPCError.noteNotFound("x")) { try f.repository.pin("x") }
    }

    @Test func moveUpAndDownSwapNeighborsAndStopAtTheEnds() throws {
        let f = try Fixture()
        let notes = try (0..<3).map { try f.make("n\($0)") }
        for note in notes { _ = try f.repository.pin(note.id) }
        func order() throws -> [String] { try f.repository.windowData().pinnedShortcutNoteIds }
        #expect(try order() == notes.map(\.id))

        try f.repository.movePinned(notes[2].id, .up)
        #expect(try order() == [notes[0].id, notes[2].id, notes[1].id])
        try f.repository.movePinned(notes[0].id, .up)
        #expect(try order() == [notes[0].id, notes[2].id, notes[1].id])
        try f.repository.movePinned(notes[0].id, .down)
        #expect(try order() == [notes[2].id, notes[0].id, notes[1].id])
        try f.repository.movePinned(notes[1].id, .down)
        #expect(try order() == [notes[2].id, notes[0].id, notes[1].id])
        // Keys stay unique and updatedAt is untouched.
        let keys = try notes.map { try f.repository.get($0.id).pinned }
        #expect(Set(keys.compactMap { $0 }).count == 3)
        #expect(try f.repository.get(notes[0].id).updatedAt == notes[0].updatedAt)

        let loose = try f.make("loose")
        #expect(throws: RPCError.self) { try f.repository.movePinned(loose.id, .up) }
    }

    @Test func shortcutsAreTheFirstNinePins() throws {
        let f = try Fixture()
        let notes = try (0..<12).map { try f.make("n\($0)") }
        for note in notes { _ = try f.repository.pin(note.id) }
        #expect(try f.repository.windowData().pinnedShortcutNoteIds == notes.prefix(9).map(\.id))
    }
}

@Suite("Lists, filters, and cursors")
struct ListTests {
    @Test func listOrdersPinnedThenUpdatedDesc() throws {
        let f = try Fixture()
        let a = try f.make("a")
        let b = try f.make("b")
        let c = try f.make("c")
        #expect(try f.listIds() == [c.id, b.id, a.id])
        _ = try f.repository.pin(a.id)
        #expect(try f.listIds() == [a.id, c.id, b.id])
    }

    @Test func browseOrdersPinnedThenLastAccessedDesc() throws {
        let f = try Fixture()
        let a = try f.make("a")
        let b = try f.make("b")
        let c = try f.make("c")
        let d = try f.make("d")
        _ = try f.repository.pin(d.id)
        for note in [b, a, c] {
            f.clock.advance()
            try f.repository.touchAccessed(note.id)
        }
        #expect(try f.browseIds() == [d.id, c.id, a.id, b.id])
        #expect(try f.listIds() == [d.id, c.id, b.id, a.id])
    }

    @Test func browseFilterPutsTitleMatchesFirst() throws {
        let f = try Fixture()
        let x = try f.make("Groceries list\nmilk", title: "Groceries list")
        let y = try f.make("Notes\nremember groceries", title: "Notes")
        try f.make("Other\nnothing")
        f.clock.advance()
        try f.repository.touchAccessed(y.id)
        #expect(try f.browseIds(filter: "groceries") == [x.id, y.id])
        // list does not rank by title.
        #expect(try f.listIds(filter: "groceries") == [y.id, x.id])
    }

    @Test func filterFoldsCaseAndDiacriticsForAllOfUnicode() throws {
        let f = try Fixture()
        let cafe = try f.make("Café au lait")
        let greek = try f.make("ΣΟΦΙΑ")
        let german = try f.make("Straße ÜBER")
        #expect(try f.listIds(filter: "CAFE") == [cafe.id])
        #expect(try f.listIds(filter: "café") == [cafe.id])
        #expect(try f.listIds(filter: "σοφια") == [greek.id])
        #expect(try f.listIds(filter: "über") == [german.id])
        #expect(try f.listIds(filter: "uber") == [german.id])
        #expect(try f.listIds(filter: "STRASSE").isEmpty)
        #expect(try f.listIds(filter: "straße") == [german.id])
    }

    @Test func wildcardsMatchLiterally() throws {
        let f = try Fixture()
        let percent = try f.make("100% done")
        let underscore = try f.make("snake_case")
        let slash = try f.make("back\\slash")
        try f.make("plain words")
        #expect(try f.listIds(filter: "%") == [percent.id])
        #expect(try f.listIds(filter: "_") == [underscore.id])
        #expect(try f.listIds(filter: "\\") == [slash.id])
    }

    @Test func blankFilterIsNoFilter() throws {
        let f = try Fixture()
        try f.make("a")
        try f.make("b")
        #expect(try f.listIds(filter: "   ").count == 2)
        #expect(try f.listIds(filter: "").count == 2)
    }

    @Test func filterUpdatesWithContent() throws {
        let f = try Fixture()
        let note = try f.make("alpha")
        _ = try f.repository.update(note.id, NotePatch(text: "Beta", title: "Beta"))
        #expect(try f.listIds(filter: "alpha").isEmpty)
        #expect(try f.listIds(filter: "beta") == [note.id])
    }

    @Test func listExcludesTrashedNotes() throws {
        let f = try Fixture()
        let a = try f.make("a")
        let b = try f.make("b")
        try f.repository.delete(a.id)
        #expect(try f.listIds() == [b.id])
        #expect(try f.browseIds() == [b.id])
    }

    @Test(arguments: [ListCursor.Kind.list, .browse])
    func pagingCoversEveryRowOnceAcrossThePinBoundary(kind: ListCursor.Kind) throws {
        let f = try Fixture()
        let notes = try (0..<5).map { try f.make("note \($0)") }
        _ = try f.repository.pin(notes[3].id)
        _ = try f.repository.pin(notes[1].id)
        // Same lastAccessedAt for two notes to exercise the id tie break.
        try f.repository.touchAccessed(notes[0].id)
        try f.repository.touchAccessed(notes[2].id)

        func fetch(_ cursor: String?) throws -> NotePage {
            kind == .list
                ? try f.repository.list(limit: 2, cursor: cursor) : try f.repository.browse(limit: 2, cursor: cursor)
        }
        var pages: [[String]] = []
        var cursor: String?
        repeat {
            let page = try fetch(cursor)
            pages.append(page.items.map(\.id))
            cursor = page.nextCursor
        } while cursor != nil && pages.count < 10
        let all = kind == .list ? try f.listIds() : try f.browseIds()
        #expect(pages.count == 3)
        #expect(pages.flatMap { $0 } == all)
        #expect(Array(all.prefix(2)) == [notes[3].id, notes[1].id])
    }

    @Test func filteredBrowsePagesKeepTheMatchGroups() throws {
        let f = try Fixture()
        var titleHits: [String] = []
        var textHits: [String] = []
        for index in 0..<3 {
            titleHits.append(try f.make("apple \(index)", title: "apple \(index)").id)
            textHits.append(try f.make("note \(index)\nan apple", title: "note \(index)").id)
        }
        var ids: [String] = []
        var cursor: String?
        repeat {
            let page = try f.repository.browse(filter: "apple", limit: 2, cursor: cursor)
            ids += page.items.map(\.id)
            cursor = page.nextCursor
        } while cursor != nil
        #expect(ids == titleHits.reversed() + textHits.reversed())
    }

    @Test func badCursorsAreRejected() throws {
        let f = try Fixture()
        try f.make("a")
        try f.make("b")
        let listCursor = try f.repository.list(limit: 1).nextCursor
        #expect(listCursor != nil)
        #expect(throws: RPCError.badParams("Invalid cursor")) { try f.repository.list(cursor: "garbage") }
        #expect(throws: RPCError.badParams("Invalid cursor")) { try f.repository.browse(cursor: listCursor) }
    }

    @Test func summariesCarryPreviewAndCharCount() throws {
        let f = try Fixture()
        let long = String(repeating: "é", count: 250)
        try f.make(long, title: "t")
        let item = try #require(try f.repository.list().items.first)
        #expect(item.preview.count == 200)
        #expect(item.charCount == 250)
    }

    @Test func listDeletedIsNewestFirstWithMarkdown() throws {
        let f = try Fixture()
        let a = try f.make("a")
        let b = try f.make("b")
        try f.make("live")
        f.clock.advance()
        try f.repository.delete(b.id)
        f.clock.advance()
        try f.repository.delete(a.id)
        let deleted = try f.repository.listDeleted()
        #expect(deleted.map(\.summary.id) == [a.id, b.id])
        #expect(deleted.first?.markdown == "a")
        #expect(deleted.first?.json["markdown"] == "a")
    }
}

@Suite("Window data")
struct WindowDataTests {
    @Test func neighborsFollowUpdatedAtDesc() throws {
        let f = try Fixture()
        let a = try f.make("a")
        let b = try f.make("b")
        let c = try f.make("c")
        let middle = try f.repository.windowData(noteId: b.id)
        #expect(middle.current?.id == b.id)
        #expect(middle.previousNoteId == c.id)
        #expect(middle.nextNoteId == a.id)
        let newest = try f.repository.windowData(noteId: c.id)
        #expect(newest.previousNoteId == nil)
        #expect(newest.nextNoteId == b.id)
        let oldest = try f.repository.windowData(noteId: a.id)
        #expect(oldest.nextNoteId == nil)
    }

    @Test func persistedCurrentNoteAndFallback() throws {
        let f = try Fixture()
        let a = try f.make("a")
        let b = try f.make("b")
        try f.repository.setCurrentNote(a.id)
        #expect(try f.repository.windowData().current?.id == a.id)
        try f.repository.delete(a.id)
        #expect(try f.repository.windowData().current?.id == b.id)
        #expect(try f.repository.windowData(noteId: "unknown").current?.id == b.id)
        try f.repository.setCurrentNote("not-validated")
        #expect(try f.repository.currentNoteId() == "not-validated")
        #expect(try f.repository.windowData().current?.id == b.id)
    }

    @Test func emptyDatabaseHasNoCurrent() throws {
        let f = try Fixture()
        let data = try f.repository.windowData()
        #expect(data == WindowData(current: nil, previousNoteId: nil, nextNoteId: nil, pinnedShortcutNoteIds: []))
        #expect(data.json["current"] == .null)
    }

    @Test func currentNoteIdIsNotASetting() throws {
        let f = try Fixture()
        try f.repository.setCurrentNote("x")
        #expect(try f.repository.settings() == .defaults)
        #expect(throws: RPCError.self) { try f.repository.setSettings(["currentNoteId": "y"]) }
    }
}

@Suite("Trash purge")
struct PurgeTests {
    @Test func purgeRemovesOnlyNotesStrictlyOlderThanSixtyDays() throws {
        let f = try Fixture()
        let old = try f.make("old")
        let edge = try f.make("edge")
        let recent = try f.make("recent")
        let live = try f.make("live")
        let day: Millis = 24 * 60 * 60 * 1000
        let start = f.clock.now
        try f.repository.delete(old.id)
        f.clock.now = start + 1000
        try f.repository.delete(edge.id)
        f.clock.now = start + day
        try f.repository.delete(recent.id)

        // Now is exactly 60 days after `edge` was deleted: it is not strictly older, so it stays.
        f.clock.now = start + 1000 + 60 * day
        #expect(try f.repository.purgeExpiredTrash() == [old.id])
        f.clock.advance(1)
        #expect(try f.repository.purgeExpiredTrash() == [edge.id])
        #expect(try f.repository.listDeleted().map(\.summary.id) == [recent.id])
        #expect(try f.repository.get(live.id).id == live.id)
    }

    @Test func schedulerRunsImmediatelyAndOnTicks() async throws {
        let counter = Counter()
        let scheduler = PurgeScheduler(interval: 0.05) { counter.increment() }
        #expect(counter.value == 1)
        try await Task.sleep(for: .milliseconds(300))
        scheduler.cancel()
        #expect(counter.value >= 2)
    }
}

final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    func increment() { lock.withLock { count += 1 } }
    var value: Int { lock.withLock { count } }
}

@Suite("Settings")
struct SettingsTests {
    @Test func defaultsAndPartialUpdates() throws {
        let f = try Fixture()
        #expect(try f.repository.settings() == .defaults)
        let updated = try f.repository.setSettings(["escapeLosesFocus": true, "countMode": "words"])
        #expect(updated.escapeLosesFocus)
        #expect(updated.countMode == .words)
        #expect(updated.windowAutoSize)
        #expect(try f.repository.settings() == updated)
        #expect(updated.json["countMode"] == "words")
        #expect(updated.json["panelFrame"] == .null)
    }

    @Test func zoomIsSnappedAndClamped() throws {
        let f = try Fixture()
        #expect(try f.repository.setSettings(["zoom": 5]).zoom == 2.0)
        #expect(try f.repository.setSettings(["zoom": 0.1]).zoom == 0.75)
        #expect(try f.repository.setSettings(["zoom": 1.13]).zoom == 1.15)
        #expect(try f.repository.setSettings(["zoom": .double(1.1 + 0.05)]).zoom == 1.15)
    }

    @Test func panelFrameRoundTripsWithOptionalHeight() throws {
        let f = try Fixture()
        let frame: JSONValue = ["x": 10, "y": 900.5, "width": 600]
        #expect(try f.repository.setSettings(["panelFrame": frame]).panelFrame == PanelFrame(x: 10, y: 900.5, width: 600))
        let tall: JSONValue = ["x": 10, "y": 900.5, "width": 600, "height": 420]
        let stored = try f.repository.setSettings(["panelFrame": tall, "windowAutoSize": false])
        #expect(stored.panelFrame?.height == 420)
        #expect(stored.windowAutoSize == false)
        #expect(try f.repository.setSettings(["panelFrame": .null]).panelFrame == nil)
    }

    @Test func invalidSettingsAreRejectedAtomically() throws {
        let f = try Fixture()
        #expect(throws: RPCError.self) { try f.repository.setSettings(["zoom": "big"]) }
        #expect(throws: RPCError.self) { try f.repository.setSettings(["countMode": "lines"]) }
        #expect(throws: RPCError.self) { try f.repository.setSettings(["unknown": true]) }
        #expect(throws: RPCError.self) { try f.repository.setSettings(["panelFrame": ["x": 1]]) }
        #expect(throws: RPCError.self) { try f.repository.setSettings(["showFormatBar": true, "escapeLosesFocus": 1]) }
        #expect(try f.repository.settings() == .defaults)
    }

    @Test func settingsPersistAcrossReopen() throws {
        let directory = TempDirectory()
        let path = directory.file("notes.sqlite")
        do {
            let repository = try NotesRepository(path: path)
            _ = try repository.setSettings(["hideWhileScreenSharing": true])
            repository.close()
        }
        let reopened = try NotesRepository(path: path)
        #expect(try reopened.settings().hideWhileScreenSharing)
    }
}

@Suite("Migrations")
struct MigrationTests {
    @Test func freshDatabaseIsAtTheLatestVersionWithWAL() throws {
        let f = try Fixture()
        #expect(try f.repository.schemaVersion() == Migrations.latestVersion)
        let db = try SQLiteDatabase(path: f.directory.file("notes.sqlite"))
        #expect(try db.queryFirst("PRAGMA journal_mode") { $0.text(0) } == "wal")
        let tables = try db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name") { $0.text(0) }
        #expect(tables == ["notes", "settings"])
    }

    @Test func reopeningAppliesNothing() throws {
        let directory = TempDirectory()
        let path = directory.file("notes.sqlite")
        let db = try SQLiteDatabase(path: path)
        #expect(try Migrations.migrate(db) == [1])
        #expect(try Migrations.migrate(db) == [])
        #expect(try db.userVersion == 1)
    }

    @Test func newerSchemaIsRefused() throws {
        let directory = TempDirectory()
        let path = directory.file("notes.sqlite")
        do {
            let db = try SQLiteDatabase(path: path)
            try db.execute("PRAGMA user_version = 99")
        }
        #expect(throws: RPCError.self) { try NotesRepository(path: path) }
    }

    @Test func dataSurvivesReopen() throws {
        let directory = TempDirectory()
        let path = directory.file("notes.sqlite")
        let id: String
        do {
            let repository = try NotesRepository(path: path)
            id = try repository.create(Fixture.content("persist me")).id
            repository.close()
        }
        let reopened = try NotesRepository(path: path)
        #expect(try reopened.get(id).content.text == "persist me")
        #expect(try reopened.windowData().current?.id == id)
    }
}
