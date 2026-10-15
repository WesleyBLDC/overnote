import Foundation

/// Where a request came from. Bridge only methods are rejected on the socket, and data
/// changes made through the socket are announced to the editor with `notes.changed`.
public enum RPCSource: Sendable {
    case socket
    case bridge
}

/// The one dispatcher behind both the socket and the WebKit bridge (docs/architecture.md section 5).
public final class RPCDispatcher: Sendable {
    public let repository: NotesRepository
    public let host: any HelperHost
    /// The backups folder; nil disables the `system.*Backup*` methods (unit tests).
    public let backups: BackupStore?
    private let processId: Int32
    private let extensionHandler: ExtensionHandler?

    /// Extra socket methods (the `--test-hooks` set). Returns nil for methods it does not own.
    public typealias ExtensionHandler = @Sendable (_ method: String, _ params: JSONValue?) async throws -> JSONValue?

    /// Methods only the socket may call: backups and restores are for the extension and scripts.
    public static let socketOnlyMethods: Set<String> = [
        "system.status", "system.backup", "system.listBackups", "system.restoreBackup", "system.dismissRestoreOffer",
    ]

    /// Methods only the editor may call.
    public static let bridgeOnlyMethods: Set<String> = [
        "system.ready", "window.resize", "window.setDragRegions", "window.resignFocus", "app.openURL", "clipboard.copy", "file.saveAs",
    ]

    public init(
        repository: NotesRepository, host: any HelperHost, backups: BackupStore? = nil, processId: Int32 = getpid(),
        extensionHandler: ExtensionHandler? = nil
    ) {
        self.repository = repository
        self.host = host
        self.backups = backups
        self.processId = processId
        self.extensionHandler = extensionHandler
    }

    /// Runs one request. Always throws `RPCError`; anything else is wrapped as code 500.
    public func handle(method: String, params rawParams: JSONValue?, source: RPCSource) async throws -> JSONValue {
        if source == .socket && Self.bridgeOnlyMethods.contains(method) {
            throw RPCError(code: RPCError.methodNotFoundCode, message: "\(method) is only available to the editor")
        }
        if source == .bridge && Self.socketOnlyMethods.contains(method) {
            throw RPCError(code: RPCError.methodNotFoundCode, message: "\(method) is only available on the socket")
        }
        do {
            if source == .socket, let extensionHandler, let result = try await extensionHandler(method, rawParams) {
                return result
            }
            let params = try Params(rawParams)
            return try await route(method: method, params: params, source: source)
        } catch let error as RPCError {
            throw error
        } catch {
            throw RPCError.internal("\(error)")
        }
    }

