/** A keyboard shortcut drawn as one small keycap per key, for example ⇧ ⌘ P. */
export function Keys({ shortcut }: { shortcut: string }) {
  return (
    <span className="keys">
      {Array.from(shortcut).map((key, i) => (
        <kbd key={`${key}-${i}`} className="keycap">
          {key}
        </kbd>
      ))}
    </span>
  );
}
