/** The ⌘K action panel with pushed views: Format, Copy As, Export, Browse, Recently Deleted, Settings. */
import { displayTitle, type NoteId, type NoteSummary, type rpc, type Settings } from "@overnote/core";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Api } from "../bridge/api";
import { fuzzyScore } from "../editor/slash";
import { characterLabel, relativeTime } from "../lib/relativeTime";
import { Icon } from "./icons";
import { adjustSetting, filterSettings, SettingsList } from "./SettingsView";

export interface PanelAction {
  id: string;
  title: string;
  shortcut?: string;
  section: string;
  enabled?: boolean;
  destructive?: boolean;
  keywords?: string[];
  run?: () => void;
  push?: PanelViewName;
}

export type PanelViewName = "root" | "format" | "heading" | "copyAs" | "export" | "browse" | "deleted" | "settings";

interface CommandPanelProps {
  initial: PanelViewName;
  lists: Record<"root" | "format" | "heading" | "copyAs" | "export", PanelAction[]>;
  api: Api;
  currentId: NoteId | null;
  settings: Settings;
  onSettings: (patch: Partial<Settings>) => void;
  onClose: () => void;
  onOpenNote: (id: NoteId) => void;
  onTogglePin: (id: NoteId, pinned: boolean) => Promise<void>;
  onDeleteNote: (id: NoteId) => Promise<void>;
  onRecover: (id: NoteId) => Promise<void>;
  onPermanentlyDelete: (id: NoteId) => void;
  onPreview: (note: rpc.DeletedItem) => void;
}

const PLACEHOLDERS: Record<PanelViewName, string> = {
  root: "Search for actions…",
  format: "Format as…",
  heading: "Heading…",
  copyAs: "Copy as…",
  export: "Export as…",
  browse: "Search notes…",
  deleted: "Search deleted notes…",
  settings: "Search settings…",
};

function filterActions(actions: PanelAction[], query: string): PanelAction[] {
  const q = query.trim();
  if (!q) return actions;
  return actions
    .map((action) => ({ action, score: Math.max(...[action.title, ...(action.keywords ?? [])].map((text) => fuzzyScore(q, text))) }))
    .filter((entry) => entry.score >= Math.max(2, q.length * 1.5))
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.action);
}

