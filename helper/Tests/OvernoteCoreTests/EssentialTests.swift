import CoreGraphics
import Foundation
import Testing
@testable import OvernoteCore

// Unit tests are limited to logic end to end tests cannot reach cheaply (the testing policy in
// CONTRIBUTING.md): fold rules, ordering and cursor math, pins, trash purge, the update conflict, RPC
// framing, the panel size limits and frame memory, and the security checks on file names and asset paths. Everything else is covered
// by scripts/smoke-helper.sh and scripts/e2e-window.sh against the real binary.

@Suite("Fold rule")
struct FoldTests {
    @Test func foldMatchesTheSharedGoldenCorpus() throws {
        // The same file the TypeScript core tests read, so a note is findable identically
        // from every client: packages/core/tests/fold-corpus.json. Walk up from this file
        // until the corpus is found, so moving this file within the repository (or adding a
        // folder level above it) cannot silently point the test at the wrong place.
        var directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        var url: URL?
        while url == nil {
            let candidate = directory.appendingPathComponent("packages/core/tests/fold-corpus.json")
            if FileManager.default.fileExists(atPath: candidate.path) { url = candidate }
            let parent = directory.deletingLastPathComponent()
            if parent.path == directory.path { break }
            directory = parent
        }
        let corpusURL = try #require(url)
        let corpus = try JSONDecoder().decode([FoldCase].self, from: Data(contentsOf: corpusURL))
        #expect(corpus.count >= 20)
        for entry in corpus {
            #expect(TextFolding.fold(entry.input) == entry.folded, "fold(\(entry.input))")
        }
    }

    private struct FoldCase: Decodable {
        let input: String
        let folded: String
    }

    @Test func asciiFastPathMatchesTheGeneralRuleForEveryAsciiScalar() {
        // Every scalar the ASCII gate admits, control characters, NUL, and DEL included. The
        // expected value is built independently: only A to Z change, by one bit, byte for byte.
        let allASCII = String((0...127).map { Character(UnicodeScalar(UInt8($0))) })
        let expected = allASCII.utf8.map { $0 >= 65 && $0 <= 90 ? $0 + 32 : $0 }
        #expect(Array(TextFolding.fold(allASCII).utf8) == expected)
        // Combining marks are never ASCII, so these take the general path and lose their marks.
        #expect(TextFolding.fold("E\u{301} A\u{300} Cafe\u{301}") == "e a cafe")
    }

    @Test func ftsPhraseOnlyForTermsOfThreeScalars() {
        #expect(TextFolding.ftsPhrase(for: "ab") == nil)
        #expect(TextFolding.ftsPhrase(for: "😀") == nil)
        #expect(TextFolding.ftsPhrase(for: "   ") == nil)
        #expect(TextFolding.ftsPhrase(for: " Café ") == "\"cafe\"")
        #expect(TextFolding.ftsPhrase(for: "say \"hi\"") == "\"say \"\"hi\"\"\"")
    }

    @Test func likePatternTrimsFoldsAndEscapesWildcards() {
        #expect(TextFolding.likePattern(for: "  \n") == nil)
        #expect(TextFolding.likePattern(for: " Ab ") == "%ab%")
        #expect(TextFolding.likePattern(for: "50%_\\") == "%50\\%\\_\\\\%")
    }
}

@Suite("Schema 2 search")
struct SearchIndexTests {
    /// Filtered pages through the trigram index equal the folded substring results, including
    /// the short terms the index cannot answer and so keep the LIKE scan.
    @Test func indexedResultsEqualFoldedSubstringResults() throws {
        let f = try Fixture()
        let cafe = try f.make("Café Über\nthe body", title: "Café Über")
        let quix = try f.make("plain\na quixotic café paragraph", title: "plain")
        let pct = try f.make("Groceries 100%\nsnake_case stuff", title: "Groceries 100%")
        let emoji = try f.make("Mood 😀 today\nnotes", title: "Mood 😀 today")
        let cjk = try f.make("中文標題測試\nbody", title: "中文標題測試")
        let file = try f.make("ﬁle notes\nbody", title: "ﬁle notes")
        try f.make("unrelated\nnothing here", title: "unrelated")
        #expect(try f.browseIds(filter: "CAFÉ") == [cafe.id, quix.id])  // title match first
        #expect(try f.listIds(filter: "cafe") == [quix.id, cafe.id])
        #expect(try f.browseIds(filter: "quixotic") == [quix.id])
        #expect(try f.browseIds(filter: "100%") == [pct.id])
        #expect(try f.browseIds(filter: "%") == [pct.id])
        #expect(try f.browseIds(filter: "snake_case") == [pct.id])
        #expect(try f.browseIds(filter: "_") == [pct.id])
        #expect(try f.browseIds(filter: "😀") == [emoji.id])
        #expect(try f.browseIds(filter: "中文標") == [cjk.id])
        #expect(try f.browseIds(filter: "中文") == [cjk.id])
        #expect(try f.browseIds(filter: "ﬁl") == [file.id])
        #expect(try f.browseIds(filter: "xyzzy").isEmpty)
    }

    /// Removes one note's index row behind the triggers' back: only a page that really narrows
    /// through notes_fts loses that note, while a two scalar term keeps the LIKE scan and finds it.
    @Test func filteredPagesNarrowThroughTheIndex() throws {
        let f = try Fixture()
        let hidden = try f.make("Café hidden\nbody", title: "Café hidden")
        let shown = try f.make("Café shown\nbody", title: "Café shown")
        try Self.removeFromIndex(f, id: hidden.id)
        #expect(try f.browseIds(filter: "café") == [shown.id])
        #expect(try f.listIds(filter: "CAFE") == [shown.id])
        #expect(try f.browseIds(filter: "ca") == [shown.id, hidden.id])
    }

    @Test func theIndexFollowsEveryWrite() throws {
        let f = try Fixture()
        #expect(try f.repository.schemaVersion() == 2)
        let note = try f.make("alpha bravo\nbody")
        #expect(try Self.indexedIds(f, "bravo") == [note.id])
        #expect(try f.browseIds(filter: "bravo") == [note.id])
        _ = try f.repository.update(note.id, NotePatch(rawContent: "{}", markdown: "charlie", text: "charlie", title: "charlie"))
        #expect(try Self.indexedIds(f, "bravo").isEmpty)
        #expect(try Self.indexedIds(f, "charlie") == [note.id])
        #expect(try f.browseIds(filter: "bravo").isEmpty)
        #expect(try f.browseIds(filter: "charlie") == [note.id])
        let gone = try f.make("delta gone")
        try f.repository.delete(gone.id)
        try f.repository.permanentlyDelete(gone.id)
        #expect(try Self.indexedIds(f, "delta").isEmpty)
        try f.repository.delete(note.id)
        #expect(try f.browseIds(filter: "charlie").isEmpty)
        _ = try f.repository.recover(note.id)
        let copy = try f.repository.duplicate(note.id)
        #expect(try Self.indexedIds(f, "charlie").sorted() == [note.id, copy.id].sorted())
        #expect(try f.browseIds(filter: "charlie").count == 2)
        // After every write the pages still read the index, not a LIKE scan it fell back to.
        try Self.removeFromIndex(f, id: copy.id)
        #expect(try f.browseIds(filter: "charlie") == [note.id])
    }

    /// The ids notes_fts itself holds for a folded term, read on a separate connection.
    private static func indexedIds(_ f: Fixture, _ term: String) throws -> [String] {
        let check = try SQLiteDatabase(path: f.directory.file("notes.sqlite"), readOnly: true)
        defer { check.close() }
        return try check.query("SELECT id FROM notes_fts WHERE notes_fts MATCH ? ORDER BY id", [.text(TextFolding.ftsPhrase(for: term) ?? "")]) { $0.text(0) }
    }

