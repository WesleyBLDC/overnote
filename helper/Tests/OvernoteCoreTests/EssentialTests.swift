import CoreGraphics
import Darwin
import Foundation
import Testing
@testable import OvernoteCore

// Unit tests are limited to logic end to end tests cannot reach cheaply (the testing policy in
// CONTRIBUTING.md): fold rules, ordering and cursor math, pins, trash purge, the update conflict, RPC
// framing, and the security checks on file names and asset paths. Everything else is covered
// by scripts/smoke-helper.sh and scripts/e2e-window.sh against the real binary.

@Suite("Fold rule")
struct FoldTests {
    @Test(arguments: [
        ("Ünïcödé", "unicode"),
        ("Straße", "straße"),
        ("ﬁle", "file"),
        ("ÅNGSTRÖM", "angstrom"),
        ("Ｆｕｌｌｗｉｄｔｈ", "fullwidth"),
        ("e\u{301}", "e"),
    ])
    func fold(input: String, expected: String) {
        #expect(TextFolding.fold(input) == expected)
    }

    @Test func asciiFastPathMatchesTheGeneralRuleForEveryAsciiScalar() {
        // Every scalar the ASCII gate can admit, in one string: uppercase and lowercase
        // letters, digits, punctuation, and the control characters including NUL and DEL.
        // The expected value is built independently of the implementation, by mapping
        // only A to Z in the UTF-8 bytes and leaving every other byte unchanged.
        let allASCII = String((0...127).map { Character(UnicodeScalar($0)!) })
        let expected = String(decoding: allASCII.utf8.map { byte in
            byte >= 65 && byte <= 90 ? byte + 32 : byte
        }, as: UTF8.self)
        #expect(Array(TextFolding.fold(allASCII).utf8) == Array(expected.utf8))
        #expect(TextFolding.fold("ABC XYZ 0123 [Task] (Done); Note: A,B.C!") == "abc xyz 0123 [task] (done); note: a,b.c!")
        #expect(TextFolding.fold("Tab\tNew\nLine\r\nNUL\u{0}DEL\u{7F}") == "tab\tnew\nline\r\nnul\u{0}del\u{7F}")
    }

    @Test func combiningMarksStayOnTheGeneralPath() {
        // U+0300 and U+0301 are not ASCII, so these sequences must not take the fast path
        // and the marks must still be removed, leaving only the ASCII base letters.
        #expect(TextFolding.fold("E\u{301} A\u{300} Cafe\u{301}") == "e a cafe")
    }

    @Test func likePatternTrimsFoldsAndEscapesWildcards() {
        #expect(TextFolding.likePattern(for: "  \n") == nil)
        #expect(TextFolding.likePattern(for: " Ab ") == "%ab%")
        #expect(TextFolding.likePattern(for: "50%_\\") == "%50\\%\\_\\\\%")
    }

    @Test func foldMatchesTheSharedGoldenCorpus() throws {
        // The same file the TypeScript core tests read, so a note is findable identically
        // from every client: packages/core/tests/fold-corpus.json, relative to this file.
        let here = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        let url = here.appendingPathComponent("../../../packages/core/tests/fold-corpus.json")
        let data = try Data(contentsOf: url)
        let corpus = try JSONDecoder().decode([FoldCase].self, from: data)
        #expect(corpus.count >= 20)
        for entry in corpus {
            #expect(TextFolding.fold(entry.input) == entry.folded, "fold(\(entry.input))")
        }
    }

    private struct FoldCase: Decodable {
        let input: String
        let folded: String
    }

    @Test func ftsPhraseOnlyForIndexableTerms() {
        #expect(TextFolding.ftsPhrase(for: "ab") == nil)
        #expect(TextFolding.ftsPhrase(for: "😀") == nil)
        #expect(TextFolding.ftsPhrase(for: " Café ") == "\"cafe\"")
        #expect(TextFolding.ftsPhrase(for: "say \"hi\" now") == "\"say \"\"hi\"\" now\"")
        #expect(TextFolding.ftsPhrase(for: "   ") == nil)
    }
}

