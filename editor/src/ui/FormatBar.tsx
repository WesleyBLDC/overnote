/** The format bar (spec/editor.md section 7), shown in the bottom bar in place of the counter. */
import type { Editor } from "@tiptap/core";
import { useEffect, useState } from "react";
import { activeListKind, isFormatActive, runFormat, type FormatId } from "../editor/commands";
import { Icon, type IconName } from "./icons";
import { Menu, type MenuItem } from "./Menu";

interface FormatBarProps {
  editor: Editor;
  openLink: () => void;
  /** Tells the window a dropdown is open, so it can make room for it. */
  onMenuChange?: (open: boolean) => void;
}

type MenuName = "heading" | "format" | "list" | null;

const HEADINGS: [FormatId, string, string][] = [
  ["h1", "Heading 1", "⌥⌘1"],
  ["h2", "Heading 2", "⌥⌘2"],
  ["h3", "Heading 3", "⌥⌘3"],
];
const MARKS: [FormatId, string, string][] = [
  ["bold", "Bold", "⌘B"],
  ["italic", "Italic", "⌘I"],
  ["strike", "Strikethrough", "⇧⌘S"],
  ["underline", "Underline", "⌘U"],
];
const LISTS: [FormatId, string, string][] = [
  ["ordered", "Ordered List", "⇧⌘7"],
  ["bullet", "Bullet List", "⇧⌘8"],
  ["task", "Task List", "⇧⌘9"],
];

export function FormatBar({ editor, openLink, onMenuChange }: FormatBarProps) {
  const [open, setOpen] = useState<MenuName>(null);
  useEffect(() => {
    onMenuChange?.(open !== null);
    return () => onMenuChange?.(false);
  }, [open, onMenuChange]);
  const run = (id: FormatId) => {
    setOpen(null);
    runFormat(editor, id, openLink);
  };
  const items = (list: [FormatId, string, string][]): MenuItem[] =>
    list.map(([id, title, shortcut]) => ({ id, title, shortcut, checked: isFormatActive(editor, id) }));
  const listKind = activeListKind(editor);
  const listIcon: IconName = listKind === "ordered" ? "ordered" : listKind === "task" ? "task" : "bullet";

  const button = (props: { icon: IconName; label: string; active: boolean; onClick: () => void; menu?: boolean }) => (
    <button
      type="button"
      className={`format-button${props.active ? " is-active" : ""}`}
      title={props.label}
      aria-label={props.label}
      aria-pressed={props.active}
      tabIndex={-1}
      onMouseDown={(event) => event.preventDefault()}
      onClick={props.onClick}
    >
      <Icon name={props.icon} />
      {props.menu ? <Icon name="chevronDown" /> : null}
    </button>
  );

  return (
    <div className="format-bar" data-testid="format-bar" role="toolbar" aria-label="Format">
      <div className="format-group">
        {button({ icon: "heading", label: "Heading", active: editor.isActive("heading"), onClick: () => setOpen(open === "heading" ? null : "heading"), menu: true })}
        {open === "heading" ? <Menu items={items(HEADINGS)} onSelect={(id) => run(id as FormatId)} onClose={() => setOpen(null)} /> : null}
      </div>
      <div className="format-group">
        {button({
          icon: "format",
          label: "Format",
          active: MARKS.some(([id]) => editor.isActive(id)),
          onClick: () => setOpen(open === "format" ? null : "format"),
          menu: true,
        })}
        {open === "format" ? <Menu items={items(MARKS)} onSelect={(id) => run(id as FormatId)} onClose={() => setOpen(null)} /> : null}
      </div>
      {button({ icon: "link", label: "Link (⌘L)", active: editor.isActive("link"), onClick: openLink })}
      {button({ icon: "code", label: "Code (⌘E)", active: editor.isActive("code"), onClick: () => run("code") })}
      <span className="format-divider" />
      {button({ icon: "codeBlock", label: "Code Block (⌥⌘C)", active: editor.isActive("codeBlock"), onClick: () => run("codeBlock") })}
      {button({ icon: "quote", label: "Blockquote (⇧⌘B)", active: editor.isActive("blockquote"), onClick: () => run("blockquote") })}
      <span className="format-divider" />
      <div className="format-group">
        {button({ icon: listIcon, label: "List", active: listKind !== null, onClick: () => setOpen(open === "list" ? null : "list"), menu: true })}
        {open === "list" ? <Menu items={items(LISTS)} onSelect={(id) => run(id as FormatId)} onClose={() => setOpen(null)} /> : null}
      </div>
    </div>
  );
}
