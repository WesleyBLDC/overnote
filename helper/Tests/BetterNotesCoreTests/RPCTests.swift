import Darwin
import Foundation
import Testing
@testable import BetterNotesCore

/// A dispatcher plus a running socket server in a temp directory.
final class ServerFixture {
    let fixture: Fixture
    let host = RecordingHost()
    let dispatcher: RPCDispatcher
    let server: SocketServer
    let socketPath: String

    init() throws {
        fixture = try Fixture()
        dispatcher = RPCDispatcher(repository: fixture.repository, host: host, processId: 4242)
        socketPath = fixture.directory.file("run/helper.sock")
        let handler = RPCLineHandler(dispatcher: dispatcher, source: .socket)
        server = SocketServer(path: socketPath) { await handler.handle(line: $0) }
        try server.start()
    }

    func client() throws -> RPCClient {
        try RPCClient(path: socketPath)
    }

    deinit {
        server.stop()
    }
}

@Suite("Dispatcher")
struct DispatcherTests {
    let fixture: Fixture
    let host = RecordingHost()
    let dispatcher: RPCDispatcher

    init() throws {
        fixture = try Fixture()
        dispatcher = RPCDispatcher(repository: fixture.repository, host: host, processId: 7)
    }

    func call(_ method: String, _ params: JSONValue = [:], source: RPCSource = .bridge) async throws -> JSONValue {
        try await dispatcher.handle(method: method, params: params, source: source)
    }

    func expectError(_ code: Int, _ method: String, _ params: JSONValue = [:], source: RPCSource = .bridge) async {
        do {
            _ = try await call(method, params, source: source)
            Issue.record("\(method) should have failed with \(code)")
        } catch let error as RPCError {
            #expect(error.code == code, "\(method): \(error.message)")
        } catch {
            Issue.record("Unexpected error \(error)")
        }
    }

    @Test func pingReportsVersionAndPid() async throws {
        let result = try await call("system.ping")
        #expect(result == ["version": .string(HelperVersion.current), "pid": 7])
    }

    @Test func badParamsAndUnknownMethods() async {
        await expectError(-32601, "notes.nope")
        await expectError(-32601, "notes.search", ["query": "x"])
        await expectError(-32601, "notes.navigate", ["direction": "back"])
        await expectError(-32602, "notes.get")
        await expectError(-32602, "notes.get", ["id": 5])
        await expectError(-32602, "notes.get", ["id": ""])
        await expectError(-32602, "notes.create", ["text": "no raw content"])
        await expectError(-32602, "notes.list", ["limit": 0])
        await expectError(-32602, "notes.list", ["limit": "ten"])
        await expectError(-32602, "notes.list", ["cursor": "%%%"])
        await expectError(-32602, "notes.update", ["id": "x", "caretPosition": 1.5])
        await expectError(-32602, "notes.setCurrentNote", [:])
        await expectError(-32602, "settings.set", ["zoom": "x"])
        await expectError(-32602, "window.resize", ["contentHeight": "tall"])
        await expectError(-32602, "notes.get", .array([]))
        await expectError(404, "notes.get", ["id": "missing"])
        await expectError(404, "notes.delete", ["id": "missing"])
        await expectError(404, "window.show", ["noteId": "missing"])
    }

    @Test func bridgeOnlyMethodsAreHiddenFromTheSocket() async throws {
        for method in RPCDispatcher.bridgeOnlyMethods {
            await expectError(-32601, method, [:], source: .socket)
        }
        let ready = try await call("system.ready")
        #expect(ready["settings"] == Settings.defaults.json)
        #expect(ready["windowData"]?["current"] == .null)
    }

    @Test func createWithShowEmitsNoteNewAndShows() async throws {
        let note = try await call(
            "notes.create", ["rawContent": "{}", "text": "hi", "title": "hi", "markdown": "hi", "show": true],
            source: .socket)
        let id = try #require(note["id"]?.stringValue)
        #expect(host.isVisible)
        let names = host.events.map(\.0)
        #expect(names == ["notes.changed", "note.new"])
        #expect(host.events.last?.1["note"]?["id"] == .string(id))
    }

