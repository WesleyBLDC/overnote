import Darwin
import Foundation
import Testing
@testable import BetterNotesCore

@Suite("JSON")
struct JSONValueTests {
    @Test func integersAndDoublesStayApart() throws {
        let value = try JSONValue.parse(#"{"a":1792040554653,"b":1.5,"c":true,"d":null,"e":["x"],"f":0}"#)
        #expect(value["a"] == .int(1_792_040_554_653))
        #expect(value["b"] == .double(1.5))
        #expect(value["c"] == .bool(true))
        #expect(value["d"] == .null)
        #expect(value["e"] == ["x"])
        #expect(value["f"] == .int(0))
        #expect(try JSONValue.parse(value.serialized()) == value)
    }

    @Test func stringsWithSpecialCharactersRoundTrip() throws {
        let text = "line\nbreak \"quote\" \\ / \u{2028} emoji 🙂 nul \u{0}"
        let value = JSONValue.string(text)
        #expect(try JSONValue.parse(value.serialized()) == value)
    }

    @Test func numericAccessors() {
        #expect(JSONValue.double(3).intValue == 3)
        #expect(JSONValue.double(3.5).intValue == nil)
        #expect(JSONValue.int(2).doubleValue == 2)
        #expect(JSONValue.string("2").intValue == nil)
    }
}

@Suite("ULID")
struct ULIDTests {
    @Test func formatAndTimeOrdering() {
        var generator = ULIDGenerator()
        let first = generator.next(now: 1_800_000_000_000)
        let second = generator.next(now: 1_800_000_000_001)
        #expect(ULIDGenerator.isValid(first))
        #expect(first.count == 26)
        #expect(first < second)
        #expect(first.prefix(10) != second.prefix(10))
    }

    @Test func monotonicWithinAMillisecondAndUnderClockSkew() {
        var generator = ULIDGenerator()
        var previous = generator.next(now: 5000)
        for step in 0..<1000 {
            let next = generator.next(now: step % 2 == 0 ? 5000 : 4000)
            #expect(previous < next)
            previous = next
        }
    }

    @Test func knownEncoding() {
        #expect(ULIDGenerator.encode(time: 0, randomHigh: 0, randomLow: 0) == String(repeating: "0", count: 26))
        #expect(
            ULIDGenerator.encode(time: 0xFFFF_FFFF_FFFF, randomHigh: .max, randomLow: .max) == "7ZZZZZZZZZZZZZZZZZZZZZZZZZ")
        #expect(ULIDGenerator.encode(time: 1, randomHigh: 0, randomLow: 1).hasSuffix("01"))
    }
}

@Suite("Folding and patterns")
struct FoldingTests {
    @Test(arguments: [
        ("Ünïcödé", "unicode"),
        ("Straße", "straße"),
        ("ﬁle", "file"),
        ("ÅNGSTRÖM", "angstrom"),
        ("Crème BRÛLÉE", "creme brulee"),
        ("Ｆｕｌｌｗｉｄｔｈ", "fullwidth"),
        ("e\u{301}", "e"),
    ])
    func folding(input: String, expected: String) {
        #expect(TextFolding.fold(input) == expected)
    }

    @Test func charCountIsUnicodeScalars() throws {
        let f = try Fixture()
        let text = "e\u{301}🙂ﬁ"
        try f.make(text, title: "t")
        let item = try #require(try f.repository.list().items.first)
        #expect(item.charCount == text.unicodeScalars.count)
        #expect(item.charCount == 4)
    }

    @Test func likePatternEscapesWildcards() {
        #expect(TextFolding.likePattern(for: nil) == nil)
        #expect(TextFolding.likePattern(for: "  \n") == nil)
        #expect(TextFolding.likePattern(for: " Ab ") == "%ab%")
        #expect(TextFolding.likePattern(for: "50%_\\") == "%50\\%\\_\\\\%")
    }
}

@Suite("Lifecycle utilities", .serialized)
struct LifecycleTests {
    @Test func instanceLockIsExclusiveAndReleasable() throws {
        let directory = TempDirectory()
        let path = directory.file("helper.pid")
        let first = InstanceLock(path: path)
        try first.acquire()
        let contents = try String(contentsOfFile: path, encoding: .utf8)
        #expect(contents == "\(getpid())\n")

        let second = InstanceLock(path: path)
        do {
            try second.acquire()
            Issue.record("Second acquire should fail")
        } catch let error as InstanceLock.AlreadyRunning {
            #expect(error.pid == getpid())
        }

        first.release()
        #expect(!FileManager.default.fileExists(atPath: path))
        try second.acquire()
        second.release()
    }

    @Test func stalePidFileIsTakenOver() throws {
        let directory = TempDirectory()
        let path = directory.file("helper.pid")
        try "99999\n".write(toFile: path, atomically: true, encoding: .utf8)
        let lock = InstanceLock(path: path)
        try lock.acquire()
        #expect(try String(contentsOfFile: path, encoding: .utf8) == "\(getpid())\n")
        lock.release()
    }

    @Test func loggerRotatesPastTheLimit() throws {
        let directory = TempDirectory()
        let path = directory.file("helper.log")
        let logger = FileLogger(path: path, maxBytes: 1000)
        for index in 0..<40 {
            logger.log("line \(index) " + String(repeating: "x", count: 40))
        }
        logger.close()
        let rotated = try FileManager.default.attributesOfItem(atPath: path + ".1")[.size] as? Int ?? 0
        let current = try FileManager.default.attributesOfItem(atPath: path)[.size] as? Int ?? 0
        #expect(rotated >= 1000)
        #expect(current < 1000)
        #expect(try String(contentsOfFile: path, encoding: .utf8).contains("line 39"))
    }

