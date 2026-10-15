import Foundation

/// Generates ULIDs: 48 bits of millisecond time and 80 random bits, encoded as 26 Crockford
/// base32 characters.
///
/// Ids generated in the same millisecond (or when the clock goes backwards) are kept
/// strictly increasing by incrementing the random part, so ids always sort by creation order.
/// Not thread safe on its own; the repository serializes access.
public struct ULIDGenerator: Sendable {
    static let alphabet = Array("0123456789ABCDEFGHJKMNPQRSTVWXYZ".utf8)

    private var lastTime: UInt64 = 0
    private var lastRandom: (high: UInt16, low: UInt64) = (0, 0)

    public init() {}

    public mutating func next(now: Millis) -> String {
        var time = UInt64(max(0, now)) & 0xFFFF_FFFF_FFFF
        var random: (high: UInt16, low: UInt64)
        if time <= lastTime {
            // Same millisecond or clock skew: stay on the last time and increment.
            time = lastTime
            random = lastRandom
            let (low, overflow) = random.low.addingReportingOverflow(1)
            random.low = low
            if overflow {
                random.high &+= 1
            }
        } else {
            var generator = SystemRandomNumberGenerator()
            random = (UInt16.random(in: .min ... .max, using: &generator), UInt64.random(in: .min ... .max, using: &generator))
        }
        lastTime = time
        lastRandom = random
        return ULIDGenerator.encode(time: time, randomHigh: random.high, randomLow: random.low)
    }

    static func encode(time: UInt64, randomHigh: UInt16, randomLow: UInt64) -> String {
        var output = [UInt8](repeating: 0, count: 26)
        // Time: 48 bits into 10 characters (the first carries only 3 bits).
        var t = time
        for index in stride(from: 9, through: 0, by: -1) {
            output[index] = alphabet[Int(t & 31)]
            t >>= 5
        }
        // Randomness: 80 bits into 16 characters.
        var high = UInt64(randomHigh)
        var low = randomLow
        for index in stride(from: 25, through: 10, by: -1) {
            output[index] = alphabet[Int(low & 31)]
            low = (low >> 5) | ((high & 31) << 59)
            high >>= 5
        }
        return String(decoding: output, as: UTF8.self)
    }

    /// True when `value` looks like a ULID (26 Crockford base32 characters, uppercase).
    public static func isValid(_ value: String) -> Bool {
        let bytes = Array(value.utf8)
        guard bytes.count == 26, let first = bytes.first, first <= UInt8(ascii: "7") else { return false }
        return bytes.allSatisfy { alphabet.contains($0) }
    }
}
