/** The slash formatting menu, anchored at the caret. */
import type { Editor } from "@tiptap/core";
import { forwardRef, useImperativeHandle, useLayoutEffect, useState } from "react";
import type { SlashItem } from "../editor/slash";
import { Keys } from "./Keys";

export interface SlashMenuHandle {
  /** Returns true when the key was used by the menu. */
  onKeyDown(event: KeyboardEvent): boolean;
}

interface SlashMenuProps {
  editor: Editor;
  items: SlashItem[];
  from: number;
  container: HTMLElement | null;
  onRun: (item: SlashItem) => void;
  onDismiss: () => void;
}

export const SlashMenu = forwardRef<SlashMenuHandle, SlashMenuProps>(function SlashMenu(
  { editor, items, from, container, onRun, onDismiss },
  ref,
) {
  const [index, setIndex] = useState(0);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const selected = Math.min(index, items.length - 1);

  useLayoutEffect(() => {
    const coords = editor.view.coordsAtPos(from);
    const box = container?.getBoundingClientRect() ?? { left: 0, top: 0, width: window.innerWidth };
    setPosition({ left: Math.max(8, Math.min(coords.left - box.left, box.width - 288)), top: coords.bottom - box.top + 4 });
  }, [editor, from, container, items.length]);

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
    <div className="popover slash-menu" role="listbox" data-testid="slash-menu" style={{ left: position.left, top: position.top }}>
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
              tabIndex={-1}
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