    @Test func socketDirectoryIsCreatedPrivate() throws {
        let directory = TempDirectory()
        let socket = directory.file("run/helper.sock")
        try SocketPaths.prepareDirectory(for: socket)
        var info = stat()
        #expect(stat(directory.file("run"), &info) == 0)
        #expect(info.st_mode & 0o777 == 0o700)

        chmod(directory.file("run"), 0o755)
        try SocketPaths.prepareDirectory(for: socket)
        #expect(stat(directory.file("run"), &info) == 0)
        #expect(info.st_mode & 0o777 == 0o700)

        try "x".write(toFile: directory.file("file"), atomically: true, encoding: .utf8)
        #expect(throws: SocketError.self) { try SocketPaths.prepareDirectory(for: directory.file("file/helper.sock")) }
    }
}

@Suite("Arguments")
struct ArgumentTests {
    @Test func parsesTheContractCommandLine() throws {
        let parsed = try HelperArguments.parse([
            "--support-dir", "/s", "--socket", "/r/h.sock", "--pid-file", "/r/h.pid", "--editor-dir", "/e", "--show",
        ])
        #expect(parsed.supportDir == "/s")
        #expect(parsed.socketPath == "/r/h.sock")
        #expect(parsed.pidFile == "/r/h.pid")
        #expect(parsed.editorDir == "/e")
        #expect(parsed.show)
        #expect(!parsed.headless)
    }

    @Test func defaultsAndErrors() throws {
        let parsed = try HelperArguments.parse(["--support-dir", "/s", "-psn_0_123"])
        #expect(parsed.socketPath == "/tmp/better-notes-\(getuid())/helper.sock")
        #expect(parsed.pidFile == "/tmp/better-notes-\(getuid())/helper.pid")
        #expect(try HelperArguments.parse(["--version"]).version)
        #expect(throws: HelperArguments.ParseError.self) { try HelperArguments.parse([]) }
        #expect(throws: HelperArguments.ParseError.self) { try HelperArguments.parse(["--support-dir"]) }
        #expect(throws: HelperArguments.ParseError.self) { try HelperArguments.parse(["--support-dir", "/s", "--bogus"]) }
    }
}

@Suite("Editor assets")
struct EditorAssetTests {
    @Test func servesFilesInsideTheDirectoryOnly() throws {
        let directory = TempDirectory()
        let editor = directory.file("editor")
        try FileManager.default.createDirectory(atPath: editor + "/assets", withIntermediateDirectories: true)
        try "<html>".write(toFile: editor + "/index.html", atomically: true, encoding: .utf8)
        try "x".write(toFile: editor + "/assets/app.js", atomically: true, encoding: .utf8)
        try "secret".write(toFile: directory.file("secret.txt"), atomically: true, encoding: .utf8)
        try FileManager.default.createSymbolicLink(atPath: editor + "/link.txt", withDestinationPath: directory.file("secret.txt"))
        let assets = EditorAssets(directory: editor)
        func url(_ text: String) throws -> URL { try #require(URL(string: text)) }

        #expect(assets.hasIndex)
        #expect(assets.file(for: try url("betternotes://app/"))?.lastPathComponent == "index.html")
        #expect(assets.file(for: try url("betternotes://app/assets/app.js"))?.lastPathComponent == "app.js")
        #expect(assets.file(for: try url("betternotes://app/../secret.txt")) == nil)
        #expect(assets.file(for: try url("betternotes://app/%2E%2E/secret.txt")) == nil)
        #expect(assets.file(for: try url("betternotes://app/assets/..%2F..%2Fsecret.txt")) == nil)
        #expect(assets.file(for: try url("betternotes://app/link.txt")) == nil)
        #expect(assets.file(for: try url("betternotes://other/index.html")) == nil)
        #expect(assets.file(for: try url("betternotes://app/assets")) == nil)
        #expect(assets.file(for: try url("betternotes://app/missing.js")) == nil)
    }

    @Test func mimeTypes() {
        #expect(EditorAssets.mimeType(forExtension: "js").hasPrefix("text/javascript"))
        #expect(EditorAssets.mimeType(forExtension: "CSS").hasPrefix("text/css"))
        #expect(EditorAssets.mimeType(forExtension: "html").hasPrefix("text/html"))
        #expect(EditorAssets.mimeType(forExtension: "woff2") == "font/woff2")
        #expect(EditorAssets.mimeType(forExtension: "svg") == "image/svg+xml")
        #expect(EditorAssets.mimeType(forExtension: "wasm") == "application/wasm")
        #expect(EditorAssets.mimeType(forExtension: "bin") == "application/octet-stream")
    }
}

@Suite("File names")
struct FileNameTests {
    @Test(arguments: [
        ("Shopping list.md", "Shopping list.md"),
        ("a/b\\c:d.md", "abcd.md"),
        ("  spaced  ", "spaced"),
        ("tab\tand\nnewline.txt", "tabandnewline.txt"),
        (".md", "Untitled.md"),
        ("", "Untitled"),
        ("///", "Untitled"),
        ("...", "Untitled"),
        ("\u{7}\u{1B}", "Untitled"),
    ])
    func sanitize(input: String, expected: String) {
        #expect(FileNameSanitizer.sanitize(input) == expected)
    }

    @Test func longNamesAreCapped() {
        #expect(FileNameSanitizer.sanitize(String(repeating: "a", count: 500)).count == 200)
    }
}