@Suite("FTS search")
struct FTSSearchTests {
    /// Filtered results through the index must equal the folded substring results, including
    /// the terms the index cannot answer and so keep the LIKE path.
    @Test func ftsResultsMatchFoldedSubstringSemantics() throws {
        let f = try Fixture()
        let cafe = try f.make("Café Über\nthe cafe body", title: "Café Über")
        let quix = try f.make("plain\na quixotic paragraph", title: "plain")
        let pct = try f.make("Groceries 100%\nsnake_case stuff", title: "Groceries 100%")
        let emoji = try f.make("Mood 😀 today\nnotes", title: "Mood 😀 today")
        let cjk = try f.make("中文標題測試\nbody", title: "中文標題測試")
        let file = try f.make("ﬁle notes\nbody", title: "ﬁle notes")
        _ = try f.make("unrelated\nnothing here", title: "unrelated")
        func ids(_ filter: String, browse: Bool = true) throws -> [String] {
            browse ? try f.browseIds(filter: filter) : try f.repository.list(filter: filter).items.map(\.id)
        }
        #expect(try ids("cafe") == [cafe.id])
        #expect(try ids("CAFÉ") == [cafe.id])
        #expect(try ids("quixotic") == [quix.id])
        #expect(try ids("quixotic", browse: false) == [quix.id])
        #expect(try ids("100%") == [pct.id])
        #expect(try ids("%") == [pct.id])
        #expect(try ids("snake_case") == [pct.id])
        #expect(try ids("_") == [pct.id])
        #expect(try ids("😀") == [emoji.id])
        #expect(try ids("中文標") == [cjk.id])
        #expect(try ids("中文") == [cjk.id])
        #expect(try ids("file") == [file.id])
        #expect(try ids("ﬁl") == [file.id])
        // Title matches still come before text only matches in a filtered browse.
        #expect(try ids("cafe").first == cafe.id)
    }

    @Test func ftsStaysInSyncAcrossWritesAndSchemaIsVersionTwo() throws {
        let f = try Fixture()
        #expect(try f.repository.schemaVersion() == Migrations.latestVersion)
        #expect(Migrations.latestVersion == 2)
        let note = try f.make("alpha bravo\nbody", title: "alpha bravo")
        #expect(try f.browseIds(filter: "bravo") == [note.id])
        let updated = try f.repository.update(
            note.id, NotePatch(rawContent: "{}", markdown: "charlie delta", text: "charlie delta", title: "charlie delta"))
        #expect(updated.note.content.title == "charlie delta")
        #expect(try f.browseIds(filter: "bravo").isEmpty)
        #expect(try f.browseIds(filter: "delta") == [note.id])
        try f.repository.delete(note.id)
        #expect(try f.browseIds(filter: "delta").isEmpty)
        _ = try f.repository.recover(note.id)
        #expect(try f.browseIds(filter: "delta") == [note.id])
        _ = try f.repository.duplicate(note.id)
        #expect(try f.browseIds(filter: "delta").count == 2)
    }

    /// Reads served by the second connection see every write as soon as it commits.
    @Test func readsThroughTheSecondConnectionReflectWritesImmediately() throws {
        let f = try Fixture()
        let note = try f.make("reader check\nbody", title: "reader check")
        #expect(try f.repository.count() == 1)
        #expect(try f.listIds() == [note.id])
        #expect(try f.browseIds(filter: "reader") == [note.id])
        try f.repository.delete(note.id)
        #expect(try f.repository.count() == 0)
        #expect(try f.repository.listDeleted().map(\.summary.id) == [note.id])
        _ = try f.repository.recover(note.id)
        #expect(try f.repository.count() == 1)
        #expect(try f.repository.listDeleted().isEmpty)
    }