    @Test func socketMutationsAnnounceChangesButBridgeOnesDoNot() async throws {
        let created = try await call("notes.create", ["rawContent": "{}"], source: .bridge)
        let id = try #require(created["id"])
        #expect(host.events.isEmpty)
        _ = try await call("notes.pin", ["id": id], source: .socket)
        _ = try await call("notes.delete", ["id": id], source: .socket)
        let changed = host.events.filter { $0.0 == "notes.changed" }.map(\.1)
        #expect(changed == [["ids": [id]], ["ids": [id]]])
    }

    @Test func updateReturnsStatusAndHonorsExpectedUpdatedAt() async throws {
        let created = try await call("notes.create", ["rawContent": "{}", "text": "a"])
        let id = try #require(created["id"])
        let stale = try #require(created["updatedAt"])
        fixture.clock.advance(5)
        let ok = try await call("notes.update", ["id": id, "text": "b", "expectedUpdatedAt": stale])
        #expect(ok["status"] == "ok")
        #expect(ok["note"]?["text"] == "b")
        let conflict = try await call("notes.update", ["id": id, "text": "c", "expectedUpdatedAt": stale])
        #expect(conflict["status"] == "conflict")
        #expect(conflict["note"]?["text"] == "b")
    }

    @Test func windowShowWithNoteEmitsOpenAndPersistsCurrent() async throws {
        let a = try await call("notes.create", ["rawContent": "{}", "text": "a"])
        _ = try await call("notes.create", ["rawContent": "{}", "text": "b"])
        let id = try #require(a["id"]?.stringValue)
        let result = try await call("window.show", ["noteId": .string(id)], source: .socket)
        #expect(result == ["visible": true])
        #expect(host.events.last?.0 == "note.open")
        #expect(host.events.last?.1 == ["id": .string(id)])
        #expect(try fixture.repository.currentNoteId() == id)
        #expect(try await call("window.toggle") == ["visible": false])
        #expect(try await call("window.toggle") == ["visible": true])
        #expect(try await call("window.hide") == ["visible": false])
    }

    @Test func settingsSetEmitsSettingsChanged() async throws {
        let result = try await call("settings.set", ["showFormatBar": true], source: .socket)
        #expect(result["showFormatBar"] == true)
        #expect(host.calls.contains(.settingsChanged(try fixture.repository.settings())))
        #expect(host.events.last?.0 == "settings.changed")
        #expect(try await call("settings.get") == result)
    }

    @Test func listShapesMatchTheContract() async throws {
        _ = try await call("notes.create", ["rawContent": "{}", "text": "x"])
        let page = try await call("notes.list", ["filter": "x", "limit": 10])
        #expect(page["nextCursor"] == .null)
        let item = try #require(page["items"]?.arrayValue?.first?.objectValue)
        #expect(Set(item.keys) == ["id", "title", "preview", "charCount", "pinned", "createdAt", "updatedAt", "deletedAt", "lastAccessedAt"])
        let browse = try await call("notes.browse", [:])
        #expect(browse["items"]?.arrayValue?.count == 1)
        #expect(try await call("notes.count") == ["count": 1])
        #expect(try await call("notes.listDeleted") == ["items": []])
        let data = try await call("notes.windowData", [:])
        #expect(Set(data.objectValue?.keys ?? [:].keys) == ["current", "previousNoteId", "nextNoteId", "pinnedShortcutNoteIds"])
    }

