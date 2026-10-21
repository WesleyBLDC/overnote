/** A small dropdown menu with keyboard navigation, used by the format bar. */
import { useEffect, useRef, useState } from "react";
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
}

interface MenuProps {
  items: MenuItem[];
  /** The button the menu drops up from. */
  anchor: HTMLElement | null;
  onSelect: (id: string) => void;
  onClose: () => void;
}

/**
 * Rendered in the app rather than in the format bar, so it is placed against the whole panel and
 * never takes on the bar's dimmed opacity while the pointer is away.
 */
export function Menu({ items, anchor, onSelect, onClose }: MenuProps) {
  const [index, setIndex] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  useDropdownPlacement(ref, () => anchor?.getBoundingClientRect() ?? null, {
    prefer: "above",
    gapRem: 0.5,
    align: "center",
  });
  useEffect(() => revealSelected(ref.current, true), [index]);
  useEffect(() => {
    ref.current?.focus();
    const onDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [onClose]);
  const container = anchor?.closest(".app");
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
        <button
          type="button"
          role="menuitemcheckbox"
          aria-checked={item.checked ?? false}
          key={item.id}
          className={`menu-item${i === index ? " is-selected" : ""}`}
          onMouseEnter={() => setIndex(i)}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onSelect(item.id)}
          tabIndex={-1}
        >
          <span className="menu-check">{item.checked ? <Icon name="check" /> : null}</span>
          <span className="menu-title">{item.title}</span>
          {item.shortcut ? <Keys shortcut={item.shortcut} /> : null}
        </button>
      ))}
    </div>,
    container,
  );
}
