/**
 * The format island (board 05, SPEC §5): H, B, I, then </>, quote, and list, centred on the bottom row.
 * Heading and list open a small menu that drops up; the rest toggle at once. Everything the island left out
 * (strikethrough, underline, link, code block) stays on its shortcut, the slash menu, and ⌘K.
 */
import type { Editor } from "@tiptap/core";
import { useState, type ReactNode } from "react";
import { activeListKind, isFormatActive, runFormat, type FormatId } from "../editor/commands";
import { Menu, type MenuItem } from "./Menu";
import { Tooltip } from "./Tooltip";

interface FormatBarProps {
  editor: Editor;
  openLink: () => void;
  /** Pinned with Aa or ⌥⌘,: the island stays and draws on the solid pinned surface. */
  pinned: boolean;
  /** Shown: pinned, text selected, or the pointer near the bottom of the note. */
  shown: boolean;
}

type MenuName = "heading" | "list" | null;

const HEADINGS: [FormatId, string, string][] = [
  ["h1", "Heading 1", "⌥⌘1"],
  ["h2", "Heading 2", "⌥⌘2"],
  ["h3", "Heading 3", "⌥⌘3"],
];
const LISTS: [FormatId, string, string][] = [
  ["ordered", "Ordered List", "⇧⌘7"],
  ["bullet", "Bullet List", "⇧⌘8"],
  ["task", "Task List", "⇧⌘9"],
];

export function FormatBar({ editor, openLink, pinned, shown }: FormatBarProps) {
  const [open, setOpen] = useState<MenuName>(null);
  // The open menu's button: the menu drops up from it.
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const run = (id: FormatId) => {
    setOpen(null);
    runFormat(editor, id, openLink);
  };
  const items = (list: [FormatId, string, string][]): MenuItem[] =>
    list.map(([id, title, shortcut]) => ({ id, title, shortcut, checked: isFormatActive(editor, id) }));
  const toggleMenu = (name: Exclude<MenuName, null>) => (target: HTMLElement) => {
    setAnchor(target);
    setOpen(open === name ? null : name);
  };

  const button = (props: {
    glyph: ReactNode;
    label: string;
    shortcut?: string;
    active: boolean;
    onClick: (target: HTMLElement) => void;
    wide?: boolean;
    className?: string;
  }) => (
    <button
      type="button"
      className={`island-button has-tooltip${props.wide ? " is-wide" : ""}${props.className ? ` ${props.className}` : ""}${props.active ? " is-active" : ""}`}
      aria-label={props.shortcut ? `${props.label} (${props.shortcut})` : props.label}
      aria-pressed={props.active}
      tabIndex={-1}
      onMouseDown={(event) => event.preventDefault()}
      onClick={(event) => props.onClick(event.currentTarget)}
    >
      {props.glyph}
      <Tooltip label={props.label} shortcut={props.shortcut} placement="above" />
    </button>
  );

  return (
    <div
      className={`format-bar${pinned ? " is-pinned" : ""}`}
      data-testid="format-bar"
      data-shown={shown || open !== null}
      role="toolbar"
      aria-label="Format"
    >
      <div className="format-group">
        {button({
          glyph: "H",
          label: "Heading",
          active: editor.isActive("heading"),
          onClick: toggleMenu("heading"),
        })}
        {open === "heading" ? (
          <Menu
            items={items(HEADINGS)}
            anchor={anchor}
            onSelect={(id) => run(id as FormatId)}
            onClose={() => setOpen(null)}
          />
        ) : null}
      </div>
      {button({
        glyph: "B",
        label: "Bold",
        shortcut: "⌘B",
        active: editor.isActive("bold"),
        onClick: () => run("bold"),
      })}
      {button({
        glyph: "I",
        label: "Italic",
        shortcut: "⌘I",
        className: "is-italic",
        active: editor.isActive("italic"),
        onClick: () => run("italic"),
      })}
      <span className="format-divider" />
      {button({
        glyph: "</>",
        label: "Code",
        shortcut: "⌘E",
        wide: true,
        active: editor.isActive("code"),
        onClick: () => run("code"),
      })}
      {button({
        glyph: "”",
        label: "Quote",
        shortcut: "⇧⌘B",
        active: editor.isActive("blockquote"),
        onClick: () => run("blockquote"),
      })}
      <div className="format-group">
        {button({ glyph: "☰", label: "List", active: activeListKind(editor) !== null, onClick: toggleMenu("list") })}
        {open === "list" ? (
          <Menu
            items={items(LISTS)}
            anchor={anchor}
            onSelect={(id) => run(id as FormatId)}
            onClose={() => setOpen(null)}
          />
        ) : null}
      </div>
    </div>
  );
}
