/** A small dropdown menu with keyboard navigation, used by the format bar and Search's sort pill. */
import { Fragment, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { revealSelected } from "../lib/motion";
import { useDropdownPlacement } from "./hooks";
import { Icon } from "./icons";
import { Keys } from "./Keys";

export interface MenuItem {
  id: string;
  title: string;
  shortcut?: string;
  checked?: boolean;
  /** Drawn after a divider. */
  divider?: boolean;
}

interface MenuProps {
  items: MenuItem[];
  /** The button the menu opens from. */
  anchor: HTMLElement | null;
  onSelect: (id: string) => void;
  onClose: () => void;
  /** By default the menu drops up, centred on its button. */
  prefer?: "above" | "below";
  align?: "center" | "end";
}

/**
 * Rendered in the app rather than in the format bar, so it is placed against the whole window and
 * never takes on the bar's dimmed opacity while the pointer is away.
 */
export function Menu({ items, anchor, onSelect, onClose, prefer = "above", align = "center" }: MenuProps) {
  // Opens on the checked item, so the keys start from the current choice.
  const [index, setIndex] = useState(() =>
    Math.max(
      0,
      items.findIndex((item) => item.checked),
    ),
  );
  const ref = useRef<HTMLDivElement>(null);
  useDropdownPlacement(ref, () => anchor?.getBoundingClientRect() ?? null, { prefer, gapRem: 0.5, align });
  useEffect(() => revealSelected(ref.current, true), [index]);
  useEffect(() => {
    ref.current?.focus();
    // A press on the menu's own button is left to its click, which toggles the menu.
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!ref.current?.contains(target) && !anchor?.contains(target)) onClose();
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [anchor, onClose]);
  // Over an open panel (Search's sort pill) the menu joins the panel's layer, so it draws above it.
  const container = anchor?.closest(".panel-backdrop") ?? anchor?.closest(".app");
  if (!container) return null;
  return createPortal(
    <div
      className="menu"
      role="menu"
      tabIndex={-1}
      ref={ref}
      onKeyDown={(event) => {
        if (event.key === "ArrowDown") setIndex((i) => (i + 1) % items.length);
        else if (event.key === "ArrowUp") setIndex((i) => (i - 1 + items.length) % items.length);
        else if (event.key === "Enter") {
          const item = items[index];
          if (item) onSelect(item.id);
        } else if (event.key === "Escape") onClose();
        else return;
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      {items.map((item, i) => (
        <Fragment key={item.id}>
          {item.divider ? <div className="menu-divider" role="separator" /> : null}
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={item.checked ?? false}
            className={`menu-item${i === index ? " is-selected" : ""}`}
            onMouseEnter={() => setIndex(i)}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onSelect(item.id)}
            tabIndex={i === index ? 0 : -1}
          >
            <span className="menu-check">{item.checked ? <Icon name="check" /> : null}</span>
            <span className="menu-title">{item.title}</span>
            {item.shortcut ? <Keys shortcut={item.shortcut} /> : null}
          </button>
        </Fragment>
      ))}
    </div>,
    container,
  );
}
