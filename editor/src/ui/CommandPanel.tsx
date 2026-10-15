/** The ⌘K action panel with pushed views: Format, Copy As, Export, Browse, Recently Deleted, Settings. */
import { displayTitle, type NoteId, type NoteSummary, type rpc, type Settings } from "@overnote/core";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Api } from "../bridge/api";
import { fuzzyScore } from "../editor/slash";
import { revealSelected } from "../lib/motion";
import { characterLabel, relativeTime } from "../lib/relativeTime";
import { Icon, type IconName } from "./icons";
import { adjustSetting, filterSettings, SettingsList } from "./SettingsView";
import { Keys } from "./Keys";

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

type LoadStatus = "loading" | "loaded" | "error";

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
  /** Settles once the note is deleted or the confirmation is cancelled. */
  onPermanentlyDelete: (id: NoteId) => Promise<void>;
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
    .map((action) => ({
      action,
      score: Math.max(...[action.title, ...(action.keywords ?? [])].map((text) => fuzzyScore(q, text))),
    }))
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
  // Empty states wait for the first answer, so an empty list never flashes before the rows arrive.
  const [deleted, setDeleted] = useState<{ items: rpc.DeletedItem[]; status: LoadStatus }>({
    items: [],
    status: "loading",
  });
  const [browseLoaded, setBrowseLoaded] = useState(false);
  const [version, setVersion] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const view = stack[stack.length - 1] ?? "root";
  const { api, currentId } = props;

  // Focus in the same commit that shows the panel, so keys typed right after ⌘K land in the search field.
  useLayoutEffect(() => inputRef.current?.focus(), [view]);

  // The first page for the current search. Answers apply in request order: one that arrives after a
  // newer answer is dropped, but every search typed so far still narrows the list as soon as it answers.
  const requested = useRef(0);
  const applied = useRef(0);
  useEffect(() => {
    if (view !== "browse") return;
    const request = ++requested.current;
    const filter = query.trim();
    api.notes.browse({ filter: filter || undefined, limit: 50 }).then(
      (page) => {
        if (request < applied.current) return;
        applied.current = request;
        setBrowse({ items: page.items, cursor: page.nextCursor, loading: false });
        setBrowseLoaded(true);
        if (!filter)
          setIndex(
            Math.max(
              0,
              page.items.findIndex((item) => item.id === currentId),
            ),
          );
      },
      () => setBrowseLoaded(true),
    );
  }, [api, currentId, view, query, version]);

  const loadMore = (cursor: string) => {
    setBrowse((state) => ({ ...state, loading: true }));
    api.notes.browse({ filter: query.trim() || undefined, limit: 50, cursor }).then(
      (page) =>
        setBrowse((state) =>
          state.cursor === cursor
            ? { items: [...state.items, ...page.items], cursor: page.nextCursor, loading: false }
            : state,
        ),
      () => setBrowse((state) => ({ ...state, loading: false })),
    );
  };

  // Searching deleted notes filters the loaded list locally; only the view and refreshes refetch.
  useEffect(() => {
    if (view !== "deleted") return;
    let stale = false;
    api.notes.listDeleted().then(
      (result) => {
        if (!stale) setDeleted({ items: result.items, status: "loaded" });
      },
      () => {
        if (!stale) setDeleted((state) => ({ ...state, status: "error" }));
      },
    );
    return () => {
      stale = true;
    };
  }, [api, view, version]);

  const retryDeleted = () => {
    setDeleted((state) => ({ ...state, status: "loading" }));
    setVersion((v) => v + 1);
  };

  const actions = useMemo(() => {
    if (view === "browse" || view === "deleted" || view === "settings") return [];
    return filterActions(props.lists[view], query);
  }, [view, query, props.lists]);

  const deletedRows = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    if (deleted.status === "error") return [];
    return q ? deleted.items.filter((n) => `${n.title}\n${n.preview}`.toLocaleLowerCase().includes(q)) : deleted.items;
  }, [deleted, query]);

  const settingRows = useMemo(() => (view === "settings" ? filterSettings(query) : []), [view, query]);

  const rowCount =
    view === "browse"
      ? browse.items.length
      : view === "deleted"
        ? deletedRows.length
        : view === "settings"
          ? settingRows.length
          : actions.length;
  const selected = Math.min(index, Math.max(0, rowCount - 1));

  // The selection glides into view on keyboard steps; a new view lands on it at once.
  const revealedView = useRef<PanelViewName | null>(null);
  useEffect(() => {
    revealSelected(listRef.current, revealedView.current === view);
    revealedView.current = view;
  }, [selected, view, rowCount]);

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

  const selectedNote =
    view === "browse" ? browse.items[selected] : view === "deleted" ? deletedRows[selected] : undefined;

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown") setIndex(rowCount ? (selected + 1) % rowCount : 0);
    else if (event.key === "ArrowUp") setIndex(rowCount ? (selected - 1 + rowCount) % rowCount : 0);
    else if (
      view === "settings" &&
      (event.key === "Enter" || event.key === "ArrowLeft" || event.key === "ArrowRight")
    ) {
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
        if (deleted.status === "error") retryDeleted();
        else if (note) {
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
    if (
      view === "browse" &&
      browse.cursor &&
      !browse.loading &&
      el.scrollTop + el.clientHeight >= el.scrollHeight - 24
    ) {
      loadMore(browse.cursor);
    }
  };

  const pinnedRows = browse.items.filter((n) => n.pinned !== null);

  return (
    <div className="panel-backdrop" onMouseDown={props.onClose}>
      <div
        className="popover panel"
        data-testid="command-panel"
        data-view={view}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
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
        <div className="panel-list" key={view} ref={listRef} onScroll={onScroll} role="listbox">
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
                        <span className="panel-row-title">
                          {displayTitle({ title: note.title, text: note.preview })}
                        </span>
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
                              void props
                                .onTogglePin(note.id, note.pinned === null)
                                .then(() => setVersion((v) => v + 1));
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
          {view === "browse" && !browse.items.length && browseLoaded ? (
            <EmptyState
              icon="search"
              title="No Matching Notes"
              hint={query.trim() ? "Try a different search." : "Notes you write show up here."}
            />
          ) : null}
          {view === "deleted" ? (
            <>
              {!query && deletedRows.length ? (
                <div className="panel-banner">Notes in Recently Deleted will be permanently removed after 60 days.</div>
              ) : null}
              {deleted.status === "error" ? (
                <EmptyState
                  icon="trash"
                  title="Could Not Load Deleted Notes"
                  hint="Something went wrong while reading Recently Deleted."
                  error
                  action={{ title: "Try Again", run: retryDeleted }}
                />
              ) : null}
              {!deletedRows.length && deleted.status === "loaded" ? (
                query ? (
                  <EmptyState icon="search" title="No Matching Deleted Notes" hint="Try a different search." />
                ) : (
                  <EmptyState
                    icon="trash"
                    title="No Recently Deleted Notes"
                    hint="Deleted notes stay here for 60 days before they are removed."
                  />
                )
              ) : null}
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
                          void props.onPermanentlyDelete(note.id).then(() => setVersion((v) => v + 1));
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
          {view !== "browse" && view !== "deleted" && view !== "settings" && !actions.length ? (
            <EmptyState icon="search" title="No Matching Actions" />
          ) : null}
          {view === "settings" && !settingRows.length ? (
            <EmptyState icon="search" title="No Matching Settings" />
          ) : null}
          {view !== "browse" && view !== "deleted" && view !== "settings"
            ? actions.map((action, i) => {
                const previous = actions[i - 1];
                const divider = !query && previous !== undefined && action.section !== previous.section;
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
                      {action.push ? (
                        <Icon name="chevron" />
                      ) : action.shortcut ? (
                        <Keys shortcut={action.shortcut} />
                      ) : null}
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

interface EmptyStateProps {
  icon: IconName;
  title: string;
  hint?: string;
  /** A failed load: announced as an alert. */
  error?: boolean;
  action?: { title: string; run: () => void };
}

function EmptyState({ icon, title, hint, error, action }: EmptyStateProps) {
  return (
    <div
      className={`panel-empty${error ? " is-error" : ""}`}
      data-testid={error ? "panel-error" : "panel-empty"}
      role={error ? "alert" : "status"}
    >
      <Icon name={icon} />
      <span className="panel-empty-title">{title}</span>
      {hint ? <span className="panel-empty-hint">{hint}</span> : null}
      {action ? (
        <button
          type="button"
          className="text-button is-primary panel-empty-action"
          tabIndex={-1}
          onMouseDown={(event) => event.preventDefault()}
          onClick={action.run}
        >
          {action.title}
        </button>
      ) : null}
    </div>
  );
}
