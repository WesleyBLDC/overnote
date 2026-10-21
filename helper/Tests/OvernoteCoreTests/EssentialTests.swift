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
