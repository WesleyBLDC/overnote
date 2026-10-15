/// An error that maps directly onto a JSON-RPC error object (contract section 2).
public struct RPCError: Error, Equatable, Sendable, CustomStringConvertible {
    public let code: Int
    public let message: String

    public init(code: Int, message: String) {
        self.code = code
        self.message = message
    }

    public static let methodNotFoundCode = -32601
    public static let badParamsCode = -32602
    public static let notFoundCode = 404
    public static let conflictCode = 409
    public static let internalCode = 500

    public static func methodNotFound(_ method: String) -> RPCError {
        RPCError(code: methodNotFoundCode, message: "Unknown method: \(method)")
    }

    public static func badParams(_ message: String) -> RPCError {
        RPCError(code: badParamsCode, message: message)
    }

    public static func notFound(_ message: String) -> RPCError {
        RPCError(code: notFoundCode, message: message)
    }

    public static func noteNotFound(_ id: String) -> RPCError {
        RPCError(code: notFoundCode, message: "Note not found: \(id)")
    }

    public static func conflict(_ message: String) -> RPCError {
        RPCError(code: conflictCode, message: message)
    }

    public static func `internal`(_ message: String) -> RPCError {
        RPCError(code: internalCode, message: message)
    }

    public var json: JSONValue {
        ["code": .int(Int64(code)), "message": .string(message)]
    }

    public var description: String { "RPCError(\(code)): \(message)" }
}
