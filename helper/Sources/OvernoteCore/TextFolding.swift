import Foundation

/// Folding used for filter matching (docs/architecture.md section 5, "Filter matching").
///
/// Stored copies (`title_fold`, `text_fold`) and the filter are folded the same way, so a
/// plain substring test on the folded strings is case and diacritic insensitive for all of
/// Unicode.
public enum TextFolding {
    /// NFKD, then drop every combining mark (nonspacing, spacing, enclosing), then lowercase.
    ///
    /// This must match the TypeScript side exactly (the fold rule in docs/architecture.md section 5), so it deliberately avoids
    /// `String.folding(options:)`, which treats ß and ligatures differently.
    public static func fold(_ value: String) -> String {
        // ASCII fast path gate, stated precisely: every UTF-8 code unit of `value` is below
        // 0x80. For a well formed Swift string that is exactly the statement that every
        // Unicode scalar lies in U+0000 to U+007F, because every scalar at or above U+0080
        // encodes as two or more UTF-8 code units and every code unit of such a sequence is
        // at or above 0x80. Combining marks are therefore never ASCII under this gate. A
        // mark in the U+0300 block, or any other mark, encodes with code units at or above
        // 0x80, so a sequence such as the letter e followed by U+0301 fails the gate and
        // takes the general path below, which removes the mark.
        //
        // The gate is safe because the general path is the identity on plain ASCII before
        // its final step. No scalar in U+0000 to U+007F has a compatibility decomposition,
        // and none of them has a mark general category, so NFKD and mark removal change
        // nothing, including digits, punctuation, and the control characters U+0000 to
        // U+001F and U+007F that can occur in note text. Only lowercasing remains, and
        // `lowercased()` on plain ASCII maps A to Z to a to z and leaves every other byte
        // unchanged, which is byte identical to the general path for every ASCII input.
        if value.utf8.allSatisfy({ $0 < 0x80 }) {
            return value.lowercased()
        }
        var scalars = String.UnicodeScalarView()
        for scalar in value.decomposedStringWithCompatibilityMapping.unicodeScalars {
            switch scalar.properties.generalCategory {
            case .nonspacingMark, .spacingMark, .enclosingMark:
                continue
            default:
                scalars.append(scalar)
            }
        }
        return String(scalars).lowercased()
    }

    /// The folded form of a filter, or nil when the filter is empty or only whitespace.
    static func foldedTerm(for filter: String?) -> String? {
        guard let filter else { return nil }
        let trimmed = filter.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        return fold(trimmed)
    }

    /// Whether the FTS5 trigram index can answer this folded term with the same substring
    /// semantics as the folded `LIKE` scan.
    ///
    /// The trigram tokenizer only forms an indexable gram from three or more scalars, so short
    /// terms keep the `LIKE` path, which is also the correctness reference in the tests.
    static func canUseFTS(foldedTerm: String) -> Bool {
        foldedTerm.unicodeScalars.count >= 3
    }

    /// The FTS5 phrase for a folded term, with embedded quotes doubled, or nil when the index
    /// cannot answer the term.
    static func ftsPhrase(for filter: String?) -> String? {
        guard let term = foldedTerm(for: filter), canUseFTS(foldedTerm: term) else { return nil }
        return "\"\(term.replacingOccurrences(of: "\"", with: "\"\""))\""
    }

    /// The `LIKE` pattern for a filter, or nil when the filter is empty or only whitespace.
    /// `%`, `_`, and the escape character itself are escaped so they match literally;
    /// use it with `ESCAPE '\'`.
    static func likePattern(for filter: String?) -> String? {
        guard let filter else { return nil }
        let trimmed = filter.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        var escaped = ""
        for character in fold(trimmed) {
            if character == "\\" || character == "%" || character == "_" {
                escaped.append("\\")
            }
            escaped.append(character)
        }
        return "%\(escaped)%"
    }
}
