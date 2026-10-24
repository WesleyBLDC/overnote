/** The slash formatting menu, anchored at the caret. */
import type { Editor } from "@tiptap/core";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { SlashItem } from "../editor/slash";
import { revealSelected } from "../lib/motion";
import { useDropdownPlacement } from "./hooks";
import { Keys } from "./Keys";

export interface SlashMenuHandle {
  /** Returns true when the key was used by the menu. */
  onKeyDown(event: KeyboardEvent): boolean;
}

interface SlashMenuProps {
  editor: Editor;
  items: SlashItem[];
  from: number;
  onRun: (item: SlashItem) => void;
  onDismiss: () => void;
}

export const SlashMenu = forwardRef<SlashMenuHandle, SlashMenuProps>(function SlashMenu(
  { editor, items, from, onRun, onDismiss },
  ref,
) {
  const [index, setIndex] = useState(0);
  const selected = Math.min(index, items.length - 1);
  const rootRef = useRef<HTMLDivElement>(null);
  useDropdownPlacement(rootRef, () => editor.view.coordsAtPos(from), {
    prefer: "below",
    gapRem: 0.3,
    align: "start",
  });
  useEffect(() => revealSelected(rootRef.current, true), [selected]);

  useImperativeHandle(ref, () => ({
    onKeyDown(event) {
      if (event.key === "ArrowDown") setIndex((selected + 1) % items.length);
      else if (event.key === "ArrowUp") setIndex((selected - 1 + items.length) % items.length);
      else if (event.key === "Enter") {
        const item = items[selected];
        if (item) onRun(item);
      } else if (event.key === "Escape") onDismiss();
      else if (event.key === "Tab") {
        // swallowed while the menu is open
      } else return false;
      return true;
    },
  }));

  let lastSection = "";
  return (
    <div className="popover slash-menu" role="listbox" data-testid="slash-menu" ref={rootRef}>
      {items.map((item, i) => {
        const header = item.section !== lastSection ? item.section : null;
        lastSection = item.section;
        return (
          <div key={item.id}>
            {header ? <div className="menu-section">{header}</div> : null}
            <button
              type="button"
              role="option"
              aria-selected={i === selected}
              className={`menu-item${i === selected ? " is-selected" : ""}`}
              onMouseEnter={() => setIndex(i)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onRun(item)}
              tabIndex={i === selected ? 0 : -1}
            >
              <span className="menu-title">{item.title}</span>
              <Keys shortcut={item.shortcut} />
            </button>
          </div>
        );
      })}
    </div>
  );
});