    private static func removeFromIndex(_ f: Fixture, id: String) throws {
        let side = try SQLiteDatabase(path: f.directory.file("notes.sqlite"))
        defer { side.close() }
        #expect(try side.run("DELETE FROM notes_fts WHERE id = ?", [.text(id)]) == 1)
    }

    /// Reads on the second connection see each write as soon as it commits, and a restore
    /// reopens that connection on the restored database.
    @Test func secondConnectionSeesWritesAndRestores() throws {
        let f = try Fixture()
        let kept = try f.make("kept note")
        let backup = f.directory.file("backup.sqlite")
        try f.repository.backup(to: backup)
        let later = try f.make("later note")
        #expect(try f.repository.count() == 2)
        try f.repository.delete(later.id)
        #expect(try f.repository.count() == 1)
        #expect(try f.repository.listDeleted().map(\.summary.id) == [later.id])
        _ = try f.repository.recover(later.id)
        #expect(try f.browseIds(filter: "note") == [later.id, kept.id])
        #expect(try f.repository.restore(from: backup) == [kept.id])
        #expect(try f.repository.count() == 1)
        #expect(try f.browseIds(filter: "note") == [kept.id])
        #expect(try f.repository.listDeleted().isEmpty)
    }

    /// A version 1 database gains the index and the paging indexes, and its notes stay findable.
    @Test func versionOneMigratesAndStaysFindable() throws {
        let directory = TempDirectory()
        let path = directory.file("notes.sqlite")
        let db = try SQLiteDatabase(path: path)
        try Migrations.migrate(db, upTo: 1)
        try Self.insertRaw(db, id: "01HF7YAT000000000000000001", text: "Café old\nquixotic body")
        db.close()
        let repository = try NotesRepository(path: path, clock: TestClock().function)
        #expect(try repository.schemaVersion() == 2)
        #expect(try repository.browse(filter: "quixotic").items.map(\.id) == ["01HF7YAT000000000000000001"])
        #expect(try repository.list(filter: "CAFÉ").items.map(\.id) == ["01HF7YAT000000000000000001"])
        let check = try SQLiteDatabase(path: path, readOnly: true)
        let objects = try check.query("SELECT name FROM sqlite_master WHERE name IN ('notes_fts', 'notes_list_page', 'notes_browse_page') ORDER BY name") { $0.text(0) }
        #expect(objects == ["notes_browse_page", "notes_fts", "notes_list_page"])
    }

    /// Where the trigram tokenizer is missing, version 2 still applies without the index, and
    /// every filter keeps the folded LIKE results.
    @Test func withoutTheTokenizerTheVersionAdvancesAndLikeAnswers() throws {
        let directory = TempDirectory()
        let path = directory.file("notes.sqlite")
        let db = try SQLiteDatabase(path: path)
        #expect(try Migrations.migrate(db, fts: false) == [1, 2])
        #expect(try db.queryFirst("SELECT count(*) FROM sqlite_master WHERE name = 'notes_fts'") { $0.int(0) } == 0)
        try Self.insertRaw(db, id: "01HF7YAT000000000000000002", text: "Café plain\nquixotic")
        db.close()
        let repository = try NotesRepository(path: path, clock: TestClock().function)
        #expect(try repository.browse(filter: "quixotic").items.map(\.id) == ["01HF7YAT000000000000000002"])
        #expect(try repository.browse(filter: "ca").items.map(\.id) == ["01HF7YAT000000000000000002"])
        // A table of that name that cannot answer MATCH (a damaged or foreign index): the failed
        // MATCH drops the index for the process and the LIKE scan answers.
        let other = directory.file("other.sqlite")
        let odd = try SQLiteDatabase(path: other)
        try Migrations.migrate(odd, fts: false)
        try odd.execute("CREATE TABLE notes_fts (id TEXT, title_fold TEXT, text_fold TEXT)")
        try Self.insertRaw(odd, id: "01HF7YAT000000000000000003", text: "Café odd\nquixotic")
        odd.close()
        let fallback = try NotesRepository(path: other, clock: TestClock().function)
        #expect(try fallback.browse(filter: "quixotic").items.map(\.id) == ["01HF7YAT000000000000000003"])
        #expect(try fallback.list(filter: "café odd").items.map(\.id) == ["01HF7YAT000000000000000003"])
    }

    /// The trigger delete by `id` cannot seek: `id` is UNINDEXED and `notes` is WITHOUT
    /// ROWID, so there is no FTS rowid for the trigger to delete by. This pins the query
    /// plan evidence; making the delete indexed needs a schema version that stores an
    /// integer rowid per note, which needs a protocol version the lead allocates.
    @Test func ftsDeleteByIdScansAndOnlyARowidDeleteSeeks() throws {
        let f = try Fixture()
        _ = try f.make("cafe body")
        let check = try SQLiteDatabase(path: f.directory.file("notes.sqlite"), readOnly: true)
        defer { check.close() }
        func plan(_ sql: String) throws -> String {
            try check.query(sql) { $0.text(3) }.joined(separator: " | ")
        }
        let byId = try plan("EXPLAIN QUERY PLAN DELETE FROM notes_fts WHERE id = 'x'")
        #expect(byId.contains("SCAN notes_fts"))
        #expect(!byId.contains(":="))
        let byRowid = try plan("EXPLAIN QUERY PLAN DELETE FROM notes_fts WHERE rowid = 1")
        #expect(byRowid.contains(":="))
        let notesSQL = try check.queryFirst("SELECT sql FROM sqlite_master WHERE name = 'notes'") { $0.text(0) }
        #expect(notesSQL?.contains("WITHOUT ROWID") == true)
        let ftsSQL = try check.queryFirst("SELECT sql FROM sqlite_master WHERE name = 'notes_fts'") { $0.text(0) }
        #expect(ftsSQL?.contains("id UNINDEXED") == true)
    }

    /// A read only open must fail at open, not at the first query, so the repository can
    /// fall back to the writer connection when the reader cannot be opened.
    @Test func readOnlyOpenSurfacesACorruptFileAtOpen() throws {
        let directory = TempDirectory()
        let path = directory.file("corrupt.sqlite")
        try "not a database, only padding text........................".write(toFile: path, atomically: true, encoding: .utf8)
        #expect(throws: SQLiteError.self) { try SQLiteDatabase(path: path, readOnly: true) }
    }

    /// The tokenizer probe answers directly, leaves no probe table behind, and reports
    /// false when the database cannot be probed at all.
    @Test func tokenizerProbeReportsAndLeavesNothingBehind() throws {
        let directory = TempDirectory()
        let db = try SQLiteDatabase(path: directory.file("probe.sqlite"))
        #expect(Migrations.ftsAvailable(db))
        #expect(Migrations.ftsAvailable(db))
        #expect(try db.queryFirst("SELECT count(*) FROM sqlite_temp_master WHERE name = 'overnote_fts_probe'") { $0.int(0) } == 0)
        db.close()
        #expect(!Migrations.ftsAvailable(db))
    }

    /// Only an error that names the FTS index may disable it for the process; a transient
    /// lock error or an unrelated SQLite error must not.
    @Test func onlyFTSErrorsProveTheIndexUnusable() {
        #expect(!NotesRepository.ftsErrorProvesIndexUnusable(SQLiteError(code: 5, message: "database is locked")))
        #expect(!NotesRepository.ftsErrorProvesIndexUnusable(SQLiteError(code: 6, message: "database table is locked")))
        #expect(!NotesRepository.ftsErrorProvesIndexUnusable(SQLiteError(code: 11, message: "database disk image is malformed")))
        #expect(!NotesRepository.ftsErrorProvesIndexUnusable(SQLiteError(code: 1, message: "no such column: notes.title_fold")))
        #expect(NotesRepository.ftsErrorProvesIndexUnusable(SQLiteError(code: 1, message: "no such table: notes_fts")))
        #expect(NotesRepository.ftsErrorProvesIndexUnusable(SQLiteError(code: 1, message: "no such column: notes_fts")))
        #expect(NotesRepository.ftsErrorProvesIndexUnusable(SQLiteError(code: 1, message: "malformed MATCH expression")))
    }

