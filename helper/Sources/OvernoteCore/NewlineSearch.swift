import Darwin

/// Finds line ends in a growing read buffer without rescanning bytes already searched.
///
/// Resume offset contract: a reader keeps a `scanOffset` into its buffer. No byte in
/// `[readStart, scanOffset)` is a newline. It passes `max(scanOffset, readStart)` here after
/// every read. When no newline is found it sets `scanOffset` to the buffer's count. When it
/// drops a returned prefix (`LineBuffer` compacts after the consumed half), it resets
/// `scanOffset` to 0, because the bytes left behind start at index 0. A request arriving in
/// many small reads is then searched once in total, not once per read.
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

/// Bytes of a socket read, handed out one line at a time.
///
/// The consumed prefix stays in place until it is at least 4 KB and at least half the storage,
/// then the buffer shifts once. A batch of short lines therefore shifts a handful of times,
/// not once per line.
struct LineBuffer {
    private var bytes: [UInt8] = []
    /// No newline in `bytes[start..<scanOffset]`.
    private var scanOffset = 0
    /// First byte that has not been returned as a line.
    private var start = 0
    /// How many times the storage has shifted. A batch of lines stays far below the line count.
    private(set) var shifts = 0

    mutating func append(_ chunk: ArraySlice<UInt8>) {
        bytes.append(contentsOf: chunk)
    }

    /// The next line without its newline, or nil when the unread bytes hold no newline yet.
    mutating func nextLine() -> [UInt8]? {
        guard let newline = NewlineSearch.firstNewline(in: bytes, from: max(scanOffset, start)) else {
            scanOffset = bytes.count
            return nil
        }
        let line = Array(bytes[start..<newline])
        start = newline + 1
        if start >= 4_096, start * 2 >= bytes.count {
            bytes.removeFirst(start)
            shifts += 1
            scanOffset = 0
            start = 0
        } else {
            scanOffset = start
        }
        return line
    }
}
