import Foundation

/// Folding used for filter matching (contract section 5, "Filter matching").
///
/// Stored copies (`title_fold`, `text_fold`) and the filter are folded the same way, so a
/// plain substring test on the folded strings is case and diacritic insensitive for all of
/// Unicode.
public enum TextFolding {
    /// NFKD, then drop every combining mark (nonspacing, spacing, enclosing), then lowercase.
    ///
    /// This must match the TypeScript side exactly (contract v2.4), so it deliberately avoids
    /// `String.folding(options:)`, which treats ß and ligatures differently.
    public static func fold(_ value: String) -> String {
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
