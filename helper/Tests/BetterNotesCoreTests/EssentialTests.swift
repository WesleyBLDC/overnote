import Foundation
import Testing
@testable import BetterNotesCore

// Unit tests are limited to logic end to end tests cannot reach cheaply (CLAUDE.md testing
// policy): fold rules, ordering and cursor math, pins, trash purge, the update conflict, RPC
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

    @Test func likePatternTrimsFoldsAndEscapesWildcards() {
        #expect(TextFolding.likePattern(for: "  \n") == nil)
        #expect(TextFolding.likePattern(for: " Ab ") == "%ab%")
        #expect(TextFolding.likePattern(for: "50%_\\") == "%50\\%\\_\\\\%")
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
        #expect(ids == titleHits.reversed() + textHits.reversed())
    }

    @Test func cursorsAreBoundToTheirSource() throws {
        let f = try Fixture()
        try f.make("a")
        try f.make("b")
        let listCursor = try #require(try f.repository.list(limit: 1).nextCursor)
        #expect(throws: RPCError.badParams("Invalid cursor")) { try f.repository.browse(cursor: listCursor) }
        #expect(throws: RPCError.badParams("Invalid cursor")) { try f.repository.list(cursor: "garbage") }
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

    @Test func pipelinedRequestsOnOneConnectionAreAllAnsweredById() throws {
        let f = try Fixture()
        let handler = RPCLineHandler(dispatcher: RPCDispatcher(repository: f.repository, host: RecordingHost()), source: .socket)
        let path = f.directory.file("run/helper.sock")
        let server = SocketServer(path: path) { await handler.handle(line: $0) }
        try server.start()
        defer { server.stop() }
        let client = try RPCClient(path: path)
        // Many requests in one write, including a line split across the batch boundary.
        var lines = ""
        for index in 0..<40 {
            lines += #"{"id":\#(index),"method":"notes.create","params":{"rawContent":"{}","text":"n\#(index)"}}"# + "\n"
        }
        try client.send(line: String(lines.dropLast()))
        var ids = Set<JSONValue>()
        while ids.count < 40, let line = try client.readLine(timeout: 5) {
            let message = try JSONValue.parse(line)
            #expect(message["error"] == nil)
            ids.insert(message["id"] ?? .null)
        }
        #expect(ids == Set((0..<40).map { JSONValue.int(Int64($0)) }))
    }
}

@Suite("Security checks")
struct SecurityTests {
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

    @Test(arguments: [
        ("https://example.com/a?b=1", true),
        ("http://localhost:3000", true),
        ("mailto:someone@example.com", true),
        ("raycast://extensions/raycast/notes", true),
        ("file:///etc/passwd", false),
        ("javascript:alert(1)", false),
        ("betternotes://app/index.html", false),
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

        #expect(try file("betternotes://app/") == "index.html")
        #expect(try file("betternotes://app/assets/app.js") == "app.js")
        #expect(try file("betternotes://app/../secret.txt") == nil)
        #expect(try file("betternotes://app/%2E%2E/secret.txt") == nil)
        #expect(try file("betternotes://app/assets/..%2F..%2Fsecret.txt") == nil)
        #expect(try file("betternotes://app/link.txt") == nil)
        #expect(try file("betternotes://other/index.html") == nil)
    }
}
