/** Inline emoji picker: a quick strip, the full picker, and a search grid. */
import type { Editor } from "@tiptap/core";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { CATEGORIES, frequentEmoji, loadEmoji, quickEmoji, searchEmoji, type EmojiEntry } from "../editor/emoji";
import { revealSelected } from "../lib/motion";
import { useDropdownPlacement } from "./hooks";

export interface EmojiPickerHandle {
  onKeyDown(event: KeyboardEvent): boolean;
}

interface EmojiPickerProps {
  editor: Editor;
  from: number;
  query: string;
  onPick: (emoji: string) => void;
  onDismiss: () => void;
}

const COLUMNS = 9;

interface Cell {
  emoji: string;
  label: string;
  section?: string;
}

export const EmojiPicker = forwardRef<EmojiPickerHandle, EmojiPickerProps>(function EmojiPicker(
  { editor, from, query, onPick, onDismiss },
  ref,
) {
  const [entries, setEntries] = useState<EmojiEntry[] | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [index, setIndex] = useState(0);
  const gridRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  useDropdownPlacement(rootRef, () => editor.view.coordsAtPos(from), {
    prefer: "below",
    gapRem: 0.3,
    align: "start",
  });

  useEffect(() => {
    let alive = true;
    void loadEmoji().then((list) => alive && setEntries(list));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => setIndex(0), [query, expanded]);

  const byEmoji = useMemo(() => new Map((entries ?? []).map((entry) => [entry.emoji, entry])), [entries]);
  const labelOf = useCallback(
    (emoji: string) => byEmoji.get(emoji)?.label ?? byEmoji.get(emoji.replace("\ufe0f", ""))?.label ?? emoji,
    [byEmoji],
  );

  const mode: "search" | "full" | "quick" = query ? "search" : expanded ? "full" : "quick";
  const cells: Cell[] = useMemo(() => {
    if (mode === "search")
      return entries ? searchEmoji(entries, query).map((e) => ({ emoji: e.emoji, label: e.label })) : [];
    if (mode === "quick") return quickEmoji().map((emoji) => ({ emoji, label: labelOf(emoji) }));
    const out: Cell[] = [];
    const frequent = frequentEmoji().slice(0, 14);
    frequent.forEach((emoji, i) =>
      out.push({ emoji, label: labelOf(emoji), section: i === 0 ? "Frequently Used" : undefined }),
    );
    for (const category of CATEGORIES) {
      const list = (entries ?? []).filter((e) => category.groups.includes(e.group));
      list.forEach((e, i) =>
        out.push({ emoji: e.emoji, label: e.label, section: i === 0 ? category.name : undefined }),
      );
    }
    return out;
  }, [mode, entries, query, labelOf]);

  const loading = mode === "search" && entries === null;
  const selected = Math.min(index, Math.max(0, cells.length - 1));
  const quickButtonIndex = mode === "quick" ? cells.length : -1;
  const itemCount = mode === "quick" ? cells.length + 1 : cells.length;

  useEffect(() => {
    revealSelected(gridRef.current, true);
  }, [selected]);

  useImperativeHandle(ref, () => ({
    onKeyDown(event) {
      if (event.key === "Escape") onDismiss();
      else if (event.key === "Enter" || event.key === "Tab") {
        if (loading) return true;
        if (event.key === "Tab") return true;
        if (index === quickButtonIndex) setExpanded(true);
        else {
          const cell = cells[selected];
          if (!cell) return false;
          onPick(cell.emoji);
        }
      } else if (event.key === "ArrowRight") setIndex((i) => Math.min(itemCount - 1, i + 1));
      else if (event.key === "ArrowLeft") setIndex((i) => Math.max(0, i - 1));
      else if (event.key === "ArrowDown" && mode !== "quick") setIndex((i) => Math.min(itemCount - 1, i + COLUMNS));
      else if (event.key === "ArrowUp" && mode !== "quick") setIndex((i) => Math.max(0, i - COLUMNS));
      else return false;
      return true;
    },
  }));

  if (mode === "search" && !loading && cells.length === 0) return null;

  return (
    <div
      className={`popover emoji-picker is-${mode}`}
      data-testid="emoji-picker"
      ref={rootRef}
      onMouseDown={(e) => e.preventDefault()}
    >
      {mode === "full" ? (
        <div className="emoji-categories">
          {["Frequently Used", ...CATEGORIES.map((c) => c.name)].map((name) => (
            <button
              key={name}
              type="button"
              className="emoji-category"
              title={name}
              tabIndex={-1}
              onClick={() =>
                gridRef.current?.querySelector(`[data-section="${name}"]`)?.scrollIntoView({ block: "start" })
              }
            >
              {name.slice(0, 1)}
            </button>
          ))}
        </div>
      ) : null}
      <div className="emoji-grid" ref={gridRef} role="listbox">
        {cells.map((cell, i) => (
          <span key={`${cell.emoji}-${i}`} className="emoji-cell-wrap" data-section={cell.section}>
            {cell.section ? <span className="emoji-section">{cell.section}</span> : null}
            <button
              type="button"
              role="option"
              aria-selected={i === selected && index !== quickButtonIndex}
              aria-label={cell.label}
              className={`emoji-cell${i === selected && index !== quickButtonIndex ? " is-selected" : ""}`}
              tabIndex={-1}
              onMouseEnter={() => setIndex(i)}
              onClick={() => onPick(cell.emoji)}
            >
              {cell.emoji}
            </button>
          </span>
        ))}
        {mode === "quick" ? (
          <button
            type="button"
            className={`emoji-open${index === quickButtonIndex ? " is-selected" : ""}`}
            tabIndex={-1}
            onClick={() => setExpanded(true)}
          >
            Open Emoji Picker
          </button>
        ) : null}
      </div>
      {mode !== "quick" ? (
        <div className="emoji-name">{loading ? "Loading…" : (cells[selected]?.label ?? "")}</div>
      ) : null}
    </div>
  );
});