    /// A version 1 database gains the index and the paging indexes, with its notes findable.
    @Test func migrationFromVersionOneBuildsTheIndex() throws {
        let directory = TempDirectory()
        let path = directory.file("notes.sqlite")
        let db = try SQLiteDatabase(path: path)
        _ = try Migrations.migrate(db, upTo: 1)
        try db.run(
            """
            INSERT INTO notes (id, title, text, markdown, raw_content, title_fold, text_fold, pinned,
                               created_at, updated_at, deleted_at, last_accessed_at, caret_position)
            VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, ?, 0)
            """,
            [
                .text("01HF7YAT000000000000000001"), .text("Café old"), .text("Café old\nquixotic body"),
                .text("Café old"), .text("{}"), .text(TextFolding.fold("Café old")),
                .text(TextFolding.fold("Café old\nquixotic body")), .int(1000), .int(1000), .int(1000),
            ])
        db.close()
        let repository = try NotesRepository(path: path, clock: TestClock().function)
        #expect(try repository.schemaVersion() == 2)
        let page = try repository.browse(filter: "quixotic")
        #expect(page.items.map(\.id) == ["01HF7YAT000000000000000001"])
        #expect(try repository.browse(filter: "cafe").items.count == 1)
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
}

@Suite("Socket ingestion")
struct SocketIngestionTests {
    /// One essential end to end test at the socket seam: a large request arrives in many
    /// small pieces (splitting multi byte UTF-8 sequences), a second request is pipelined
    /// behind it on the same connection, and both responses come back matched by id with
    /// the stored content byte identical to what was sent.
    @Test func largeRequestInSmallPiecesWithAPipelinedSecondRequest() async throws {
        let fixture = try Fixture()
        let lineHandler = RPCLineHandler(
            dispatcher: RPCDispatcher(repository: fixture.repository, host: RecordingHost()), source: .socket)
        let server = SocketServer(path: fixture.directory.file("h.sock")) { line in
            await lineHandler.handle(line: line)
        }
        try server.start()
        defer { server.stop() }

        let largeText = "Large title\n" + String(repeating: "abcdé🙂 xyz\n", count: 18_000)
        let secondText = "Second pipelined\nbody é🙂"
        func requestBytes(id: Int, text: String) -> [UInt8] {
            let line = JSONValue.object([
                "id": .int(Int64(id)), "method": .string("notes.create"),
                "params": .object([
                    "rawContent": .string(#"{"type":"doc"}"#), "markdown": .string(text),
                    "text": .string(text), "title": .string(String(text.split(separator: "\n").first ?? "")),
                ]),
            ]).serialized()
            return Array((line + "\n").utf8)
        }
        let largeRequest = requestBytes(id: 41, text: largeText)
        let secondRequest = requestBytes(id: 42, text: secondText)
        #expect(largeRequest.count > 200_000)

        let fd = try SocketPaths.connect(to: server.path)
        defer { Darwin.close(fd) }
        // 997 is not a divisor of any UTF-8 sequence length here, so slices regularly
        // land inside a multi byte sequence and inside the JSON framing.
        var offset = 0
        while offset < largeRequest.count {
            let end = min(offset + 997, largeRequest.count)
            try SocketPaths.writeAll(fd: fd, data: Data(largeRequest[offset..<end]), timeout: 5)
            offset = end
        }
        try SocketPaths.writeAll(fd: fd, data: Data(secondRequest), timeout: 5)

        var received: [UInt8] = []
        var responses: [Int: JSONValue] = [:]
        let deadline = Date().addingTimeInterval(15)
        while responses.count < 2, Date() < deadline {
            var pollFd = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
            guard poll(&pollFd, 1, 1000) > 0 else { continue }
            var chunk = [UInt8](repeating: 0, count: 16 * 1024)
            let count = chunk.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress, $0.count) }
            guard count > 0 else { break }
            received.append(contentsOf: chunk[0..<count])
            while let newline = received.firstIndex(of: UInt8(ascii: "\n")) {
                let line = String(decoding: received[0..<newline], as: UTF8.self)
                received.removeSubrange(0...newline)
                let parsed = try JSONValue.parse(line)
                if let id = parsed["id"]?.intValue { responses[Int(id)] = parsed }
            }
        }

        let largeResponse = try #require(responses[41])
        let secondResponse = try #require(responses[42])
        #expect(largeResponse["error"] == nil)
        #expect(secondResponse["error"] == nil)
        let largeId = try #require(largeResponse["result"]?["id"]?.stringValue)
        let secondId = try #require(secondResponse["result"]?["id"]?.stringValue)
        #expect(Array(try fixture.repository.get(largeId).content.text.utf8) == Array(largeText.utf8))
        #expect(Array(try fixture.repository.get(secondId).content.text.utf8) == Array(secondText.utf8))
        #expect(largeResponse["result"]?["text"]?.stringValue == largeText)
        #expect(secondResponse["result"]?["text"]?.stringValue == secondText)
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

@Suite("Panel frame settings")
struct PanelFrameSettingsTests {
    @Test func oldJSONWithoutTheNewDisplayFieldsReadsBackEqual() throws {
        let old = try JSONValue.parse(
            #"{"x":10,"y":900,"width":640,"height":420,"displays":{"uuid@1728x1117":{"x":10,"y":900}}}"#)
        let parsed = try PanelFrame(json: old)
        #expect(
            parsed == PanelFrame(
                x: 10, y: 900, width: 640, height: 420,
                displays: ["uuid@1728x1117": PanelPoint(x: 10, y: 900)]))
        // Writing it back adds nothing the old shape did not have.
        let rewritten = try PanelFrame(json: JSONValue.parse(parsed.json.serialized()))
        #expect(rewritten == parsed)
        #expect(parsed.displays["uuid@1728x1117"]?.width == nil)
        #expect(parsed.displays["uuid@1728x1117"]?.placement == nil)
    }

