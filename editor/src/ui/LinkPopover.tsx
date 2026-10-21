/** The link popover in view and edit modes. */
import { normalizeLinkHref } from "@overnote/core";
import type { Editor } from "@tiptap/core";
import { useEffect, useRef, useState } from "react";
import type { LinkTarget } from "../editor/linkRange";
import { useDropdownPlacement } from "./hooks";
import { Icon } from "./icons";

interface LinkPopoverProps {
  editor: Editor;
  target: LinkTarget;
  onClose: () => void;
  notify: (message: string, kind?: "info" | "error") => void;
  openUrl: (href: string) => void;
  copy: (text: string) => Promise<unknown>;
}

export function LinkPopover({ editor, target, onClose, notify, openUrl, copy }: LinkPopoverProps) {
  const [mode, setMode] = useState(target.mode);
  const [value, setValue] = useState(target.href);
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // Above the link, centered on it, unless there is more room below.
  useDropdownPlacement(
    rootRef,
    () => {
      const start = editor.view.coordsAtPos(target.from);
      const end = editor.view.coordsAtPos(target.to);
      return { top: start.top, bottom: start.bottom, left: start.left, right: end.right };
    },
    { prefer: "above", gapRem: 0.45, align: "center" },
  );

  useEffect(() => {
    if (mode === "edit") {
      inputRef.current?.focus();
      inputRef.current?.select();
    } else {
      rootRef.current?.focus();
    }
  }, [mode]);

  const close = () => {
    onClose();
    editor.commands.focus();
  };

  const unlink = () => {
    editor
      .chain()
      .focus()
      .setTextSelection({ from: target.from, to: target.to })
      .unsetLink()
      .setTextSelection(target.to)
      .run();
    onClose();
  };

  const save = () => {
    if (!value.trim()) {
      unlink();
      return;
    }
    const href = normalizeLinkHref(value);
    if (!href) {
      notify("Invalid link. Enter a valid URL or deeplink.", "error");
      return;
    }
    editor
      .chain()
      .focus()
      .setTextSelection({ from: target.from, to: target.to })
      .unsetLink()
      .setLink({ href })
      .setTextSelection(target.to)
      .run();
    onClose();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === "Enter" && mode === "edit") {
      event.preventDefault();
      save();
    }
  };

  return (
    <div
      className="popover link-popover"
      data-testid="link-popover"
      data-mode={mode}
      ref={rootRef}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onMouseDown={(event) => event.stopPropagation()}
    >
      {mode === "view" ? (
        <div className="link-view">
          <button type="button" className="link-url" title={target.href} onClick={() => setMode("edit")}>
            {target.href}
          </button>
          <button type="button" className="icon-button" title="Edit" aria-label="Edit" onClick={() => setMode("edit")}>
            <Icon name="edit" />
          </button>
          <button
            type="button"
            className="icon-button"
            title="Copy"
            aria-label="Copy"
            onClick={() => {
              void copy(target.href).then(() => notify("Link copied to clipboard"));
              close();
            }}
          >
            <Icon name="copy" />
          </button>
          <button
            type="button"
            className="icon-button"
            title="Open Link"
            aria-label="Open Link"
            onClick={() => {
              openUrl(target.href);
              close();
            }}
          >
            <Icon name="open" />
          </button>
          <button type="button" className="icon-button" title="Unlink" aria-label="Unlink" onClick={unlink}>
            <Icon name="trash" />
          </button>
        </div>
      ) : (
        <div className="link-edit">
          <input
            ref={inputRef}
            value={value}
            placeholder="Enter a link…"
            aria-label="Link"
            spellCheck={false}
            onChange={(event) => setValue(event.target.value)}
          />
          <button type="button" className="icon-button" title="Save" aria-label="Save" onClick={save}>
            <Icon name="check" />
          </button>
          <button type="button" className="icon-button" title="Unlink" aria-label="Unlink" onClick={unlink}>
            <Icon name="trash" />
          </button>
        </div>
      )}
    </div>
  );
}