    /// A schema 1 backup whose upgrade fails (here a foreign plain table already owns the
    /// `notes_fts` name) is refused before the live database is replaced, so listing the
    /// notes that were already there keeps working without a restart.
    @Test func restoringAnUnmigratableSchemaOneBackupLeavesTheLiveDatabaseWorking() throws {
        let f = try Fixture()
        let kept = try f.make("kept original")
        let backup = f.directory.file("schema1.sqlite")
        let source = try SQLiteDatabase(path: backup)
        try Migrations.migrate(source, upTo: 1)
        try Self.insertRaw(source, id: "01HF7YAT000000000000000009", text: "restored note")
        try source.execute("CREATE TABLE notes_fts (id TEXT, title_fold TEXT, text_fold TEXT)")
        source.close()
        #expect(throws: (any Error).self) { try f.repository.restore(from: backup) }
        #expect(try f.repository.schemaVersion() == 2)
        #expect(try f.listIds() == [kept.id])
        #expect(try f.browseIds(filter: "kept") == [kept.id])
    }

    private static func insertRaw(_ db: SQLiteDatabase, id: String, text: String) throws {
        let title = String(text.split(separator: "\n").first ?? "")
        try db.run(
            """
            INSERT INTO notes (id, title, text, markdown, raw_content, title_fold, text_fold, pinned,
                               created_at, updated_at, deleted_at, last_accessed_at, caret_position)
            VALUES (?, ?, ?, ?, '{}', ?, ?, NULL, 1000, 1000, NULL, 1000, 0)
            """,
            [.text(id), .text(title), .text(text), .text(text), .text(TextFolding.fold(title)), .text(TextFolding.fold(text))])
    }
}

@Suite("Ordering and cursors")
struct OrderingTests {
    @Test func listAndBrowseOrders() throws {
        let f = try Fixture()
        let a = try f.make("a")
        let b = try f.make("b")
        let c = try f.make("c")
        let d = try f.make("d")
        #expect(try f.listIds() == [d.id, c.id, b.id, a.id])
        _ = try f.repository.pin(b.id)
        for note in [c, a, d] {
            f.clock.advance()
            try f.repository.touchAccessed(note.id)
        }
        // list: pinned, then updatedAt desc. browse: pinned, then lastAccessedAt desc.
        #expect(try f.listIds() == [b.id, d.id, c.id, a.id])
        #expect(try f.browseIds() == [b.id, d.id, a.id, c.id])
    }

    @Test func browseFilterRanksTitleMatchesFirstAndWildcardsAreLiteral() throws {
        let f = try Fixture()
        let x = try f.make("Groceries 100%\nmilk", title: "Groceries 100%")
        let y = try f.make("Notes\nremember groceries", title: "Notes")
        try f.make("snake_case")
        f.clock.advance()
        try f.repository.touchAccessed(y.id)
        #expect(try f.browseIds(filter: "GROCÉRIES") == [x.id, y.id])
        #expect(try f.listIds(filter: "groceries") == [y.id, x.id])
        #expect(try f.listIds(filter: "%") == [x.id])
        #expect(try f.listIds(filter: "   ").count == 3)
    }

    @Test(arguments: [ListCursor.Kind.list, .browse])
    func pagingCoversEveryRowOnceAcrossThePinBoundary(kind: ListCursor.Kind) throws {
        let f = try Fixture()
        let notes = try (0..<5).map { try f.make("note \($0)") }
        _ = try f.repository.pin(notes[3].id)
        _ = try f.repository.pin(notes[1].id)
        // Equal lastAccessedAt for two notes exercises the id tie break.
        try f.repository.touchAccessed(notes[0].id)
        try f.repository.touchAccessed(notes[2].id)
        func fetch(_ cursor: String?) throws -> NotePage {
            kind == .list ? try f.repository.list(limit: 2, cursor: cursor) : try f.repository.browse(limit: 2, cursor: cursor)
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
        #expect(ids == Array(titleHits.reversed()) + Array(textHits.reversed()))
    }

    @Test func ulidsStayOrderedWithinAMillisecondAndUnderClockSkew() {
        var generator = ULIDGenerator()
        var previous = generator.next(now: 5000)
        for step in 0..<500 {
            let next = generator.next(now: step % 2 == 0 ? 5000 : 4000)
            #expect(previous < next)
            previous = next
        }
        #expect(ULIDGenerator.isValid(previous))
    }
}

@Suite("Pins")
struct PinTests {
    @Test func pinsAppendWithSpacingAndMovesSwapNeighbors() throws {
        let f = try Fixture()
        let notes = try (0..<3).map { try f.make("n\($0)") }
        f.clock.advance(100)
        #expect(try f.repository.pin(notes[0].id).pinned == 1000)
        #expect(try f.repository.pin(notes[1].id).pinned == 2000)
        #expect(try f.repository.pin(notes[2].id).pinned == 3000)
        #expect(try f.repository.pin(notes[0].id).pinned == 1000)
        func order() throws -> [String] { try f.repository.windowData().pinnedShortcutNoteIds }

        try f.repository.movePinned(notes[2].id, .up)
        #expect(try order() == [notes[0].id, notes[2].id, notes[1].id])
        try f.repository.movePinned(notes[0].id, .up)
        #expect(try order() == [notes[0].id, notes[2].id, notes[1].id])
        try f.repository.movePinned(notes[1].id, .down)
        #expect(try order() == [notes[0].id, notes[2].id, notes[1].id])
        try f.repository.movePinned(notes[0].id, .down)
        #expect(try order() == [notes[2].id, notes[0].id, notes[1].id])
        // Pins never move updatedAt, so they never reorder the window stack.
        #expect(try f.repository.get(notes[0].id).updatedAt == notes[0].updatedAt)
        let unpinned = try f.repository.unpin(notes[1].id)
        #expect(unpinned.updatedAt == notes[1].updatedAt)
        // The largest remaining key is 2000 after the swaps, so the re-pin lands at 3000.
        #expect(try f.repository.pin(notes[1].id).pinned == 3000)
    }
}

@Suite("Trash purge")
struct PurgeTests {
    @Test func purgeRemovesOnlyNotesStrictlyOlderThanSixtyDays() throws {
        let f = try Fixture()
        let old = try f.make("old")
        let edge = try f.make("edge")
        let live = try f.make("live")
        let day: Millis = 24 * 60 * 60 * 1000
        let start = f.clock.now
        try f.repository.delete(old.id)
        f.clock.now = start + 1000
        try f.repository.delete(edge.id)
        // Exactly 60 days after `edge` was deleted: not strictly older, so it stays.
        f.clock.now = start + 1000 + 60 * day
        #expect(try f.repository.purgeExpiredTrash() == [old.id])
        f.clock.advance(1)
        #expect(try f.repository.purgeExpiredTrash() == [edge.id])
        #expect(try f.repository.get(live.id).id == live.id)
    }
}

@Suite("Panel frame")
struct PanelFrameTests {
    /// A 1440 x 900 display whose menu bar takes the top 24 pt.
    let visible = CGRect(x: 0, y: 0, width: 1440, height: 876)
    let key = "display@1440x900"