export function CommandPanel(props: CommandPanelProps) {
  const [stack, setStack] = useState<PanelViewName[]>([props.initial]);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [browse, setBrowse] = useState<{ items: NoteSummary[]; cursor: string | null; loading: boolean }>({
    items: [],
    cursor: null,
    loading: false,
  });
  const [deleted, setDeleted] = useState<rpc.DeletedItem[]>([]);
  const [version, setVersion] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const view = stack[stack.length - 1] ?? "root";

  // Focus in the same commit that shows the panel, so keys typed right after ⌘K land in the search field.
  useLayoutEffect(() => inputRef.current?.focus(), [view]);

  const loadBrowse = useCallback(
    async (cursor: string | null, filter: string) => {
      setBrowse((state) => ({ ...state, loading: true }));
      try {
        const page = await props.api.notes.browse({ filter: filter.trim() || undefined, limit: 50, cursor: cursor ?? undefined });
        setBrowse((state) => ({
          items: cursor ? [...state.items, ...page.items] : page.items,
          cursor: page.nextCursor,
          loading: false,
        }));
        if (!cursor && !filter.trim()) {
          const current = page.items.findIndex((item) => item.id === props.currentId);
          setIndex(Math.max(0, current));
        }
      } catch {
        setBrowse((state) => ({ ...state, loading: false }));
      }
    },
    [props.api, props.currentId],
  );

  useEffect(() => {
    if (view === "browse") void loadBrowse(null, query);
    if (view === "deleted") void props.api.notes.listDeleted().then((result) => setDeleted(result.items), () => undefined);
  }, [view, query, version]);

  const actions = useMemo(() => {
    if (view === "browse" || view === "deleted" || view === "settings") return [];
    return filterActions(props.lists[view], query);
  }, [view, query, props.lists]);

  const deletedRows = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    return q ? deleted.filter((n) => `${n.title}\n${n.preview}`.toLocaleLowerCase().includes(q)) : deleted;
  }, [deleted, query]);

  const settingRows = useMemo(() => (view === "settings" ? filterSettings(query) : []), [view, query]);

  const rowCount =
    view === "browse" ? browse.items.length : view === "deleted" ? deletedRows.length : view === "settings" ? settingRows.length : actions.length;
  const selected = Math.min(index, Math.max(0, rowCount - 1));

  useEffect(() => {
    listRef.current?.querySelector(".is-selected")?.scrollIntoView({ block: "nearest" });
  }, [selected, view]);

  const push = (next: PanelViewName) => {
    setStack((s) => [...s, next]);
    setQuery("");
    setIndex(0);
  };
  const pop = () => {
    if (stack.length <= 1) {
      props.onClose();
      return;
    }
    setStack((s) => s.slice(0, -1));
    setQuery("");
    setIndex(0);
  };

  const runAction = (action: PanelAction | undefined) => {
    if (!action || action.enabled === false) return;
    if (action.push) {
      push(action.push);
      return;
    }
    props.onClose();
    action.run?.();
  };

  const selectedNote = view === "browse" ? browse.items[selected] : view === "deleted" ? deletedRows[selected] : undefined;

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown") setIndex(rowCount ? (selected + 1) % rowCount : 0);
    else if (event.key === "ArrowUp") setIndex(rowCount ? (selected - 1 + rowCount) % rowCount : 0);
    else if (view === "settings" && (event.key === "Enter" || event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      const row = settingRows[selected];
      const direction = event.key === "Enter" ? 0 : event.key === "ArrowLeft" ? -1 : 1;
      const patch = row ? adjustSetting(row, props.settings, direction) : null;
      // Arrows on a row they do not adjust keep moving the caret in the search field.
      if (!patch && direction !== 0) return;
      if (patch) props.onSettings(patch);
    } else if (event.key === "Enter") {
      if (view === "browse" && selectedNote) {
        props.onClose();
        props.onOpenNote(selectedNote.id);
      } else if (view === "deleted") {
        const note = deletedRows[selected];
        if (note) {
          props.onClose();
          props.onPreview(note);
        }
      } else runAction(actions[selected]);
    } else if (event.key === "Escape") {
      if (query) setQuery("");
      else pop();
    } else if (view === "browse" && selectedNote && event.metaKey && event.shiftKey && event.code === "KeyP") {
      void props.onTogglePin(selectedNote.id, selectedNote.pinned === null).then(() => setVersion((v) => v + 1));
    } else if (view === "browse" && selectedNote && event.ctrlKey && !event.shiftKey && event.code === "KeyX") {
      void props.onDeleteNote(selectedNote.id).then(() => setVersion((v) => v + 1));
    } else return;
    event.preventDefault();
    event.stopPropagation();
  };

  const onScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const el = event.currentTarget;
    if (view === "browse" && browse.cursor && !browse.loading && el.scrollTop + el.clientHeight >= el.scrollHeight - 24) {
      void loadBrowse(browse.cursor, query);
    }
  };

  let lastSection: string | null = null;
  const pinnedRows = browse.items.filter((n) => n.pinned !== null);

  return (
    <div className="panel-backdrop" onMouseDown={props.onClose}>
      <div className="popover panel" data-testid="command-panel" data-view={view} onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
        <input
          ref={inputRef}
          className="panel-search"
          value={query}
          placeholder={PLACEHOLDERS[view]}
          aria-label={PLACEHOLDERS[view]}
          spellCheck={false}
          onChange={(event) => {
            setQuery(event.target.value);
            setIndex(0);
          }}
        />
        <div className="panel-list" ref={listRef} onScroll={onScroll} role="listbox">
          {view === "browse"
            ? browse.items.map((note, i) => {
                const header = i === 0 && pinnedRows.length ? "Pinned" : i === pinnedRows.length ? "Notes" : null;
                const isCurrent = note.id === props.currentId;
                return (
                  <div key={note.id}>
                    {header ? <div className="menu-section">{header}</div> : null}
                    <div
                      role="option"
                      aria-selected={i === selected}
                      className={`panel-row${i === selected ? " is-selected" : ""}`}
                      data-testid="browse-row"
                      onMouseEnter={() => setIndex(i)}
                      onClick={() => {
                        props.onClose();
                        props.onOpenNote(note.id);
                      }}
                    >
                      <div className="panel-row-text">
                        <span className="panel-row-title">{displayTitle({ title: note.title, text: note.preview })}</span>
                        <span className="panel-row-subtitle">
                          {isCurrent ? (
                            <>
                              <span className="dot" /> Current · {characterLabel(note.charCount)}
                            </>
                          ) : (
                            `Opened ${relativeTime(note.lastAccessedAt ?? note.updatedAt)} · ${characterLabel(note.charCount)}`
                          )}
                        </span>
                      </div>
                      {i === selected ? (
                        <span className="panel-row-buttons">
                          <button
                            type="button"
                            className="icon-button"
                            title={note.pinned === null ? "Pin Note (⇧⌘P)" : "Unpin Note (⇧⌘P)"}
                            aria-label={note.pinned === null ? "Pin Note" : "Unpin Note"}
                            onClick={(event) => {
                              event.stopPropagation();
                              void props.onTogglePin(note.id, note.pinned === null).then(() => setVersion((v) => v + 1));
                            }}
                          >
                            <Icon name="pin" />
                          </button>
                          <button
                            type="button"
                            className="icon-button"
                            title="Delete Note (⌃X)"
                            aria-label="Delete Note"
                            onClick={(event) => {
                              event.stopPropagation();
                              void props.onDeleteNote(note.id).then(() => setVersion((v) => v + 1));
                            }}
                          >
                            <Icon name="trash" />
                          </button>
                        </span>
                      ) : null}
                    </div>
                  </div>
                );
              })
            : null}
          {view === "deleted" ? (
            <>
              {!query ? <div className="panel-banner">Notes in Recently Deleted will be permanently removed after 60 days.</div> : null}
              {deletedRows.map((note, i) => (
                <div
                  key={note.id}
                  role="option"
                  aria-selected={i === selected}
                  className={`panel-row${i === selected ? " is-selected" : ""}`}
                  data-testid="deleted-row"
                  onMouseEnter={() => setIndex(i)}
                  onClick={() => {
                    props.onClose();
                    props.onPreview(note);
                  }}
                >
                  <div className="panel-row-text">
                    <span className="panel-row-title">{displayTitle({ title: note.title, text: note.preview })}</span>
                    <span className="panel-row-subtitle">{`Deleted ${relativeTime(note.deletedAt ?? note.updatedAt)} · ${characterLabel(note.charCount)}`}</span>
                  </div>
                  {i === selected ? (
                    <span className="panel-row-buttons">
                      <button
                        type="button"
                        className="icon-button"
                        title="Restore"
                        aria-label="Restore"
                        onClick={(event) => {
                          event.stopPropagation();
                          void props.onRecover(note.id).then(() => setVersion((v) => v + 1));
                        }}
                      >
                        <Icon name="restore" />
                      </button>
                      <button
                        type="button"
                        className="icon-button"
                        title="Delete Permanently"
                        aria-label="Delete Permanently"
                        onClick={(event) => {
                          event.stopPropagation();
                          props.onPermanentlyDelete(note.id);
                          setTimeout(() => setVersion((v) => v + 1), 300);
                        }}
                      >
                        <Icon name="trash" />
                      </button>
                    </span>
                  ) : null}
                </div>
              ))}
            </>
          ) : null}
          {view === "settings" ? (
            <SettingsList
              rows={settingRows}
              settings={props.settings}
              selected={selected}
              grouped={!query.trim()}
              onHover={setIndex}
              onChange={props.onSettings}
            />
          ) : null}
          {view !== "browse" && view !== "deleted" && view !== "settings"
            ? actions.map((action, i) => {
                const divider = !query && lastSection !== null && action.section !== lastSection;
                lastSection = action.section;
                return (
                  <div key={action.id}>
                    {divider ? <div className="menu-divider" /> : null}
                    <button
                      type="button"
                      role="option"
                      aria-selected={i === selected}
                      aria-disabled={action.enabled === false}
                      className={`panel-row${i === selected ? " is-selected" : ""}${action.destructive ? " is-destructive" : ""}${action.enabled === false ? " is-disabled" : ""}`}
                      data-testid={`action-${action.id}`}
                      onMouseEnter={() => setIndex(i)}
                      onClick={() => runAction(action)}
                      tabIndex={-1}
                    >
                      <span className="panel-row-title">{action.title}</span>
                      {action.push ? <Icon name="chevron" /> : action.shortcut ? <kbd>{action.shortcut}</kbd> : null}
                    </button>
                  </div>
                );
              })
            : null}
        </div>
      </div>
    </div>
  );
}