    private func route(method: String, params p: Params, source: RPCSource) async throws -> JSONValue {
        switch method {
        // MARK: system
        case "system.ping":
            return ["version": .string(HelperVersion.current), "pid": .int(Int64(processId))]
        case "system.shutdown":
            await host.requestShutdown()
            return [:]
        case "system.status":
            let store = try requireBackups()
            let list = try store.list()
            let offered = try repository.restoreOffered()
            return [
                "version": .string(HelperVersion.current), "pid": .int(Int64(processId)),
                "schemaVersion": .int(Int64(try repository.schemaVersion())),
                "noteCount": .int(Int64(try repository.count())),
                "backupDir": .string(store.directory), "backupCount": .int(Int64(list.count)),
                "latestBackup": list.first?.json ?? .null,
                "restoreAvailable": .bool(!list.isEmpty && offered),
            ]
        case "system.backup":
            let store = try requireBackups()
            let raw = try p.optionalString("reason") ?? BackupReason.manual.rawValue
            guard let reason = BackupReason(rawValue: raw) else {
                let names = BackupReason.allCases.map(\.rawValue).joined(separator: ", ")
                throw RPCError.badParams("reason must be one of \(names)")
            }
            // Asked for explicitly, so even an empty database is written.
            return try store.create(reason: reason) { try repository.backup(to: $0) }.json
        case "system.listBackups":
            let store = try requireBackups()
            return ["directory": .string(store.directory), "items": .array(try store.list().map(\.json))]
        case "system.restoreBackup":
            let store = try requireBackups()
            let outcome = try store.restore(
                try p.string("path"), write: { try repository.backup(to: $0) },
                restore: { try repository.restore(from: $0) })
            // Every note may have changed, so the editor reloads even when the backup was empty.
            await host.emit("notes.changed", ["ids": .array(outcome.result.map(JSONValue.string))])
            return [
                "restored": outcome.restored.json, "preRestoreBackup": outcome.preRestore.json,
                "noteCount": .int(Int64(try repository.count())),
            ]
        case "system.dismissRestoreOffer":
            try repository.setRestoreOffered(false)
            return [:]
        case "system.ready":
            return ["settings": try repository.settings().json, "windowData": try repository.windowData().json]

        // MARK: window
        case "window.toggle":
            return ["visible": .bool(await host.toggleWindow())]
        case "window.show":
            if let noteId = try p.optionalString("noteId") {
                _ = try repository.get(noteId)
                try repository.setCurrentNote(noteId)
                await host.emit("note.open", ["id": .string(noteId)])
            }
            await host.showWindow()
            return ["visible": true]
        case "window.hide":
            await host.hideWindow()
            return ["visible": false]
        case "window.resize":
            let height = try p.double("contentHeight")
            guard height >= 0 else { throw RPCError.badParams("contentHeight must not be negative") }
            await host.resizeWindow(contentHeight: height, temporary: try p.optionalBool("temporary") ?? false)
            return [:]
        case "window.setDragRegions":
            await host.setDragRegions(try Self.dragRects(p))
            return [:]
        case "window.resignFocus":
            await host.resignFocus()
            return [:]

        // MARK: native services
        case "app.openURL":
            guard let url = LinkPolicy.openableURL(try p.string("url")) else {
                throw RPCError.badParams("url must be an http, https, mailto, or raycast link")
            }
            await host.openURL(url)
            return [:]
        case "clipboard.copy":
            await host.copyToClipboard(text: try p.string("text"), html: try p.optionalString("html"))
            return [:]
        case "file.saveAs":
            let name = FileNameSanitizer.sanitize(try p.string("suggestedName"))
            let content = try p.string("content")
            guard let path = try await host.saveFile(suggestedName: name, content: content) else {
                return ["saved": false]
            }
            return ["saved": true, "path": .string(path)]

        // MARK: notes
        case "notes.create":
            let content = NoteContent(
                rawContent: try p.string("rawContent"),
                markdown: try p.optionalString("markdown") ?? "",
                text: try p.optionalString("text") ?? "",
                title: try p.optionalString("title") ?? "")
            let show = try p.optionalBool("show") ?? false
            let note = try repository.create(content)
            await changed([note.id], source: source)
            if show {
                await host.emit("note.new", ["note": note.json])
                await host.showWindow()
            }
            return note.json
        case "notes.get":
            return try repository.get(try p.id()).json
        case "notes.update":
            let id = try p.id()
            let patch = NotePatch(
                rawContent: try p.optionalString("rawContent"),
                markdown: try p.optionalString("markdown"),
                text: try p.optionalString("text"),
                title: try p.optionalString("title"),
                caretPosition: try p.optionalInt("caretPosition"),
                expectedUpdatedAt: try p.optionalInt("expectedUpdatedAt"))
            let result = try repository.update(id, patch)
            if case .ok = result {
                await changed([id], source: source)
            }
            return result.json
        case "notes.delete":
            let id = try p.id()
            try repository.delete(id)
            await changed([id], source: source)
            return [:]
        case "notes.deleteAll":
            let ids = try repository.deleteAll()
            await changed(ids, source: source)
            return ["count": .int(Int64(ids.count))]
        case "notes.recover":
            let note = try repository.recover(try p.id())
            await changed([note.id], source: source)
            return note.json
        case "notes.permanentlyDelete":
            let id = try p.id()
            if try repository.permanentlyDelete(id) {
                await changed([id], source: source)
            }
            return [:]
        case "notes.emptyTrash":
            let ids = try repository.emptyTrash()
            await changed(ids, source: source)
            return ["count": .int(Int64(ids.count))]
        case "notes.duplicate":
            let note = try repository.duplicate(try p.id(), titleSuffix: try p.optionalString("titleSuffix"))
            await changed([note.id], source: source)
            return note.json
        case "notes.pin":
            let note = try repository.pin(try p.id())
            await changed([note.id], source: source)
            return note.json
        case "notes.unpin":
            let note = try repository.unpin(try p.id())
            await changed([note.id], source: source)
            return note.json
        case "notes.movePinnedUp", "notes.movePinnedDown":
            let id = try p.id()
            try repository.movePinned(id, method == "notes.movePinnedUp" ? .up : .down)
            await changed([id], source: source)
            return [:]
        case "notes.list":
            return try repository.list(
                filter: try p.optionalString("filter"), limit: try p.limit(default: NotesRepository.defaultListLimit),
                cursor: try p.optionalString("cursor")
            ).json
        case "notes.browse":
            return try repository.browse(
                filter: try p.optionalString("filter"), limit: try p.limit(default: NotesRepository.defaultListLimit),
                cursor: try p.optionalString("cursor")
            ).json
        case "notes.listDeleted":
            return ["items": .array(try repository.listDeleted().map(\.json))]
        case "notes.count":
            return ["count": .int(Int64(try repository.count()))]
        case "notes.setCurrentNote":
            try repository.setCurrentNote(try p.id("noteId"))
            return [:]
        case "notes.touchAccessed":
            try repository.touchAccessed(try p.id())
            return [:]
        case "notes.windowData":
            return try repository.windowData(noteId: try p.optionalString("noteId")).json

        // MARK: settings
        case "settings.get":
            return try repository.settings().json
        case "settings.set":
            let settings = try repository.setSettings(p.values)
            await host.settingsDidChange(settings)
            await host.emit("settings.changed", settings.json)
            return settings.json

        default:
            throw RPCError.methodNotFound(method)
        }
    }