    /// Tiling or a window manager puts the panel flush left at half width and full height: the
    /// helper keeps that frame, and the next show opens it exactly there again.
    @Test func aTiledFrameIsStoredAndPlacedBackExactly() {
        let tiled = CGRect(x: visible.minX, y: visible.minY, width: visible.width / 2, height: visible.height)
        #expect(PanelGeometry.keepOnScreen(tiled, visible: visible, minimum: PanelSizing.floorSize) == tiled)
        let stored = PanelGeometry.recording(tiled, displayKey: key, in: nil, autoSize: false, temporary: false)
        #expect(stored == PanelFrame(x: 0, y: 876, width: 720, height: 876, displays: [key: PanelPoint(x: 0, y: 876)]))
        let placed = PanelGeometry.placement(
            stored: stored, displayKey: key, visible: visible, width: CGFloat(stored.width),
            height: CGFloat(stored.height ?? 0), minimum: PanelSizing.floorSize)
        #expect(placed == tiled)
        // A move to another display remembers both, and the legacy point follows the last move.
        let other = CGRect(x: 1500, y: 100, width: 720, height: 876)
        let moved = PanelGeometry.recording(other, displayKey: "second", in: stored, autoSize: false, temporary: false)
        #expect(moved.displays == [key: PanelPoint(x: 0, y: 876), "second": PanelPoint(x: 1500, y: 976)])
        #expect(moved.x == 1500 && moved.y == 976)
    }

    @Test func autoSizingAndTemporaryGrowthNeverStoreTheirHeight() {
        let frame = CGRect(x: 100, y: 200, width: 640, height: 300)
        let previous = PanelFrame(x: 0, y: 876, width: 640, height: 500)
        #expect(PanelGeometry.recording(frame, displayKey: key, in: previous, autoSize: true, temporary: false).height == nil)
        #expect(PanelGeometry.recording(frame, displayKey: key, in: previous, autoSize: false, temporary: true).height == 500)
        // Within the 2 pt tolerance a resize is width only and leaves auto-sizing on.
        #expect(!PanelGeometry.changesHeight(from: frame, to: frame.insetBy(dx: 0, dy: 1), tolerance: 2))
        #expect(PanelGeometry.changesHeight(from: frame, to: frame.insetBy(dx: 0, dy: 2), tolerance: 2))
        // A frame past the display edge comes back on screen with its top edge kept.
        let off = CGRect(x: -50, y: 700, width: 640, height: 300)
        #expect(PanelGeometry.keepOnScreen(off, visible: visible, minimum: PanelSizing.floorSize) == CGRect(x: 0, y: 576, width: 640, height: 300))
        // A frame set from outside below the minimum (a window manager's quarter tile on a small
        // display) grows to it, keeping its top left corner.
        let small = CGRect(x: 0, y: 676, width: 300, height: 100)
        #expect(PanelGeometry.keepOnScreen(small, visible: visible, minimum: PanelSizing.floorSize) == CGRect(x: 0, y: 579, width: 405, height: 197))
    }
}

@Suite("Panel placement")
struct PanelPlacementTests {
    let minimum = PanelSizing.floorSize