    @Test func moveAndTrashMethodsRoundTrip() async throws {
        let a = try #require(try await call("notes.create", ["rawContent": "{}", "text": "a"])["id"])
        let b = try #require(try await call("notes.create", ["rawContent": "{}", "text": "b"])["id"])
        _ = try await call("notes.pin", ["id": a])
        _ = try await call("notes.pin", ["id": b])
        #expect(try await call("notes.movePinnedUp", ["id": b]) == [:])
        #expect(try await call("notes.windowData")["pinnedShortcutNoteIds"] == [b, a])
        #expect(try await call("notes.movePinnedDown", ["id": b]) == [:])
        #expect(try await call("notes.windowData")["pinnedShortcutNoteIds"] == [a, b])
        #expect(try await call("notes.deleteAll") == ["count": 2])
        #expect(try await call("notes.recover", ["id": a])["deletedAt"] == .null)
        #expect(try await call("notes.permanentlyDelete", ["id": a]) == [:])
        #expect(try await call("notes.get", ["id": a])["id"] == a)
        #expect(try await call("notes.emptyTrash") == ["count": 1])
        let copy = try await call("notes.duplicate", ["id": a, "titleSuffix": " copy"])
        #expect(copy["caretPosition"] == 0)
        #expect(try await call("notes.touchAccessed", ["id": a]) == [:])
        #expect(try await call("notes.setCurrentNote", ["noteId": a]) == [:])
    }

    @Test func nativeServicesAreForwarded() async throws {
        _ = try await call("clipboard.copy", ["text": "plain", "html": "<b>x</b>"])
        #expect(host.calls.contains(.copy("plain", "<b>x</b>")))
        let saved = try await call("file.saveAs", ["suggestedName": "../../etc/pass\u{7}wd.md", "content": "body"])
        #expect(saved == ["saved": false])
        #expect(host.calls.contains(.save("Untitled....etcpasswd.md", "body")))
        _ = try await call("window.resize", ["contentHeight": 321])
        #expect(host.calls.contains(.resize(321)))
        _ = try await call("window.resignFocus")
        #expect(host.calls.contains(.resignFocus))
    }

    @Test func shutdownIsRequested() async throws {
        #expect(try await call("system.shutdown", source: .socket) == [:])
        #expect(host.calls.contains(.shutdown))
    }
}

