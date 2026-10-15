import Foundation

/// Unix epoch milliseconds.
public typealias Millis = Int64

/// The content fields the helper stores verbatim. It never parses or derives them.
public struct NoteContent: Equatable, Sendable {
    public var rawContent: String
    public var markdown: String
    public var text: String
    public var title: String

    public init(rawContent: String, markdown: String = "", text: String = "", title: String = "") {
        self.rawContent = rawContent
        self.markdown = markdown
        self.text = text
        self.title = title
    }
}

/// A partial update of a note (`notes.update`). `nil` means "leave unchanged".
public struct NotePatch: Equatable, Sendable {
    public var rawContent: String?
    public var markdown: String?
    public var text: String?
    public var title: String?
    public var caretPosition: Int64?
    /// When set, the update is applied only if the stored `updatedAt` equals it.
    public var expectedUpdatedAt: Millis?

    public init(
        rawContent: String? = nil, markdown: String? = nil, text: String? = nil, title: String? = nil,
        caretPosition: Int64? = nil, expectedUpdatedAt: Millis? = nil
    ) {
        self.rawContent = rawContent
        self.markdown = markdown
        self.text = text
        self.title = title
        self.caretPosition = caretPosition
        self.expectedUpdatedAt = expectedUpdatedAt
    }

    /// True when the patch carries at least one content field.
    public var hasContent: Bool {
        rawContent != nil || markdown != nil || text != nil || title != nil
    }
}

public struct Note: Equatable, Sendable {
    public var id: String
    public var content: NoteContent
    public var pinned: Double?
    public var createdAt: Millis
    public var updatedAt: Millis
    public var deletedAt: Millis?
    public var lastAccessedAt: Millis?
    public var caretPosition: Int64?

    public var json: JSONValue {
        [
            "id": .string(id),
            "rawContent": .string(content.rawContent),
            "markdown": .string(content.markdown),
            "text": .string(content.text),
            "title": .string(content.title),
            "pinned": .optional(pinned, JSONValue.double),
            "createdAt": .int(createdAt),
            "updatedAt": .int(updatedAt),
            "deletedAt": .optional(deletedAt, JSONValue.int),
            "lastAccessedAt": .optional(lastAccessedAt, JSONValue.int),
            "caretPosition": .optional(caretPosition, JSONValue.int),
        ]
    }
}

/// A list row: no `rawContent` or `markdown`.
public struct NoteSummary: Equatable, Sendable {
    public var id: String
    public var title: String
    /// The first 200 characters of the plain text.
    public var preview: String
    /// Characters of `text`, counted as Unicode scalars (SQLite `length()`).
    public var charCount: Int
    public var pinned: Double?
    public var createdAt: Millis
    public var updatedAt: Millis
    public var deletedAt: Millis?
    public var lastAccessedAt: Millis?

    public static let previewLength = 200

    public var json: JSONValue {
        [
            "id": .string(id),
            "title": .string(title),
            "preview": .string(preview),
            "charCount": .int(Int64(charCount)),
            "pinned": .optional(pinned, JSONValue.double),
            "createdAt": .int(createdAt),
            "updatedAt": .int(updatedAt),
            "deletedAt": .optional(deletedAt, JSONValue.int),
            "lastAccessedAt": .optional(lastAccessedAt, JSONValue.int),
        ]
    }
}

/// A Recently Deleted row: a summary plus the markdown for previews.
public struct DeletedNoteSummary: Equatable, Sendable {
    public var summary: NoteSummary
    public var markdown: String

    public var json: JSONValue {
        guard case .object(var object) = summary.json else { return summary.json }
        object["markdown"] = .string(markdown)
        return .object(object)
    }
}

/// A page of list results with an opaque cursor for the next page.
public struct NotePage: Equatable, Sendable {
    public var items: [NoteSummary]
    public var nextCursor: String?

    public var json: JSONValue {
        ["items": .array(items.map(\.json)), "nextCursor": .optional(nextCursor, JSONValue.string)]
    }
}

/// The result of `notes.update`.
public enum UpdateResult: Equatable, Sendable {
    /// The update was written (or there was nothing to write).
    case ok(Note)
    /// `expectedUpdatedAt` did not match; nothing was written. Carries the stored note.
    case conflict(Note)

    public var note: Note {
        switch self {
        case .ok(let note), .conflict(let note): return note
        }
    }

    public var json: JSONValue {
        switch self {
        case .ok(let note): return ["status": "ok", "note": note.json]
        case .conflict(let note): return ["status": "conflict", "note": note.json]
        }
    }
}

public struct WindowData: Equatable, Sendable {
    /// Nil only when no live notes exist.
    public var current: Note?
    /// The newer neighbor of `current` in window stack order (`updatedAt` desc, `id` asc).
    public var previousNoteId: String?
    /// The older neighbor of `current` in window stack order.
    public var nextNoteId: String?
    /// Live pinned notes in pin order, at most `maxPinShortcuts` (⌘1 through ⌘9).
    public var pinnedShortcutNoteIds: [String]

    public static let maxPinShortcuts = 9

    public var json: JSONValue {
        [
            "current": .optional(current) { $0.json },
            "previousNoteId": .optional(previousNoteId, JSONValue.string),
            "nextNoteId": .optional(nextNoteId, JSONValue.string),
            "pinnedShortcutNoteIds": .array(pinnedShortcutNoteIds.map(JSONValue.string)),
        ]
    }
}