    /// Fill is the visible frame; left and right meet exactly, the left half taking the odd
    /// point; center keeps the size, clamped to the minimum and the display.
    @Test func placementsPartitionTheVisibleFrameByWholePoints() {
        let visible = CGRect(x: 0, y: 0, width: 1441, height: 876)
        let current = CGSize(width: 640, height: 560)
        #expect(PanelGeometry.placed(.fill, current: current, visible: visible, minimum: minimum) == visible)
        let left = PanelGeometry.placed(.left, current: current, visible: visible, minimum: minimum)
        let right = PanelGeometry.placed(.right, current: current, visible: visible, minimum: minimum)
        #expect(left == CGRect(x: 0, y: 0, width: 721, height: 876))
        #expect(right == CGRect(x: 721, y: 0, width: 720, height: 876))
        #expect(left.maxX == right.minX && right.maxX == visible.maxX)
        // A second display left of the primary, with a fractional edge from scaling.
        let second = CGRect(x: -1280, y: 100, width: 1280.5, height: 775.5)
        let half = PanelGeometry.placed(.left, current: current, visible: second, minimum: minimum)
        #expect(half == CGRect(x: -1280, y: 100, width: 640, height: 775))
        #expect(PanelGeometry.placed(.right, current: current, visible: second, minimum: minimum).minX == half.maxX)
        #expect(
            PanelGeometry.placed(.center, current: current, visible: visible, minimum: minimum)
                == CGRect(x: 400, y: 158, width: 640, height: 560))
        // The zoomed minimum wins over a smaller panel, the display over a larger one.
        let zoomed = CGSize(width: 747, height: 278)
        #expect(
            PanelGeometry.placed(.center, current: CGSize(width: 300, height: 100), visible: visible, minimum: zoomed).size
                == zoomed)
        #expect(
            PanelGeometry.placed(.center, current: CGSize(width: 3000, height: 2000), visible: visible, minimum: minimum)
                == visible)
        // A half narrower than the minimum grows to it from its own screen edge.
        let narrow = CGRect(x: 0, y: 0, width: 800, height: 600)
        #expect(PanelGeometry.placed(.right, current: current, visible: narrow, minimum: minimum).minX == 395)
        // A visible frame with a fractional top edge is placed inside the whole point frame
        // below that top: no placed frame may cross the fractional maxY.
        let fractional = CGRect(x: -10.4, y: 100.4, width: 1280.5, height: 775.5)
        #expect(PanelGeometry.placed(.fill, current: current, visible: fractional, minimum: minimum) == CGRect(x: -10, y: 101, width: 1280, height: 774))
        for placement in PanelPlacement.allCases {
            #expect(PanelGeometry.placed(placement, current: current, visible: fractional, minimum: minimum).maxY <= fractional.maxY)
        }
    }

    /// Unplugging display A clears A's placement and leaves B's, including B at another size.
    /// A resolution change keeps the uuid connected, so that placement stays.
    @Test func unpluggingADisplayClearsOnlyThatDisplay() {
        let keyA = "UUID-A@1440x900"
        let keyB = "UUID-B@1440x900"
        let keyBResized = "UUID-B@1680x1050"
        let stored = PanelFrame(
            x: 0, y: 876, width: 720, height: 876,
            displays: [
                keyA: PanelPoint(x: 0, y: 876, width: 720, height: 876, placement: .left),
                keyB: PanelPoint(x: 720, y: 876, width: 720, height: 876, placement: .right),
                keyBResized: PanelPoint(x: 800, y: 1000, width: 840, height: 1000, placement: .fill),
            ])
        let cleared = PanelGeometry.clearingDisconnected(in: stored, connectedKeys: [keyB])
        #expect(cleared?.displays[keyA] == PanelPoint(x: 0, y: 876))
        #expect(PanelGeometry.storedPlacement(in: cleared, displayKey: keyA) == nil)
        #expect(cleared?.displays[keyB]?.placement == .right)
        #expect(cleared?.displays[keyBResized]?.placement == .fill)
        #expect(PanelGeometry.clearingDisconnected(in: stored, connectedKeys: [keyA, keyBResized]) == stored)
        // The system then records the landed frame on B and keeps B's placement.
        let landed = CGRect(x: 40, y: 60, width: 640, height: 500)
        let afterMove = PanelGeometry.recording(
            landed, displayKey: keyB, in: cleared, autoSize: false, temporary: false, keepsPlacement: true)
        #expect(afterMove.displays[keyA] == PanelPoint(x: 0, y: 876))
        #expect(PanelGeometry.storedPlacement(in: afterMove, displayKey: keyB) == .right)
    }

    /// Turning auto-sizing on forgets the shared height and every display's placement.
    /// The remembered points stay.
    @Test func turningAutoSizingOnClearsEveryDisplay() {
        let keyA = "UUID-A@1440x900"
        let keyB = "UUID-B@1440x900"
        let stored = PanelFrame(
            x: 0, y: 876, width: 720, height: 876,
            displays: [
                keyA: PanelPoint(x: 0, y: 876, width: 720, height: 876, placement: .left),
                keyB: PanelPoint(x: 720, y: 876, width: 720, height: 876, placement: .right),
            ])
        let cleared = PanelGeometry.clearingAllPlacements(in: stored)
        #expect(cleared?.height == nil)
        #expect(cleared?.displays[keyA] == PanelPoint(x: 0, y: 876))
        #expect(cleared?.displays[keyB] == PanelPoint(x: 720, y: 876))
        #expect(PanelGeometry.storedPlacement(in: cleared, displayKey: keyA) == nil)
        #expect(PanelGeometry.storedPlacement(in: cleared, displayKey: keyB) == nil)
        let plain = PanelFrame(x: 1, y: 2, width: 640, displays: [keyA: PanelPoint(x: 1, y: 2)])
        #expect(PanelGeometry.clearingAllPlacements(in: plain) == plain)
    }

    /// A clear asked for while the panel has no display stays pending, and a system relocation
    /// keeps the destination placement once a display is known.
    @Test func aClearWithNoDisplayStaysPending() {
        let held = PanelGeometry.placementClearOnSave(clearRequested: true, systemRelocation: false, hasDisplay: false)
        #expect(held.keepsPlacement)
        #expect(held.clearRequested)
        #expect(!held.systemRelocation)
        let applied = PanelGeometry.placementClearOnSave(clearRequested: true, systemRelocation: false, hasDisplay: true)
        #expect(!applied.keepsPlacement)
        #expect(!applied.clearRequested)
        #expect(!applied.systemRelocation)
        let relocated = PanelGeometry.placementClearOnSave(clearRequested: true, systemRelocation: true, hasDisplay: true)
        #expect(relocated.keepsPlacement)
        #expect(!relocated.clearRequested)
        #expect(!relocated.systemRelocation)
        let quiet = PanelGeometry.placementClearOnSave(clearRequested: false, systemRelocation: false, hasDisplay: true)
        #expect(quiet.keepsPlacement)
        #expect(!quiet.clearRequested)
    }

    /// A placement is stored with the display's point, runs again for that display at another
    /// resolution (matched by uuid), and any later recording that is not the helper's own clears it.
    @Test func aStoredPlacementFollowsTheDisplayUntilThePersonMovesThePanel() {
        let key = "UUID-A@1440x900"
        let placed = CGRect(x: 0, y: 0, width: 720, height: 876)
        let stored = PanelGeometry.placing(
            .left, frame: placed, displayKey: key, in: PanelFrame(x: 5, y: 6, width: 640, displays: ["UUID-B@800x600": PanelPoint(x: 1, y: 2)]),
            autoSize: false, temporary: false)
        #expect(stored.displays[key] == PanelPoint(x: 0, y: 876, width: 720, height: 876, placement: .left))
        #expect(stored.displays["UUID-B@800x600"] == PanelPoint(x: 1, y: 2))
        #expect(stored.width == 720 && stored.height == 876)
        #expect(PanelGeometry.storedPlacement(in: stored, displayKey: key) == .left)
        #expect(PanelGeometry.storedPlacement(in: stored, displayKey: "UUID-A@1920x1080") == .left)
        #expect(PanelGeometry.storedPlacement(in: stored, displayKey: "UUID-B@1024x768") == nil)
        // The helper's own move or resize (auto height, a hide) keeps the placement.
        let kept = PanelGeometry.recording(placed, displayKey: key, in: stored, autoSize: false, temporary: false, keepsPlacement: true)
        #expect(kept.displays[key]?.placement == .left)
        // The person's drag or resize keeps the frame and clears the placement.
        let moved = placed.offsetBy(dx: 30, dy: -40)
        let cleared = PanelGeometry.recording(moved, displayKey: key, in: stored, autoSize: false, temporary: false)
        #expect(cleared.displays[key] == PanelPoint(x: 30, y: 836))
        #expect(PanelGeometry.storedPlacement(in: cleared, displayKey: key) == nil)
        // The exact key wins: once cleared at this resolution, the old one never runs again.
        var mixed = cleared
        mixed.displays["UUID-A@1920x1080"] = PanelPoint(x: 0, y: 1050, width: 960, height: 1050, placement: .fill)
        #expect(PanelGeometry.storedPlacement(in: mixed, displayKey: key) == nil)
    }

    /// A hide after the display changed resolution while the panel stayed open records under a
    /// new key for the same display uuid, and the placement carries over to it.
    @Test func aHideAfterAResolutionChangeKeepsThePlacement() {
        let filled = CGRect(x: 0, y: 0, width: 1440, height: 876)
        let stored = PanelGeometry.placing(
            .fill, frame: filled, displayKey: "UUID-A@1440x900", in: nil, autoSize: false, temporary: false)
        let hidden = PanelGeometry.recording(
            filled, displayKey: "UUID-A@1680x1050", in: stored, autoSize: false, temporary: false, keepsPlacement: true)
        #expect(PanelGeometry.storedPlacement(in: hidden, displayKey: "UUID-A@1680x1050") == .fill)
    }

    /// Points stored before placements existed read back and write back unchanged; placed ones
    /// round trip with their size and placement, and a bad placement is refused.
    @Test func settingsRoundTripOldAndPlacedDisplayPoints() throws {
        let old: JSONValue = ["x": 10.0, "y": 900.0, "width": 640.0, "displays": ["UUID-A@1440x900": ["x": 10.0, "y": 900.0]]]
        let oldSettings = try Settings.defaults.applying(["panelFrame": old])
        #expect(oldSettings.panelFrame?.json == old)
        let placed: JSONValue = [
            "x": 0.0, "y": 876.0, "width": 720.0, "height": 876.0,
            "displays": ["UUID-A@1440x900": ["x": 0.0, "y": 876.0, "width": 720.0, "height": 876.0, "placement": "left"]],
        ]
        let placedSettings = try Settings.defaults.applying(["panelFrame": placed])
        #expect(placedSettings.panelFrame?.displays["UUID-A@1440x900"]?.placement == .left)
        #expect(placedSettings.panelFrame?.json == placed)
        let f = try Fixture()
        _ = try f.repository.setSettings(["panelFrame": placed])
        #expect(try f.repository.settings().panelFrame?.json == placed)
        let bad: JSONValue = ["x": 0.0, "y": 0.0, "width": 640.0, "displays": ["k": ["x": 0.0, "y": 0.0, "placement": "top"]]]
        #expect(throws: RPCError.self) { _ = try Settings.defaults.applying(["panelFrame": bad]) }
    }

    @Test func windowPlaceAnswersOnBothChannelsAndRefusesOtherPlacements() async throws {
        let f = try Fixture()
        let host = RecordingHost()
        let dispatcher = RPCDispatcher(repository: f.repository, host: host)
        func code(_ params: JSONValue, source: RPCSource) async -> Int? {
            do {
                _ = try await dispatcher.handle(method: "window.place", params: params, source: source)
                return nil
            } catch {
                return (error as? RPCError)?.code
            }
        }
        let result = try await dispatcher.handle(method: "window.place", params: ["placement": "right"], source: .socket)
        #expect(result == ["placement": "right", "frame": ["x": 720.0, "y": 875.0, "width": 720.0, "height": 875.0]])
        #expect(await code(["placement": "center"], source: .bridge) == nil)
        #expect(await code(["placement": "top"], source: .socket) == RPCError.badParamsCode)
        #expect(await code(["placement": 1], source: .bridge) == RPCError.badParamsCode)
        #expect(await code([:], source: .socket) == RPCError.badParamsCode)
        #expect(host.calls == [.place(.right), .place(.center)])
    }
}