    @Test func newDisplayFieldsRoundTrip() throws {
        let point = PanelPoint(x: 720, y: 900, width: 720, height: 900, placement: .right)
        let frame = PanelFrame(x: 720, y: 900, width: 720, height: 900, displays: ["uuid@1440x900": point])
        let parsed = try PanelFrame(json: JSONValue.parse(frame.json.serialized()))
        #expect(parsed == frame)
        #expect(parsed.displays["uuid@1440x900"] == point)
        // The same values survive a settings patch, as `settings.set` stores them.
        let settings = try Settings.defaults.applying(["panelFrame": frame.json])
        #expect(settings.panelFrame == frame)
    }
}

@Suite("Panel geometry")
struct PanelGeometryTests {
    private let minimum = CGSize(width: 396, height: 128)

    private func frame(
        _ placement: PanelPlacement, current: CGRect, visible: CGRect, zoom: Double = 1
    ) -> CGRect {
        PanelGeometry.frame(
            for: placement, currentFrame: current, visibleFrame: visible, minimumSize: minimum, zoom: zoom)
    }

    @Test func placementRawValuesMatchTheFutureWireNames() {
        #expect(PanelPlacement.left.rawValue == "left")
        #expect(PanelPlacement.right.rawValue == "right")
        #expect(PanelPlacement.fill.rawValue == "fill")
        #expect(PanelPlacement.center.rawValue == "center")
        #expect(PanelPlacement(rawValue: "center") == .center)
    }

    @Test(arguments: [1000.0, 1001.0])
    func leftAndRightPartitionTheVisibleFrameExactly(width: Double) {
        let visible = CGRect(x: 10, y: 20, width: width, height: 600)
        let current = CGRect(x: 0, y: 0, width: 640, height: 560)
        let left = frame(.left, current: current, visible: visible)
        let right = frame(.right, current: current, visible: visible)
        #expect(left.minX == visible.minX)
        #expect(left.maxX == right.minX)
        #expect(right.maxX == visible.maxX)
        #expect(left.width + right.width == visible.width)
        #expect(left.minY == visible.minY && left.height == visible.height)
        #expect(right.minY == visible.minY && right.height == visible.height)
        #expect(left == left.integral && right == right.integral)
    }

    @Test func fillEqualsTheVisibleFrameMadeIntegral() {
        let visible = CGRect(x: 10.2, y: 20.4, width: 1000.5, height: 600.25)
        let current = CGRect(x: 0, y: 0, width: 640, height: 560)
        #expect(frame(.fill, current: current, visible: visible) == visible.integral)
        let integralVisible = CGRect(x: 0, y: 0, width: 1440, height: 900)
        #expect(frame(.fill, current: current, visible: integralVisible) == integralVisible)
    }

    @Test func centerKeepsSizeAndCentresInsideTheVisibleFrame() {
        let visible = CGRect(x: 100, y: 50, width: 1000, height: 600)
        let current = CGRect(x: 0, y: 0, width: 640, height: 400)
        let result = frame(.center, current: current, visible: visible)
        #expect(result.width == 640 && result.height == 400)
        #expect(result.midX == visible.midX && result.midY == visible.midY)
        #expect(visible.contains(result))
        #expect(result == result.integral)
    }

