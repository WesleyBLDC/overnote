import Foundation

/// What `notes.browse` orders by (protocol v3.7): a field, a direction, and whether pinned notes
/// come first. The default is the order browse always had: last opened first, pinned on top.
public struct BrowseOrder: Equatable, Sendable {
    public enum Field: String, Sendable, CaseIterable {
        case opened, modified, created, title, length
    }

    public enum Direction: String, Sendable, CaseIterable {
        case asc, desc
    }

    public var field: Field
    public var direction: Direction
    public var pinnedFirst: Bool

    public init(field: Field = .opened, direction: Direction = .desc, pinnedFirst: Bool = true) {
        self.field = field
        self.direction = direction
        self.pinnedFirst = pinnedFirst
    }

    /// The generated sort column the field's paging index holds, read ascending in the field's
    /// natural direction: newest, longest, or A to Z first.
    var column: String {
        switch field {
        case .opened: return "notes.sort_accessed_neg"
        case .modified: return "notes.sort_updated_neg"
        case .created: return "notes.sort_created_neg"
        case .length: return "notes.sort_words_neg"
        case .title: return "notes.sort_title"
        }
    }

    /// Whether the direction runs against the column, so its index is read backwards.
    var reversed: Bool {
        direction != (field == .title ? .asc : .desc)
    }

    /// Reads `{ field, direction }` from `notes.browse` or the `searchSort` setting.
    init(sort value: JSONValue?, pinnedFirst: Bool) throws {
        self.init(pinnedFirst: pinnedFirst)
        guard let value, !value.isNull else { return }
        guard let object = value.objectValue,
            let field = object["field"]?.stringValue.flatMap(Field.init(rawValue:)),
            let direction = object["direction"]?.stringValue.flatMap(Direction.init(rawValue:))
        else {
            throw RPCError.badParams(
                "sort must be { field: opened | modified | created | title | length, direction: asc | desc }")
        }
        self.field = field
        self.direction = direction
    }
}

/// One run of a page query: rows that share a fixed part of the order (pinned notes, say), read
/// in the order of `keys`, the last of which is always the id.
struct PageSegment {
    /// SQL added to the WHERE clause for this run.
    var predicate: String
    var keys: [(expression: String, descending: Bool)]

    /// The ORDER BY list.
    var order: String {
        keys.map { $0.descending ? "\($0.expression) DESC" : $0.expression }.joined(separator: ", ")
    }

    /// Rows strictly after the row whose keys are the `placeholders`. Keys that all run one way
    /// compare as one row value, so SQLite seeks the paging index straight to the page; mixed
    /// directions (a filtered browse) spell the comparison out key by key.
    func after(_ placeholders: [String]) -> String {
        let directions = Set(keys.map(\.descending))
        if directions.count == 1 {
            let expressions = keys.map(\.expression).joined(separator: ", ")
            return "(\(expressions)) \(keys[0].descending ? "<" : ">") (\(placeholders.joined(separator: ", ")))"
        }
        let terms = keys.indices.map { index -> String in
            let equal = (0..<index).map { "\(keys[$0].expression) = \(placeholders[$0])" }
            let key = keys[index]
            let strict = "\(key.expression) \(key.descending ? "<" : ">") \(placeholders[index])"
            return "(" + (equal + [strict]).joined(separator: " AND ") + ")"
        }
        return "(" + terms.joined(separator: " OR ") + ")"
    }
}

/// An opaque keyset cursor: the order it belongs to, the segment, and the keys of the last row,
/// encoded as base64url JSON. A cursor is refused by any other order or method.
struct PageCursor: Equatable {
    var scope: String
    var segment: Int
    var values: [SQLValue]

    var encoded: String {
        let keys: [JSONValue] = values.map {
            switch $0 {
            case .null: return .null
            case .int(let value): return .int(value)
            case .double(let value): return .double(value)
            case .text(let value): return .string(value)
            }
        }
        let array: JSONValue = [.string(scope), .int(Int64(segment)), .array(keys)]
        return Data(array.serialized().utf8).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// Decodes a cursor and checks it belongs to `scope` and one of its `segments`.
    static func decode(_ cursor: String, scope: String, segments: [PageSegment]) throws -> PageCursor {
        let invalid = RPCError.badParams("Invalid cursor")
        var base64 = cursor.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
        guard let data = Data(base64Encoded: base64), let value = try? JSONValue.parse(data),
            let array = value.arrayValue, array.count == 3, array[0].stringValue == scope,
            let segment = array[1].intValue.map(Int.init), segments.indices.contains(segment),
            let keys = array[2].arrayValue, keys.count == segments[segment].keys.count
        else { throw invalid }
        let values = try keys.map { key -> SQLValue in
            switch key {
            case .int(let number): return .int(number)
            case .double(let number): return .double(number)
            case .string(let text): return .text(text)
            default: throw invalid
            }
        }
        return PageCursor(scope: scope, segment: segment, values: values)
    }
}