@Suite("Update conflict")
struct UpdateConflictTests {
    @Test func staleExpectedUpdatedAtWritesNothingAndTimestampsAlwaysMove() throws {
        let f = try Fixture()
        let note = try f.make("one")
        // Same millisecond: updatedAt still moves, so the next expectation can detect it.
        let first = try f.repository.update(note.id, NotePatch(text: "two", expectedUpdatedAt: note.updatedAt))
        #expect(first.note.updatedAt == note.updatedAt + 1)
        let stale = try f.repository.update(note.id, NotePatch(text: "three", expectedUpdatedAt: note.updatedAt))
        #expect(stale == .conflict(first.note))
        #expect(stale.json["status"] == "conflict")
        #expect(try f.repository.get(note.id).content.text == "two")
        // A caret only update never moves updatedAt.
        f.clock.advance(100)
        let caret = try f.repository.update(note.id, NotePatch(caretPosition: 3))
        #expect(caret.note.updatedAt == first.note.updatedAt)
    }
}

@Suite("Current note")
struct CurrentNoteTests {
    /// A background create or duplicate (an agent writing through the socket) must not move the
    /// note the panel opens on; only a create that shows the panel does.
    @Test func onlyAShownCreateMovesTheCurrentNote() async throws {
        let f = try Fixture()
        let host = RecordingHost()
        let dispatcher = RPCDispatcher(repository: f.repository, host: host)
        func call(_ method: String, _ params: JSONValue) async throws -> JSONValue {
            try await dispatcher.handle(method: method, params: params, source: .socket)
        }
        let content: JSONValue = ["rawContent": #"{"type":"doc"}"#, "text": "x", "markdown": "x", "title": "x"]
        func with(_ extra: [String: JSONValue]) -> JSONValue {
            guard case .object(var object) = content else { return content }
            object.merge(extra) { _, new in new }
            return .object(object)
        }

        let open = try f.make("open")
        try f.repository.setCurrentNote(open.id)
        let quiet = try await call("notes.create", content)
        let hidden = try await call("notes.create", with(["show": false]))
        _ = try await call("notes.duplicate", ["id": .string(open.id)])
        #expect(try f.repository.currentNoteId() == open.id)
        #expect(quiet["id"] != hidden["id"])
        #expect(host.events.allSatisfy { $0.0 != "note.new" })
        #expect(!host.calls.contains(.show))

        let shown = try await call("notes.create", with(["show": true]))
        #expect(try f.repository.currentNoteId() == shown["id"]?.stringValue)
        #expect(host.events.contains { $0.0 == "note.new" })
        #expect(host.calls.contains(.show))
    }
}

@Suite("Duplicate")
struct DuplicateTests {
    /// A renamed copy must keep its title and first line in step, and the helper never derives
    /// content, so it stores the content core built verbatim and refuses the old title-only suffix.
    @Test func storesTheGivenContentAndRefusesATitleOnlySuffix() async throws {
        let f = try Fixture()
        let dispatcher = RPCDispatcher(repository: f.repository, host: RecordingHost())
        func call(_ method: String, _ params: JSONValue) async throws -> JSONValue {
            try await dispatcher.handle(method: method, params: params, source: .socket)
        }
        let source = try f.make("Groceries\n\nmilk", title: "Groceries")

        let plain = try await call("notes.duplicate", ["id": .string(source.id)])
        #expect(plain["title"] == "Groceries")
        #expect(plain["rawContent"]?.stringValue == source.content.rawContent)

        let copy = try await call(
            "notes.duplicate",
            [
                "id": .string(source.id), "rawContent": #"{"type":"doc","copy":true}"#,
                "markdown": "# Groceries copy\n\nmilk", "text": "Groceries copy\n\nmilk", "title": "Groceries copy",
            ])
        #expect(copy["title"] == "Groceries copy")
        #expect(copy["text"] == "Groceries copy\n\nmilk")
        #expect(copy["markdown"] == "# Groceries copy\n\nmilk")
        #expect(copy["rawContent"] == #"{"type":"doc","copy":true}"#)
        #expect(copy["caretPosition"] == 0)
        #expect(try f.listIds(filter: "groceries COPY") == [copy["id"]?.stringValue])
        #expect(try f.repository.get(source.id).content == source.content)

        func errorCode(_ params: JSONValue) async -> Int? {
            do {
                _ = try await call("notes.duplicate", params)
                return nil
            } catch {
                return (error as? RPCError)?.code
            }
        }
        let count = try f.repository.count()
        #expect(await errorCode(["id": .string(source.id), "titleSuffix": " copy"]) == RPCError.badParamsCode)
        #expect(await errorCode(["id": .string(source.id), "title": "Groceries copy"]) == RPCError.badParamsCode)
        #expect(await errorCode(["id": "missing", "rawContent": "{}"]) == RPCError.noteNotFound("missing").code)
        #expect(try f.repository.count() == count)
    }
}

@Suite("Panel size")
struct PanelSizeTests {
    @Test func theMinimumIsTheEditorsReportButNeverBelowTheFloor() {
        let floor = CGSize(width: 405, height: 197)
        #expect(PanelSizing.minimumSize(reported: nil) == floor)
        // 100%: the bars plus one line fit well inside the floor.
        #expect(PanelSizing.minimumSize(reported: CGSize(width: 341, height: 142.3)) == floor)
        // 200% with the format bar: wider and taller than the floor, rounded up to whole points.
        #expect(PanelSizing.minimumSize(reported: CGSize(width: 746.2, height: 277.9)) == CGSize(width: 747, height: 278))
    }

    @Test func contentHeightsStayBetweenTheMinimumAndTheZoomedMaximum() {
        #expect(PanelSizing.autoHeight(50, minimum: 197, zoom: 1) == 197)
        #expect(PanelSizing.autoHeight(300, minimum: 197, zoom: 1) == 300)
        #expect(PanelSizing.autoHeight(5000, minimum: 197, zoom: 1) == 860)
        #expect(PanelSizing.autoHeight(5000, minimum: 278, zoom: 1.5) == 1290)
        #expect(PanelSizing.autoHeight(50, minimum: 278, zoom: 2) == 278)
    }

    @Test func savedFramesGrowToTheMinimumAndStayOnTheDisplay() {
        let minimum = CGSize(width: 405, height: 197)
        let display = CGSize(width: 1512, height: 944)
        // A frame saved by an older build, at its old 396 x 128 minimum.
        #expect(PanelSizing.clamped(CGSize(width: 396, height: 128), minimum: minimum, available: display) == minimum)
        #expect(
            PanelSizing.clamped(CGSize(width: 640, height: 560), minimum: minimum, available: display)
                == CGSize(width: 640, height: 560))
        #expect(
            PanelSizing.clamped(CGSize(width: 3000, height: 100), minimum: minimum, available: display)
                == CGSize(width: 1512, height: 197))
    }

    @Test func theBridgeChecksTheEditorsMinimumAndTheSocketCannotSendIt() async throws {
        let f = try Fixture()
        let host = RecordingHost()
        let dispatcher = RPCDispatcher(repository: f.repository, host: host)
        func code(_ params: JSONValue, source: RPCSource = .bridge) async -> Int? {
            do {
                _ = try await dispatcher.handle(method: "window.setMinimumSize", params: params, source: source)
                return nil
            } catch {
                return (error as? RPCError)?.code
            }
        }
        #expect(await code(["width": 669, "height": 277.9]) == nil)
        #expect(host.calls == [.minimumSize(669, 277.9)])
        #expect(await code(["width": 0, "height": 200]) == RPCError.badParamsCode)
        #expect(await code(["width": 400, "height": -1]) == RPCError.badParamsCode)
        #expect(await code(["width": "wide", "height": 200]) == RPCError.badParamsCode)
        #expect(await code(["width": 400, "height": 200], source: .socket) == RPCError.methodNotFoundCode)
        #expect(await code(["height": 0], source: .bridge) == RPCError.badParamsCode)
        #expect(host.calls.count == 1)
        // The old overhang method is gone.
        await #expect(throws: RPCError.self) {
            _ = try await dispatcher.handle(method: "window.setOverhang", params: ["height": 0], source: .bridge)
        }
    }
}

