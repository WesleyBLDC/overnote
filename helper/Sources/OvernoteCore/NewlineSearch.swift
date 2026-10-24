import Darwin

/// Finds line ends in a growing read buffer without rescanning bytes already searched.
///
/// Resume offset contract: a reader keeps a `scanOffset` with the invariant that no byte of its
/// buffer before `scanOffset` is a newline. It passes that offset here after every read; when no
/// newline is found it sets the offset to the buffer's count, and when it removes a returned line
/// from the front of the buffer it resets the offset to 0, because the bytes left behind start
/// at index 0 and have not been scanned. A request arriving in many small reads is then searched
/// once in total, not once per read.
enum NewlineSearch {
    /// The index of the first `\n` in `buffer` at or after `offset`, or nil when there is none.
    static func firstNewline(in buffer: [UInt8], from offset: Int) -> Int? {
        guard offset < buffer.count else { return nil }
        return buffer.withUnsafeBufferPointer { bytes -> Int? in
            guard let base = bytes.baseAddress,
                let found = memchr(base + offset, Int32(UInt8(ascii: "\n")), bytes.count - offset)
            else { return nil }
            return base.distance(to: found.assumingMemoryBound(to: UInt8.self))
        }
    }
}
