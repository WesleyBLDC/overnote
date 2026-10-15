import Foundation

/// Opaque keyset cursors for `notes.list` and `notes.browse`.
///
/// A cursor is the sort key of the last row of a page, encoded as base64url JSON:
/// `(match group, pin group, pin key, negated order timestamp, id)`, compared ascending.
/// The match group is 0 for title matches in a filtered browse and 0 otherwise; the pin
/// group is 0 for pinned and 1 for unpinned notes. The order timestamp is `updatedAt` for
/// list and `lastAccessedAt` for browse, negated so that every column sorts ascending.
struct ListCursor: Equatable {
    enum Kind: String {
        case list = "l"
        case browse = "b"
    }

    var kind: Kind
    var matchGroup: Int64
    var pinGroup: Int64
    var pinKey: Double
    var negatedTimestamp: Int64
    var id: String

    var encoded: String {
        let values: JSONValue = [
            .string(kind.rawValue), .int(matchGroup), .int(pinGroup), .double(pinKey), .int(negatedTimestamp), .string(id),
        ]
        return Data(values.serialized().utf8).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    static func decode(_ cursor: String, kind: Kind) throws -> ListCursor {
        let invalid = RPCError.badParams("Invalid cursor")
        var base64 = cursor.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
        guard let data = Data(base64Encoded: base64), let value = try? JSONValue.parse(data),
            let array = value.arrayValue, array.count == 6, array[0].stringValue == kind.rawValue,
            let matchGroup = array[1].intValue, let pinGroup = array[2].intValue, let pinKey = array[3].doubleValue,
            let timestamp = array[4].intValue, let id = array[5].stringValue
        else { throw invalid }
        return ListCursor(
            kind: kind, matchGroup: matchGroup, pinGroup: pinGroup, pinKey: pinKey, negatedTimestamp: timestamp, id: id)
    }
}
