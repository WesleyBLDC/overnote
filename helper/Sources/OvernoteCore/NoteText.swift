import Foundation

/// What Search shows about a note's text without loading it: its word count and the passage
/// around a match (docs/architecture.md section 5, `notes.browse`).
public enum NoteText {
    /// Words of `text`: the word-like segments of the Unicode word break rules (UAX #29), as the
    /// TypeScript core's `countWords` counts them. Both are checked against one golden corpus,
    /// `packages/core/tests/word-corpus.json`.
    public static func wordCount(_ text: String) -> Int {
        var count = 0
        text.enumerateSubstrings(in: text.startIndex..<text.endIndex, options: [.byWords, .substringNotRequired]) {
            _, _, _, _ in count += 1
        }
        return count
    }

    /// Characters a snippet keeps ahead of its match, and its longest length.
    static let snippetLead = 40
    static let snippetLength = 160

    /// The passage around the first match of `foldedTerm` in `text`, matched by the fold rule:
    /// up to `snippetLead` characters ahead of it, starting on a word, with an ellipsis when it
    /// starts mid note, and at most `snippetLength` characters. Nil when the term does not occur.
    ///
    /// `startsNote` is false when `text` is a window cut from further into the note.
    static func snippet(in text: String, foldedTerm: String, startsNote: Bool = true) -> String? {
        let term = Array(foldedTerm.unicodeScalars)
        guard !term.isEmpty else { return nil }
        let characters = Array(text)
        // The folded text, with the character each folded scalar came from.
        var folded: [Unicode.Scalar] = []
        var owner: [Int] = []
        folded.reserveCapacity(characters.count)
        owner.reserveCapacity(characters.count)
        for (index, character) in characters.enumerated() {
            let scalars =
                character.isASCII ? String(character).lowercased().unicodeScalars : TextFolding.fold(String(character)).unicodeScalars
            for scalar in scalars {
                folded.append(scalar)
                owner.append(index)
            }
        }
        guard let at = firstIndex(of: term, in: folded) else { return nil }
        let match = owner[at]
        var start = 0
        if match > snippetLead {
            // Start on the first word that begins inside the lead, never mid word.
            let lead = match - snippetLead
            start = (lead..<match).first { $0 > 0 && characters[$0 - 1].isWhitespace && !characters[$0].isWhitespace } ?? match
        }
        let passage = String(characters[start..<min(characters.count, start + snippetLength)])
        return start > 0 || !startsNote ? "…\(passage)" : passage
    }

    private static func firstIndex(of needle: [Unicode.Scalar], in haystack: [Unicode.Scalar]) -> Int? {
        guard needle.count <= haystack.count else { return nil }
        let first = needle[0]
        var index = 0
        while index <= haystack.count - needle.count {
            if haystack[index] == first, haystack[index..<(index + needle.count)].elementsEqual(needle) { return index }
            index += 1
        }
        return nil
    }
}
