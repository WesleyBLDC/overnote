/** Search's match marks (SPEC §7): every occurrence of the query, case-insensitive, on --find-match. */

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function Highlight({ text, query }: { text: string; query: string }) {
  const q = query.trim();
  if (!q) return <>{text}</>;
  const parts = text.split(new RegExp(`(${escape(q)})`, "gi"));
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="search-match">
            {part}
          </mark>
        ) : (
          part
        ),
      )}
    </>
  );
}

/**
 * The passage around the first match, so a match deep in a note still shows: up to `before` characters ahead of
 * it, starting on a word, with an ellipsis when it starts mid note. The text as is when nothing matches.
 */
export function snippetAround(text: string, query: string, before = 40): string {
  const q = query.trim().toLocaleLowerCase();
  const at = q ? text.toLocaleLowerCase().indexOf(q) : -1;
  if (at <= before) return text;
  // Start on the first word that begins inside the window, never mid word.
  const gap = text.slice(at - before, at).search(/\s\S/);
  return `…${text.slice(gap >= 0 ? at - before + gap + 1 : at)}`;
}
