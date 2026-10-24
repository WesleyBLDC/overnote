/** Find and replace bar. */
import type { Editor } from "@tiptap/core";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { findKey, findMatches, replaceAll, replaceOne, selectMatch } from "../editor/find";
import { Icon } from "./icons";

export interface FindBarHandle {
  /** ⌘F while the bar is open. Returns false when the bar should close instead. */
  focusOrClose(selection: string): boolean;
}

interface FindBarProps {
  editor: Editor;
  initialTerm: string;
  onClose: () => void;
}

export const FindBar = forwardRef<FindBarHandle, FindBarProps>(function FindBar({ editor, initialTerm, onClose }, ref) {
  const [term, setTerm] = useState(initialTerm);
  const [replacement, setReplacement] = useState("");
  const [showReplace, setShowReplace] = useState(false);
  const [active, setActive] = useState(0);
  const [doc, setDoc] = useState(editor.state.doc);
  const findRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const track = () => setDoc(editor.state.doc);
    editor.on("update", track);
    return () => {
      editor.off("update", track);
    };
  }, [editor]);

  const matches = useMemo(() => findMatches(doc, term), [doc, term]);
  const index = matches.length ? Math.min(active, matches.length - 1) : -1;

  useEffect(() => {
    editor.view.dispatch(editor.state.tr.setMeta(findKey, { term, active: index }).setMeta("addToHistory", false));
  }, [editor, term, index, matches.length]);

  useEffect(() => {
    findRef.current?.focus();
    findRef.current?.select();
    return () => {
      editor.view.dispatch(editor.state.tr.setMeta(findKey, { term: "", active: -1 }).setMeta("addToHistory", false));
    };
  }, [editor]);

  const goTo = useCallback(
    (next: number) => {
      if (!matches.length) return;
      const wrapped = (next + matches.length) % matches.length;
      setActive(wrapped);
      const match = matches[wrapped];
      if (match) editor.view.dispatch(selectMatch(editor.state, match));
    },
    [editor, matches],
  );

  useImperativeHandle(ref, () => ({
    focusOrClose(selection: string) {
      if (document.activeElement === findRef.current) return false;
      if (selection) setTerm(selection);
      findRef.current?.focus();
      findRef.current?.select();
      return true;
    },
  }));

  const close = () => {
    onClose();
    editor.commands.focus();
  };

  const replaceCurrent = () => {
    if (!matches.length) return;
    const { from } = editor.state.selection;
    const target = matches.find((match) => match.from >= from) ?? matches[0];
    if (!target) return;
    editor.view.dispatch(replaceOne(editor.state, target, replacement));
    const remaining = findMatches(editor.state.doc, term);
    const next = remaining.findIndex((match) => match.from >= target.from + replacement.length);
    const chosen = next === -1 ? 0 : next;
    setActive(chosen);
    const match = remaining[chosen];
    if (match) editor.view.dispatch(selectMatch(editor.state, match));
  };

  const replaceEverything = () => {
    const tr = replaceAll(editor.state, term, replacement);
    if (!tr) return;
    editor.view.dispatch(tr);
    setActive(0);
    const first = findMatches(editor.state.doc, term)[0];
    if (first) editor.view.dispatch(selectMatch(editor.state, first));
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  };

  return (
    <div className="find-bar" data-testid="find-bar" onKeyDown={onKeyDown}>
      <div className="find-row">
        <button
          type="button"
          className={`icon-button chevron${showReplace ? " is-open" : ""}`}
          aria-label="Show replace"
          onClick={() => setShowReplace((v) => !v)}
          tabIndex={-1}
        >
          <Icon name="chevron" />
        </button>
        <input
          ref={findRef}
          value={term}
          placeholder="Find"
          aria-label="Find"
          spellCheck={false}
          data-testid="find-input"
          onChange={(event) => {
            setTerm(event.target.value);
            setActive(0);
            const first = findMatches(editor.state.doc, event.target.value)[0];
            if (first) editor.view.dispatch(selectMatch(editor.state, first));
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              goTo(index + (event.shiftKey ? -1 : 1));
            } else if (event.key === "ArrowDown" && event.altKey && event.metaKey) {
              event.preventDefault();
              setShowReplace(true);
            }
          }}
        />
        <span className="find-count" data-testid="find-count" role="status">
          {!term ? "" : matches.length ? `${index + 1} of ${matches.length}` : "No results"}
        </span>
        <button
          type="button"
          className="icon-button"
          aria-label="Previous match"
          onClick={() => goTo(index - 1)}
          disabled={!matches.length}
          tabIndex={-1}
        >
          <Icon name="up" />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="Next match"
          onClick={() => goTo(index + 1)}
          disabled={!matches.length}
          tabIndex={-1}
        >
          <Icon name="down" />
        </button>
        <button type="button" className="icon-button" aria-label="Close find" onClick={close} tabIndex={-1}>
          <Icon name="close" />
        </button>
      </div>
      {showReplace ? (
        <div className="find-row">
          <span className="chevron-spacer" />
          <input
            value={replacement}
            placeholder="Replace"
            aria-label="Replace"
            spellCheck={false}
            data-testid="replace-input"
            onChange={(event) => setReplacement(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                replaceCurrent();
              }
            }}
          />
          <button type="button" className="text-button" onClick={replaceCurrent} disabled={!matches.length}>
            Replace
          </button>
          <button
            type="button"
            className="text-button"
            onClick={replaceEverything}
            disabled={!matches.length}
            data-testid="replace-all"
          >
            Replace All
          </button>
        </div>
      ) : null}
    </div>
  );
});