@Suite("RPC framing")
struct FramingTests {
    @Test func malformedLinesGetErrorsWithTheRightId() async throws {
        let f = try Fixture()
        let handler = RPCLineHandler(dispatcher: RPCDispatcher(repository: f.repository, host: RecordingHost()), source: .socket)
        func response(_ line: String) async throws -> JSONValue { try JSONValue.parse(await handler.handle(line: line)) }
        #expect(try await response("nope") == ["id": nil, "error": ["code": -32602, "message": "Request is not valid JSON"]])
        #expect(try await response("[1]")["error"]?["code"] == -32602)
        let noMethod = try await response(#"{"id":"a"}"#)
        #expect(noMethod["id"] == "a")
        #expect(noMethod["error"]?["code"] == -32602)
        let badParams = try await response(#"{"id":3,"method":"notes.get","params":7}"#)
        #expect(badParams["id"] == 3)
        #expect(badParams["error"]?["code"] == -32602)
        #expect(try await response(#"{"id":4,"method":"nope"}"#)["error"]?["code"] == -32601)
        #expect(try await response(#"{"id":5,"method":"notes.count"}"#) == ["id": 5, "result": ["count": 0]])
    }

    @Test(arguments: [
        ("Shopping list.md", "Shopping list.md"),
        ("../../etc/passwd", "Untitled....etcpasswd"),
        ("a/b\\c:d.md", "abcd.md"),
        ("tab\tand\nnewline.txt", "tabandnewline.txt"),
        (".md", "Untitled.md"),
        ("", "Untitled"),
        ("\u{7}\u{1B}", "Untitled"),
    ])
    func saveAsNamesAreSanitized(input: String, expected: String) {
        #expect(FileNameSanitizer.sanitize(input) == expected)
    }

    @Test func longSaveAsNamesFitAPFSAndKeepTheirExtension() {
        let latin = FileNameSanitizer.sanitize(String(repeating: "a", count: 300) + ".md")
        #expect(latin.hasSuffix(".md") && latin.utf8.count <= 240)
        let cjk = FileNameSanitizer.sanitize(String(repeating: "笔", count: 200) + ".html")
        #expect(cjk.hasSuffix("笔.html") && cjk.utf8.count <= 240)
    }

    @Test(arguments: [
        ("https://example.com/a?b=1", true),
        ("http://localhost:3000", true),
        ("mailto:someone@example.com", true),
        ("raycast://extensions/raycast/notes", true),
        ("file:///etc/passwd", false),
        ("javascript:alert(1)", false),
        ("overnote://app/index.html", false),
        ("https://", false),
        ("not a url", false),
    ])
    func openURLAllowsOnlyWebMailAndRaycastLinks(url: String, allowed: Bool) {
        #expect((LinkPolicy.openableURL(url) != nil) == allowed)
    }

    @Test func editorAssetsNeverEscapeTheEditorDirectory() throws {
        let directory = TempDirectory()
        let editor = directory.file("editor")
        try FileManager.default.createDirectory(atPath: editor + "/assets", withIntermediateDirectories: true)
        try "<html>".write(toFile: editor + "/index.html", atomically: true, encoding: .utf8)
        try "x".write(toFile: editor + "/assets/app.js", atomically: true, encoding: .utf8)
        try "secret".write(toFile: directory.file("secret.txt"), atomically: true, encoding: .utf8)
        try FileManager.default.createSymbolicLink(atPath: editor + "/link.txt", withDestinationPath: directory.file("secret.txt"))
        let assets = EditorAssets(directory: editor)
        func file(_ text: String) throws -> String? { assets.file(for: try #require(URL(string: text)))?.lastPathComponent }

        #expect(try file("overnote://app/") == "index.html")
        #expect(try file("overnote://app/assets/app.js") == "app.js")
        #expect(try file("overnote://app/../secret.txt") == nil)
        #expect(try file("overnote://app/%2E%2E/secret.txt") == nil)
        #expect(try file("overnote://app/assets/..%2F..%2Fsecret.txt") == nil)
        #expect(try file("overnote://app/link.txt") == nil)
        #expect(try file("overnote://other/index.html") == nil)
    }

    /// A long request in many small reads, with UTF-8 sequences split across them, a bad line, a blank
    /// line, and a second request pipelined behind it, comes through the real socket byte identical.
    @Test func aLargeRequestInSmallPiecesKeepsItsBytesAndThePipelinedRequestBehindIt() throws {
        final class ReadLog: @unchecked Sendable {
            private let lock = NSLock()
            private(set) var sizes: [Int] = []
            func record(_ size: Int) { lock.withLock { sizes.append(size) } }
        }
        let reads = ReadLog()
        let f = try Fixture()
        let note = try f.make("start")
        let handler = RPCLineHandler(dispatcher: RPCDispatcher(repository: f.repository, host: RecordingHost()), source: .socket)
        let server = SocketServer(path: f.directory.file("s.sock"), readChunkSize: 997, onRead: { reads.record($0) }) {
            await handler.handle(line: $0)
        }
        try server.start()
        defer { server.stop() }
        let client = try RPCClient(path: server.path)

        let text = String(repeating: "héllo 世界 🎉 line\n", count: 12_000)
        let update = JSONValue.object([
            "id": 1, "method": "notes.update",
            "params": ["id": .string(note.id), "markdown": .string(text), "text": .string(text)],
        ]).serialized()
        let get = JSONValue.object(["id": 2, "method": "notes.get", "params": ["id": .string(note.id)]]).serialized()
        var stream: [UInt8] = [0xFF, 0xFE, 0x0A] + Array(" \t\n".utf8)
        stream += Array((update + "\n" + get + "\n").utf8)
        let pieceSize = 1021
        let splitSequences = stride(from: pieceSize, to: stream.count, by: pieceSize).filter { stream[$0] & 0xC0 == 0x80 }
        #expect(splitSequences.count > 10)
        for start in stride(from: 0, to: stream.count, by: pieceSize) {
            try client.send(data: Data(stream[start..<min(start + pieceSize, stream.count)]))
        }
        var responses: [JSONValue] = []
        for _ in 0..<3 { responses.append(try JSONValue.parse(try #require(try client.readLine(timeout: 10)))) }
        // The server really did read in small pieces: every read stayed within its small
        // chunk, there were many of them, and together they took in the whole stream.
        #expect(reads.sizes.count > 100)
        #expect(reads.sizes.allSatisfy { $0 <= 997 })
        #expect(reads.sizes.reduce(0, +) == stream.count)
        #expect(try client.readLine(timeout: 0.3) == nil)
        let badLine = try #require(responses.first { $0["id"] == .null })
        #expect(badLine["error"]?["message"] == "Request is not valid UTF-8")
        let updated = try #require(responses.first { $0["id"] == 1 })
        #expect(updated["result"]?["status"] == "ok")
        let fetched = try #require(responses.first { $0["id"] == 2 })
        let stored = try f.repository.get(note.id).content
        #expect(Array(stored.markdown.utf8) == Array(text.utf8))
        #expect(Array(stored.text.utf8) == Array(text.utf8))
        // Requests on one connection run concurrently, so the read may land before or after the save.
        #expect(fetched["result"]?["id"] == .string(note.id))
        #expect(fetched["result"]?["text"] == .string(text) || fetched["result"]?["text"] == "start")
    }

    /// A line is read in two parts, and the second read also carries the next line. The client must still find that
    /// next line after returning the first, so its scan offset has to restart at zero for the bytes left over.
    /// The test drives a raw socket from one thread, so the order of the reads is fixed and nothing waits on time.
    @Test func theClientFindsAShortLineThatArrivesInTheSameReadAsTheEndOfALongOne() throws {
        let directory = TempDirectory()
        let path = directory.file("s.sock")
        try SocketPaths.prepareDirectory(for: path)
        var address = try SocketPaths.address(for: path)
        let listener = socket(AF_UNIX, SOCK_STREAM, 0)
        #expect(listener >= 0)
        defer { close(listener) }
        let bound = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(listener, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        #expect(bound == 0 && listen(listener, 1) == 0)
        let client = try RPCClient(path: path)
        let peer = accept(listener, nil, nil)
        #expect(peer >= 0)
        defer { close(peer) }

        let head = String(repeating: "a", count: 4000)
        let tail = String(repeating: "b", count: 4000)
        // The head is already queued on the socket, so this read takes it and then times out: the client now holds
        // 4000 bytes with no newline.
        try SocketPaths.writeAll(fd: peer, data: Data(head.utf8), timeout: 3)
        #expect(try client.readLine(timeout: 0.05) == nil)
        // One write carries the end of the long line and the whole short line, so one client read gets both.
        try SocketPaths.writeAll(fd: peer, data: Data((tail + "\nshort\n").utf8), timeout: 3)
        #expect(try client.readLine(timeout: 5) == head + tail)
        // The first line is 8000 bytes and its newline sits at index 8000, so the read buffer
        // compacts before this next line is returned. The remainder has to survive that shift.
        #expect(try client.readLine(timeout: 1) == "short")
    }

    /// A batch of short lines shifts the read buffer a handful of times, not once per line.
    /// The lines are long enough that the consumed prefix passes half the storage.
    @Test func aBatchOfLinesShiftsOnce() {
        var buffer = LineBuffer()
        let lines = (0..<2_000).map { "line-\($0)" }
        var bytes: [UInt8] = []
        for line in lines {
            bytes.append(contentsOf: Array(line.utf8))
            bytes.append(UInt8(ascii: "\n"))
        }
        buffer.append(bytes[...])
        var read: [String] = []
        while let line = buffer.nextLine() {
            read.append(String(decoding: line, as: UTF8.self))
        }
        #expect(read == lines)
        #expect(buffer.shifts > 0)
        #expect(buffer.shifts < 8)
    }
}

@Suite("Backups")
struct BackupTests {
    let day: Millis = 24 * 60 * 60 * 1000

    @Test func retentionKeepsTheLatestTenAndTheNewestOfEachOfTheLastFourIsoWeeks() throws {
        // Thursday 2026-10-15 12:00 UTC (ISO week 42).
        let now: Millis = 1_792_065_600_000
        // Three a day for the last 40 days, newest first: 120 backups.
        let backups = (0..<120).map { index -> (name: String, createdAt: Millis) in
            let createdAt = now - Millis(index) * (day / 3)
            return (BackupName.make(createdAt: createdAt, version: "1.0.0", reason: .daily), createdAt)
        }
        let kept = BackupRetention.kept(backups, now: now)
        let latest = Set(backups.prefix(10).map(\.name))
        #expect(latest.isSubset(of: kept))
        // The latest ten reach back to Monday 12:00 of week 42, so the weekly rule adds the newest
        // backup of weeks 41, 40, and 39: the Sundays 2026-10-11, 10-04, and 09-27 at 20:00.
        let weekly = kept.subtracting(latest).sorted()
        #expect(weekly == [1_791_748_800_000, 1_791_144_000_000, 1_790_539_200_000].map {
            BackupName.make(createdAt: $0, version: "1.0.0", reason: .daily)
        }.sorted())
        #expect(kept.count == 13)
        // Fewer than ten backups are all kept, however old.
        let few = [(name: "a", createdAt: now - 400 * day), (name: "b", createdAt: now)]
        #expect(BackupRetention.kept(few, now: now) == ["a", "b"])
    }

    @Test func restoreOnlyAcceptsBackupFilesInsideTheBackupsFolder() throws {
        let directory = TempDirectory()
        let folder = directory.file("backups")
        try FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true)
        let store = BackupStore(directory: folder)
        // A prerelease version and a hyphenated reason still parse as a backup name.
        let name = BackupName.make(createdAt: 1_792_065_600_123, version: "0.3.0-beta.1", reason: .preUpdate)
        #expect(name == "notes-20261015T120000.123Z-v0.3.0-beta.1-pre-update.sqlite")
        let good = folder + "/" + name
        try "x".write(toFile: good, atomically: true, encoding: .utf8)
        try "x".write(toFile: directory.file(name), atomically: true, encoding: .utf8)
        try "x".write(toFile: folder + "/notes.sqlite", atomically: true, encoding: .utf8)
        let linked = folder + "/" + BackupName.make(createdAt: 1_792_065_600_001, version: "1.0.0", reason: .manual)
        try FileManager.default.createSymbolicLink(atPath: linked, withDestinationPath: directory.file(name))
        try FileManager.default.createDirectory(
            atPath: folder + "/" + BackupName.make(createdAt: 1_792_065_600_002, version: "1.0.0", reason: .manual),
            withIntermediateDirectories: true)

        #expect(try store.validatedRestorePath(good).hasSuffix("/backups/" + name))
        #expect(try store.validatedRestorePath(folder + "/../backups/./" + name).hasSuffix("/backups/" + name))
        func code(_ path: String) -> Int? {
            do {
                _ = try store.validatedRestorePath(path)
                return nil
            } catch let error as RPCError {
                return error.code
            } catch {
                return -1
            }
        }
        #expect(code(directory.file(name)) == RPCError.badParams("").code)  // outside the folder
        #expect(code(folder + "/../" + name) == RPCError.badParams("").code)  // .. out of the folder
        #expect(code(linked) == RPCError.badParams("").code)  // a symlink pointing outside
        #expect(code(folder + "/notes.sqlite") == RPCError.badParams("").code)  // not a backup name
        #expect(code(folder + "/" + BackupName.make(createdAt: 1_792_065_600_002, version: "1.0.0", reason: .manual)) == RPCError.badParams("").code)
        #expect(code(folder + "/missing.sqlite") == RPCError.notFoundCode)
        #expect(code(name) == RPCError.badParams("").code)  // relative
    }

    @Test func restoringTheOldestKeptBackupIsNotPrunedByThePreRestoreBackup() throws {
        let fixture = try Fixture()
        try fixture.make("Kept")
        let folder = fixture.directory.file("backups")
        let store = BackupStore(directory: folder, clock: fixture.clock.function)
        // Ten backups on one day: the oldest is kept only as one of the latest ten, so the
        // pre-restore backup pushes it out of the retention policy.
        for _ in 0..<10 {
            fixture.clock.advance(1000)
            _ = try store.create(reason: .manual) { try fixture.repository.backup(to: $0) }
        }
        let oldest = try #require(try store.list().last)
        fixture.clock.advance(1000)
        let outcome = try store.restore(
            oldest.path, write: { try fixture.repository.backup(to: $0) },
            restore: { try fixture.repository.restore(from: $0) })
        #expect(outcome.restored.name == oldest.name)
        #expect(outcome.preRestore.reason == .preRestore)
        #expect(outcome.result.count == 1)
        // Pruning runs once the restore is done.
        #expect(try store.list().count == 10)
        #expect(!FileManager.default.fileExists(atPath: oldest.path))
    }
}