@Suite("Line handler")
struct LineHandlerTests {
    @Test func malformedLinesGetErrorsWithTheRightId() async throws {
        let fixture = try Fixture()
        let handler = RPCLineHandler(
            dispatcher: RPCDispatcher(repository: fixture.repository, host: RecordingHost()), source: .socket)
        let notJSON = try JSONValue.parse(await handler.handle(line: "nope"))
        #expect(notJSON["id"] == .null)
        #expect(notJSON["error"]?["code"] == -32602)
        let notObject = try JSONValue.parse(await handler.handle(line: "[1]"))
        #expect(notObject["error"]?["code"] == -32602)
        let noMethod = try JSONValue.parse(await handler.handle(line: #"{"id":"a"}"#))
        #expect(noMethod["id"] == "a")
        #expect(noMethod["error"]?["code"] == -32602)
        let badParams = try JSONValue.parse(await handler.handle(line: #"{"id":3,"method":"notes.get","params":7}"#))
        #expect(badParams["id"] == 3)
        #expect(badParams["error"]?["code"] == -32602)
        let ok = try JSONValue.parse(await handler.handle(line: #"{"id":4,"method":"notes.count"}"#))
        #expect(ok == ["id": 4, "result": ["count": 0]])
    }
}

@Suite("Socket server", .serialized)
struct SocketServerTests {
    @Test func roundTripOverARealSocket() throws {
        let server = try ServerFixture()
        let client = try server.client()
        #expect(try client.call("system.ping") == ["version": .string(HelperVersion.current), "pid": 4242])
        let note = try client.call("notes.create", ["rawContent": "{}", "text": "over the wire", "title": "over"])
        let id = try #require(note["id"])
        #expect(try client.call("notes.get", ["id": id])["text"] == "over the wire")
        #expect(throws: RPCError(code: 404, message: "Note not found: zzz")) { try client.call("notes.get", ["id": "zzz"]) }
        #expect(throws: RPCError.self) { try client.call("system.ready") }
    }

    @Test func socketAndDirectoryPermissions() throws {
        let server = try ServerFixture()
        var info = stat()
        #expect(stat(server.socketPath, &info) == 0)
        #expect(info.st_mode & 0o777 == 0o600)
        #expect((info.st_mode & S_IFMT) == S_IFSOCK)
        #expect(stat((server.socketPath as NSString).deletingLastPathComponent, &info) == 0)
        #expect(info.st_mode & 0o777 == 0o700)
    }

    @Test func pipelinedRequestsAreAllAnsweredAndMatchedById() throws {
        let server = try ServerFixture()
        let client = try server.client()
        var lines = ""
        for index in 0..<50 {
            lines += #"{"id":\#(index),"method":"notes.create","params":{"rawContent":"{}","text":"n\#(index)"}}"# + "\n"
        }
        lines += #"{"id":"last","method":"notes.count"}"# + "\n"
        try client.send(line: String(lines.dropLast()))
        var ids = Set<JSONValue>()
        while ids.count < 51, let line = try client.readLine(timeout: 5) {
            let response = try JSONValue.parse(line)
            #expect(response["error"] == nil)
            ids.insert(response["id"] ?? .null)
        }
        #expect(ids.count == 51)
        #expect(try client.call("notes.count") == ["count": 50])
    }

    @Test func concurrentClients() async throws {
        let server = try ServerFixture()
        let path = server.socketPath
        try await withThrowingTaskGroup(of: Int.self) { group in
            for worker in 0..<8 {
                group.addTask {
                    let client = try RPCClient(path: path)
                    for index in 0..<10 {
                        _ = try client.call("notes.create", ["rawContent": "{}", "text": .string("w\(worker) \(index)")])
                    }
                    return 10
                }
            }
            var total = 0
            for try await count in group { total += count }
            #expect(total == 80)
        }
        #expect(try server.client().call("notes.count") == ["count": 80])
    }

    @Test func answersArriveAfterThePeerHalfCloses() throws {
        let server = try ServerFixture()
        let fd = try SocketPaths.connect(to: server.socketPath)
        defer { close(fd) }
        try SocketPaths.writeAll(fd: fd, data: Data(#"{"id":1,"method":"system.ping"}"#.utf8 + [10]), timeout: 1)
        shutdown(fd, SHUT_WR)
        var received = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while true {
            let count = read(fd, &buffer, buffer.count)
            if count <= 0 { break }
            received.append(contentsOf: buffer[0..<count])
        }
        let line = try #require(String(data: received, encoding: .utf8)?.split(separator: "\n").first)
        #expect(try JSONValue.parse(String(line))["id"] == 1)
    }

    @Test func staleSocketIsReplacedButALiveOneIsNot() throws {
        let server = try ServerFixture()
        // A second server on the same path refuses while the first is alive.
        let second = SocketServer(path: server.socketPath) { _ in "" }
        #expect(throws: SocketError.self) { try second.start() }

        // Leave a dead socket file behind, then start again.
        server.server.stop()
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        var address = try SocketPaths.address(for: server.socketPath)
        _ = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        close(fd)
        #expect(FileManager.default.fileExists(atPath: server.socketPath))
        let restarted = SocketServer(path: server.socketPath) { _ in #"{"id":1,"result":{}}"# }
        try restarted.start()
        defer { restarted.stop() }
        #expect(try RPCClient(path: server.socketPath).call("anything") == [:])
    }

    @Test func stopRemovesTheSocketFile() throws {
        let server = try ServerFixture()
        server.server.stop()
        #expect(!FileManager.default.fileExists(atPath: server.socketPath))
    }

    @Test func tooLongPathsAreRejected() {
        let path = "/tmp/" + String(repeating: "x", count: 120) + "/s.sock"
        #expect(throws: SocketError.self) { try SocketPaths.address(for: path) }
    }
}
