/** Find and replace bar. */
import type { Editor } from "@tiptap/core";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { focusEditorNow } from "../editor/commands";
import { findKey, findState, replaceAll, replaceOne, selectMatch, findTransaction } from "../editor/find";
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
  // The input's text is local; the term, matches, and active match live in the editor state (find.ts), so a reload,
  // an undo, or an outside change can never leave them out of step with the document.
  const [term, setTerm] = useState(initialTerm);
  const [replacement, setReplacement] = useState("");
  const [showReplace, setShowReplace] = useState(false);
  const findRef = useRef<HTMLInputElement>(null);
  const { matches, active: index } = findState(editor.state);

  /** Applies the term (from the first match) and selects the active match. */
  const search = useCallback(
    (next: string) => {
      setTerm(next);
      editor.view.dispatch(findTransaction(editor.state, { term: next, active: 0 }));
      const first = findState(editor.state).matches[0];
      if (first) editor.view.dispatch(selectMatch(editor.state, first));
    },
    [editor],
  );

  // Mount and unmount: the opening term applies once; later terms go through search().
  const opening = useRef(initialTerm);
  useEffect(() => {
    editor.view.dispatch(findTransaction(editor.state, { term: opening.current, active: 0 }));
    findRef.current?.focus();
    findRef.current?.select();
    return () => editor.view.dispatch(findTransaction(editor.state, { term: "" }));
  }, [editor]);

  const goTo = useCallback(
    (next: number) => {
      if (!matches.length) return;
      const wrapped = (next + matches.length) % matches.length;
      const match = matches[wrapped];
      if (match) editor.view.dispatch(selectMatch(editor.state, match).setMeta(findKey, { active: wrapped }));
    },
    [editor, matches],
  );

  useImperativeHandle(ref, () => ({
    focusOrClose(selection: string) {
      if (document.activeElement === findRef.current) return false;
      if (selection) search(selection);
      findRef.current?.focus();
      findRef.current?.select();
      return true;
    },
  }));

  const close = () => {
    onClose();
    focusEditorNow(editor);
  };

  /** After a replace, the next match at or after `from` becomes active, wrapping to the first. */
  const selectFrom = (from: number) => {
    const remaining = findState(editor.state).matches;
    const next = remaining.findIndex((match) => match.from >= from);
    const chosen = next === -1 ? 0 : next;
    const match = remaining[chosen];
    if (match) editor.view.dispatch(selectMatch(editor.state, match).setMeta(findKey, { active: chosen }));
  };

  const replaceCurrent = () => {
    const target = matches[index];
    if (!target) return;
    editor.view.dispatch(replaceOne(editor.state, target, replacement));
    selectFrom(target.from + replacement.length);
  };

  const replaceEverything = () => {
    const tr = replaceAll(editor.state, term, replacement);
    if (!tr) return;
    editor.view.dispatch(tr);
    selectFrom(0);
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
        <span className="find-icon" aria-hidden="true">
          <Icon name="search" />
        </span>
        <input
          ref={findRef}
          value={term}
          placeholder="Find"
          aria-label="Find"
          spellCheck={false}
          data-testid="find-input"
          onChange={(event) => search(event.target.value)}
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
          className="icon-button find-step"
          aria-label="Previous match"
          onClick={() => goTo(index - 1)}
          disabled={!matches.length}
          tabIndex={-1}
        >
          <Icon name="up" />
        </button>
        <button
          type="button"
          className="icon-button find-step"
          aria-label="Next match"
          onClick={() => goTo(index + 1)}
          disabled={!matches.length}
          tabIndex={-1}
        >
          <Icon name="down" />
        </button>
        <span className="find-divider" aria-hidden="true" />
        <button
          type="button"
          className={`text-button find-toggle${showReplace ? " is-active" : ""}`}
          aria-label="Show replace"
          aria-pressed={showReplace}
          onClick={() => setShowReplace((v) => !v)}
          tabIndex={-1}
        >
          Replace
        </button>
        <button type="button" className="icon-button find-step" aria-label="Close find" onClick={close} tabIndex={-1}>
          <Icon name="close" />
        </button>
      </div>
      {showReplace ? (
        <div className="find-row">
          <span className="find-icon" aria-hidden="true" />
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