    private func requireBackups() throws -> BackupStore {
        guard let backups else { throw RPCError.internal("Backups are not configured") }
        return backups
    }

    /// At most this many drag rects; the editor sends a handful at most.
    static let maxDragRects = 64

    /// Validates `{ rects: [{ x, y, width, height }] }`: finite numbers, no negative sizes.
    private static func dragRects(_ p: Params) throws -> [DragRect] {
        guard let raw = p.values["rects"], let items = raw.arrayValue else {
            throw RPCError.badParams("rects must be an array")
        }
        guard items.count <= maxDragRects else { throw RPCError.badParams("at most \(maxDragRects) rects") }
        return try items.map { item in
            let rect = try Params(item)
            let value = DragRect(
                x: try rect.double("x"), y: try rect.double("y"),
                width: try rect.double("width"), height: try rect.double("height"))
            guard value.width >= 0, value.height >= 0 else {
                throw RPCError.badParams("rect width and height must not be negative")
            }
            return value
        }
    }

    /// Tells the editor to reload after a change that did not come from the editor itself.
    private func changed(_ ids: [String], source: RPCSource) async {
        guard source == .socket, !ids.isEmpty else { return }
        await host.emit("notes.changed", ["ids": .array(ids.map(JSONValue.string))])
    }
}

/// Turns raw request lines into response lines (docs/architecture.md section 2).
public struct RPCLineHandler: Sendable {
    public let dispatcher: RPCDispatcher
    public let source: RPCSource

    public init(dispatcher: RPCDispatcher, source: RPCSource) {
        self.dispatcher = dispatcher
        self.source = source
    }

    /// Handles one line. Returns the response line without the trailing newline.
    public func handle(line: String) async -> String {
        let request: JSONValue
        do {
            request = try JSONValue.parse(line)
        } catch {
            return Self.response(id: .null, error: .badParams("Request is not valid JSON"))
        }
        guard let object = request.objectValue else {
            return Self.response(id: .null, error: .badParams("Request must be a JSON object"))
        }
        let id = object["id"] ?? .null
        switch id {
        case .null, .int, .string, .double: break
        default: return Self.response(id: .null, error: .badParams("id must be a number or a string"))
        }
        guard let method = object["method"]?.stringValue else {
            return Self.response(id: id, error: .badParams("method must be a string"))
        }
        do {
            let result = try await dispatcher.handle(method: method, params: object["params"], source: source)
            return JSONValue.object(["id": id, "result": result]).serialized()
        } catch let error as RPCError {
            return Self.response(id: id, error: error)
        } catch {
            return Self.response(id: id, error: .internal("\(error)"))
        }
    }

    static func response(id: JSONValue, error: RPCError) -> String {
        JSONValue.object(["id": id, "error": error.json]).serialized()
    }
}