    @Test func centerClampsOversizeAndRaisesUndersizeToTheZoomedMinimum() {
        let visible = CGRect(x: 0, y: 0, width: 500, height: 300)
        let oversize = frame(
            .center, current: CGRect(x: 0, y: 0, width: 900, height: 800), visible: visible)
        #expect(oversize == visible)
        // Both minimum dimensions scale linearly with zoom, so at zoom 2 the
        // minimum doubles to 792 by 256 from the 396 by 128 base at 100 percent.
        let roomy = CGRect(x: 0, y: 0, width: 1000, height: 600)
        let undersize = frame(
            .center, current: CGRect(x: 0, y: 0, width: 100, height: 50), visible: roomy, zoom: 2)
        #expect(undersize.width == 792 && undersize.height == 256)
        #expect(roomy.contains(undersize))
        #expect(undersize.midX == roomy.midX)
        // At 75 percent zoom the minimum shrinks to 297 by 96.
        let narrower = CGRect(x: 0, y: 0, width: 999, height: 600)
        let shrunk = frame(
            .center, current: CGRect(x: 0, y: 0, width: 100, height: 50), visible: narrower, zoom: 0.75)
        #expect(shrunk.width == 297 && shrunk.height == 96)
        #expect(narrower.contains(shrunk))
        // Containment still wins when even the zoomed minimum cannot fit: at
        // zoom 2 on a 500 point display the width stops at the display width.
        let contained = frame(
            .center, current: CGRect(x: 0, y: 0, width: 100, height: 50), visible: visible, zoom: 2)
        #expect(contained.width == 500 && contained.height == 256)
        #expect(visible.contains(contained))
    }

    @Test func onePointChangeIsNoneWithTheExistingTwoPointTolerance() {
        let old = CGRect(x: 100, y: 100, width: 640, height: 400)
        let new = CGRect(x: 101, y: 99, width: 641, height: 401)
        #expect(PanelGeometry.classify(oldFrame: old, newFrame: new) == .none)
        #expect(PanelGeometry.defaultTolerance == 2)
    }

    @Test func threePointHeightChangeIsHeightChanged() {
        let old = CGRect(x: 100, y: 100, width: 640, height: 400)
        #expect(
            PanelGeometry.classify(oldFrame: old, newFrame: CGRect(x: 100, y: 97, width: 640, height: 403))
                == .heightChanged)
        // Height wins even when the width also changed.
        #expect(
            PanelGeometry.classify(oldFrame: old, newFrame: CGRect(x: 90, y: 97, width: 660, height: 403))
                == .heightChanged)
    }

    @Test func widthOnlyAndMoveOnlyClassification() {
        let old = CGRect(x: 100, y: 100, width: 640, height: 400)
        #expect(
            PanelGeometry.classify(oldFrame: old, newFrame: CGRect(x: 80, y: 100, width: 660, height: 400))
                == .widthOnly)
        #expect(
            PanelGeometry.classify(oldFrame: old, newFrame: CGRect(x: 130, y: 120, width: 640, height: 400))
                == .moveOnly)
    }

    @Test func overhangGrowthAloneIsNotANoteResize() {
        let old = CGRect(x: 100, y: 100, width: 640, height: 400)
        // The window grew 50 points downward for a dropdown: its bottom edge moved down and
        // its height grew, while the note frame inside it did not change at all.
        let new = CGRect(x: 100, y: 50, width: 640, height: 450)
        #expect(
            PanelGeometry.classify(
                oldFrame: old, newFrame: new, oldOverhang: 0, newOverhang: 50) == .none)
    }

    @Test func placementLookupSurvivesADisplaySizeChangeInsideTheKey() {
        let uuid = "37D8832A-2D66-02CA-B9F7-8F30A301B230"
        var saved = PanelFrame(x: 10, y: 900, width: 640)
        // Written when the display was 1920 by 1080.
        let storedKey = PanelFrame.displayKey(uuid: uuid, displayWidth: 1920, displayHeight: 1080)
        saved.displays[storedKey] = PanelPoint(x: 42, y: 1000)
        #expect(PanelFrame.displayUUID(fromKey: storedKey) == uuid)
        // The display now reports a different size, so its fresh key would not match, yet the
        // remembered point is still found by UUID alone.
        #expect(PanelFrame.displayKey(uuid: uuid, displayWidth: 2560, displayHeight: 1440) != storedKey)
        #expect(saved.rememberedPoint(forDisplayUUID: uuid) == PanelPoint(x: 42, y: 1000))
        #expect(saved.rememberedPoint(forDisplayUUID: "00000000-0000-0000-0000-000000000000") == nil)
    }
}
