import Darwin
import Foundation

/// Shared newline search for the newline delimited socket framing.
///
/// Callers keep a resume offset in byte offsets: the offset is the first byte that is
/// not yet known to be free of a newline, so bytes before it are never scanned again.
/// This keeps a line that arrives over many small socket reads linear instead of
/// rescanning the accumulated line from the start after every read.
enum NewlineSearch {
    /// Returns the byte offset of the first newline at or after `offset`, or nil.
    static func index(in bytes: [UInt8], from offset: Int) -> Int? {
        guard offset >= 0, offset < bytes.count else { return nil }
        return bytes.withUnsafeBufferPointer { pointer -> Int? in
            guard let base = pointer.baseAddress else { return nil }
            let start = base + offset
            guard let found = memchr(start, Int32(UInt8(ascii: "\n")), bytes.count - offset) else {
                return nil
            }
            return offset + (UnsafeRawPointer(found) - UnsafeRawPointer(start))
        }
    }
}
