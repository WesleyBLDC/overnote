import Foundation

/// Typed access to a request's `params` object. Every accessor throws `-32602` on a type
/// mismatch, so handlers never see malformed input.
public struct Params: Sendable {
    public let values: [String: JSONValue]

    /// Accepts a missing or null `params` as `{}`; anything other than an object is rejected.
    public init(_ value: JSONValue?) throws {
        switch value {
        case nil, .null?:
            values = [:]
        case .object(let object)?:
            values = object
        default:
            throw RPCError.badParams("params must be an object")
        }
    }

    private func present(_ key: String) -> JSONValue? {
        guard let value = values[key], !value.isNull else { return nil }
        return value
    }

    public func string(_ key: String) throws -> String {
        guard let value = try optionalString(key) else { throw RPCError.badParams("\(key) is required") }
        return value
    }

    public func optionalString(_ key: String) throws -> String? {
        guard let value = present(key) else { return nil }
        guard let string = value.stringValue else { throw RPCError.badParams("\(key) must be a string") }
        return string
    }

    /// A non-empty id string.
    public func id(_ key: String = "id") throws -> String {
        let value = try string(key)
        guard !value.isEmpty else { throw RPCError.badParams("\(key) must not be empty") }
        return value
    }

    public func optionalInt(_ key: String) throws -> Int64? {
        guard let value = present(key) else { return nil }
        guard let number = value.intValue else { throw RPCError.badParams("\(key) must be an integer") }
        return number
    }

    public func double(_ key: String) throws -> Double {
        guard let value = present(key) else { throw RPCError.badParams("\(key) is required") }
        guard let number = value.doubleValue, number.isFinite else { throw RPCError.badParams("\(key) must be a number") }
        return number
    }

    public func optionalBool(_ key: String) throws -> Bool? {
        guard let value = present(key) else { return nil }
        guard let bool = value.boolValue else { throw RPCError.badParams("\(key) must be a boolean") }
        return bool
    }

    /// An optional positive page size.
    public func limit(default defaultValue: Int) throws -> Int {
        guard let value = try optionalInt("limit") else { return defaultValue }
        guard value >= 1 else { throw RPCError.badParams("limit must be at least 1") }
        return Int(min(value, Int64(NotesRepository.maxListLimit)))
    }
}
