/**
 * Search (board 07, SPEC §7): one box over the note for notes (⌘P) and all actions (⌘K or ">"), plus the pushed
 * list views (Format, Heading, Copy As, Export, Recently Deleted, Settings) in the same shell.
 */
import {
  countWords,
  displayTitle,
  type BrowseItem,
  type Note,
  type NoteId,
  rpc,
  type SearchSort,
  type Settings,
} from "@overnote/core";
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import type { Api } from "../bridge/api";
import { fuzzyScore } from "../editor/slash";
import { revealSelected } from "../lib/motion";
import { wordLabel } from "../lib/count";
import { relativeTime } from "../lib/relativeTime";
import { allActionsMenu, leafActions, type MenuEntry } from "../search/menu";
import { Highlight, snippetAround } from "../search/Highlight";
import {
  directionLabel,
  isNaturalOrder,
  restHeader,
  rowMeta,
  shortDate,
  SORT_FIELDS,
  sortLabel,
  withDirectionFlipped,
  withField,
} from "../search/sort";
import { currentView, initialSearch, searchReducer } from "../search/state";
import { useNoteBrowse } from "../search/useNoteBrowse";
import { useOrderedQuery } from "../search/useOrderedQuery";
import { Icon, type IconName } from "./icons";
import { adjustSetting, filterSettings, SettingsList } from "./SettingsView";
import { Keys } from "./Keys";
import { Menu, type MenuItem } from "./Menu";

export interface PanelAction {
  id: string;
  title: string;
  shortcut?: string;
  section: string;
  enabled?: boolean;
  destructive?: boolean;
  keywords?: string[];
  /** Drawn before the title. */
  icon?: IconName;
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
  onResetSettings: () => void;
  onClose: () => void;
  onOpenNote: (id: NoteId) => void;
  onTogglePin: (id: NoteId, pinned: boolean) => Promise<void>;
  onDeleteNote: (id: NoteId) => Promise<void>;
  onRecover: (id: NoteId) => Promise<void>;
  /** Settles once the note is deleted or the confirmation is cancelled. */
  onPermanentlyDelete: (id: NoteId) => Promise<void>;
  onPreview: (note: rpc.DeletedItem) => void;
  /** Search's "New note ‘query’": a new note that starts with the query. */
  onCreateNote: (title: string) => void;
}

/** The key actions row (SPEC §7): five fixed chips, by action id, with their short names. */
const KEY_ACTIONS: { id: string; label: string; icon: IconName }[] = [
  { id: "new", label: "New", icon: "edit" },
  { id: "pin", label: "Pin", icon: "pin" },
  { id: "deeplink", label: "Copy link", icon: "link" },
  { id: "terminal", label: "Terminal", icon: "terminal" },
  { id: "settings", label: "Settings", icon: "sliders" },
];

/** Matching actions shown under the notes while typing. */
const MATCHING_ACTIONS = 4;

/** One row of the left-hand list. */
type Row =
  | { kind: "note"; note: BrowseItem }
  | { kind: "action"; action: PanelAction; divider?: boolean }
  | { kind: "submenu"; entry: Extract<MenuEntry, { kind: "submenu" }> }
  | { kind: "create" };

const PLACEHOLDERS: Record<PanelViewName, string> = {
  root: "Search actions",
  format: "Format as…",
  heading: "Heading…",
  copyAs: "Copy as…",
  export: "Export as…",
  browse: "Search notes or type > for actions",
  deleted: "Search",
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
  const [state, dispatch] = useReducer(searchReducer, props.initial, initialSearch);
  const { query } = state;
  const view = currentView(state);
  const { api, currentId } = props;
  const split = view === "browse" || view === "root" || view === "deleted";
  const inSubmenu = state.submenu.open;
  const [version, setVersion] = useState(0);
  const refresh = () => setVersion((v) => v + 1);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Effects leave through props: the reducer only records that Search closed, or that a note should open.
  const callbacks = useRef(props);
  useLayoutEffect(() => {
    callbacks.current = props;
  });
  useEffect(() => {
    if (state.closed) callbacks.current.onClose();
  }, [state.closed]);

  // Focus in the same commit that shows the panel, so keys typed right after ⌘K land in the search field.
  useLayoutEffect(() => inputRef.current?.focus(), [view]);

  const filter = query.trim();
  const pendingOpen = useRef(state.openFirstWhenLoaded);
  useLayoutEffect(() => {
    pendingOpen.current = state.openFirstWhenLoaded;
  });
  const sort = props.settings.searchSort;
  const notes = useNoteBrowse(
    api,
    view === "browse" ? JSON.stringify([filter, sort, version, currentId]) : null,
    filter,
    sort,
    (result, latest) => {
      // Only the newest search may act: open its first note for an Enter pressed early, or land on the current note.
      if (!latest) return;
      const items = result.ok ? result.value.items : [];
      if (pendingOpen.current && items[0]) {
        callbacks.current.onClose();
        callbacks.current.onOpenNote(items[0].id);
      }
      const current = items.findIndex((item) => item.id === currentId);
      dispatch({ type: "answered", landOn: result.ok && !filter ? Math.max(0, current) : null });
    },
  );
  const browse = { items: notes.items, cursor: notes.cursor };
  const browseStatus = notes.status;
  const retryBrowse = notes.retry;

  // The sort pill's menu: the fields, then the direction and pins toggles. Picking a field closes it.
  const [sortAnchor, setSortAnchor] = useState<HTMLElement | null>(null);
  const closeSortMenu = useCallback(() => {
    setSortAnchor(null);
    inputRef.current?.focus();
  }, []);
  const sortItems: MenuItem[] = [
    ...SORT_FIELDS.map(({ field, label }) => ({ id: field, title: label, checked: sort.field === field })),
    { id: "direction", title: directionLabel(sort.field), checked: isNaturalOrder(sort), divider: true },
    { id: "pinnedFirst", title: "Pinned on top", checked: sort.pinnedFirst },
  ];
  const chooseSort = (id: string) => {
    let next: SearchSort;
    if (id === "direction") next = withDirectionFlipped(sort);
    else if (id === "pinnedFirst") next = { ...sort, pinnedFirst: !sort.pinnedFirst };
    else {
      const field = SORT_FIELDS.find((f) => f.field === id)?.field;
      if (!field) return;
      next = withField(sort, field);
      closeSortMenu();
    }
    props.onSettings({ searchSort: next });
  };

  // Searching deleted notes filters the loaded list locally; only the view and refreshes refetch.
  const deletedQuery = useOrderedQuery(view === "deleted" ? `deleted#${version}` : null, () => api.notes.listDeleted());
  const deleted = { items: deletedQuery.value?.items ?? [], status: deletedQuery.status };
  const retryDeleted = deletedQuery.retry;

  const leaves = useMemo(() => leafActions(props.lists), [props.lists]);
  const byId = useMemo(() => new Map(leaves.map((a) => [a.id, a])), [leaves]);

  // The left-hand rows of the search views and the pushed action lists.
  const rows = useMemo((): Row[] => {
    if (view === "browse") {
      const found: Row[] = notes.items.map((note) => ({ kind: "note", note }));
      if (!filter) return found;
      const actions: Row[] = filterActions(leaves, filter)
        .slice(0, MATCHING_ACTIONS)
        .map((action) => ({ kind: "action", action }));
      return [...found, ...actions, { kind: "create" }];
    }
    if (view === "root") {
      if (filter) return filterActions(leaves, filter).map((action) => ({ kind: "action", action }));
      return allActionsMenu(props.lists).map((entry): Row =>
        entry.kind === "action"
          ? { kind: "action", action: entry.action, divider: entry.divider }
          : { kind: "submenu", entry },
      );
    }
    if (view === "deleted" || view === "settings") return [];
    return filterActions(props.lists[view], filter).map((action) => ({ kind: "action", action }));
  }, [view, filter, notes.items, leaves, props.lists]);

  const deletedRows = useMemo(() => {
    const q = filter.toLocaleLowerCase();
    if (deleted.status === "error") return [];
    return q ? deleted.items.filter((n) => `${n.title}\n${n.preview}`.toLocaleLowerCase().includes(q)) : deleted.items;
  }, [deleted.items, deleted.status, filter]);

  const settingRows = useMemo(() => (view === "settings" ? filterSettings(query) : []), [view, query]);

  const rowCount = view === "deleted" ? deletedRows.length : view === "settings" ? settingRows.length : rows.length;
  const selected = Math.min(state.index, Math.max(0, rowCount - 1));
  const selectedRow = view === "deleted" || view === "settings" ? undefined : rows[selected];
  const submenu = selectedRow?.kind === "submenu" ? selectedRow.entry : null;
  const subSelected = submenu ? Math.min(state.submenu.index, Math.max(0, submenu.children.length - 1)) : 0;
  const setIndex = (index: number) => dispatch({ type: "select", index });

  // The highlighted note's full text for the preview, fetched once per note while the panel is open.
  const previewNote = selectedRow?.kind === "note" ? selectedRow.note : null;
  const [fullNotes, setFullNotes] = useState<Map<NoteId, Note>>(() => new Map());
  useEffect(() => {
    if (!previewNote || fullNotes.has(previewNote.id)) return;
    let stale = false;
    api.notes.get(previewNote.id).then(
      (note) => {
        if (!stale) setFullNotes((map) => new Map(map).set(note.id, note));
      },
      () => undefined,
    );
    return () => {
      stale = true;
    };
  }, [api, previewNote, fullNotes]);

  // The selection glides into view on keyboard steps; a new view lands on it at once.
  const revealedView = useRef<PanelViewName | null>(null);
  useEffect(() => {
    revealSelected(listRef.current, revealedView.current === view);
    revealedView.current = view;
  }, [selected, view, rowCount]);

  // Roving focus: once Tab has moved focus onto a row, the arrows carry it with the selection.
  useEffect(() => {
    const list = listRef.current;
    const active = document.activeElement;
    if (!list || !(active instanceof HTMLElement) || !list.contains(active)) return;
    const row = list.querySelector<HTMLElement>('[role="option"][tabindex="0"]');
    if (row && row !== active && !row.contains(active)) row.focus({ preventScroll: true });
  }, [selected, view]);

  const swap = (next: "browse" | "root") => dispatch({ type: "swap", view: next });

  const runAction = (action: PanelAction | undefined) => {
    if (!action || action.enabled === false) return;
    if (action.push) {
      dispatch({ type: "push", view: action.push });
      return;
    }
    props.onClose();
    action.run?.();
  };
  const openNote = (id: NoteId) => {
    props.onClose();
    props.onOpenNote(id);
  };
  const createNote = () => {
    props.onClose();
    props.onCreateNote(filter);
  };
  const activate = (row: Row | undefined) => {
    if (!row) return;
    if (row.kind === "note") openNote(row.note.id);
    else if (row.kind === "action") runAction(row.action);
    else if (row.kind === "create") createNote();
    else dispatch({ type: "enterSubmenu" });
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    const step = (delta: number) =>
      inSubmenu && submenu
        ? dispatch({ type: "moveInSubmenu", delta, count: submenu.children.length })
        : dispatch({ type: "move", delta, count: rowCount });
    if (event.key === "ArrowDown") step(1);
    else if (event.key === "ArrowUp") step(-1);
    else if (
      view === "settings" &&
      (event.key === "Enter" || event.key === "ArrowLeft" || event.key === "ArrowRight")
    ) {
      const row = settingRows[selected];
      const direction = event.key === "Enter" ? 0 : event.key === "ArrowLeft" ? -1 : 1;
      if (row?.kind === "action") {
        if (direction === 0) props.onResetSettings();
        return;
      }
      const patch = row ? adjustSetting(row, props.settings, direction) : null;
      // Arrows on a row they do not adjust keep moving the caret in the search field.
      if (!patch && direction !== 0) return;
      if (patch) props.onSettings(patch);
    } else if (event.key === "ArrowRight" && submenu && !inSubmenu) dispatch({ type: "enterSubmenu" });
    else if (event.key === "ArrowLeft" && inSubmenu) dispatch({ type: "leaveSubmenu" });
    else if (event.key === "Enter" && event.metaKey && view === "browse") {
      if (filter) createNote();
      else runAction(byId.get("new"));
    } else if (event.key === "Enter") {
      if (inSubmenu && submenu) runAction(submenu.children[subSelected]);
      else if (view === "browse" && browseStatus === "error" && !browse.items.length) retryBrowse();
      // The list still shows an older search; act on the answer for what was typed.
      else if (view === "browse" && notes.pending()) dispatch({ type: "openFirstWhenLoaded" });
      else if (view === "deleted") {
        // ↩ restores the highlighted note and opens it (board 11); a click shows it read only first.
        const note = deletedRows[selected];
        if (deleted.status === "error") retryDeleted();
        else if (note)
          void props.onRecover(note.id).then(() => {
            props.onClose();
            props.onOpenNote(note.id);
          });
      } else activate(selectedRow);
    } else if (event.key === "Escape") dispatch({ type: "escape" });
    else if (event.key === "Backspace" && view === "root" && !query && !event.metaKey) swap("browse");
    else if (view === "browse" && event.key === ">" && !query) swap("root");
    else if (view === "deleted" && deletedRows[selected] && event.metaKey && event.key === "Backspace") {
      void props.onPermanentlyDelete(deletedRows[selected].id).then(refresh);
    } else if (
      view === "browse" &&
      previewNote &&
      ((event.metaKey && event.key === "Backspace") || (event.ctrlKey && !event.shiftKey && event.code === "KeyX"))
    ) {
      void props.onDeleteNote(previewNote.id).then(refresh);
    } else if (view === "browse" && previewNote && event.metaKey && event.shiftKey && event.code === "KeyP") {
      void props.onTogglePin(previewNote.id, previewNote.pinned === null).then(refresh);
    } else return;
    event.preventDefault();
    event.stopPropagation();
  };

  const onScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const el = event.currentTarget;
    if (view === "browse" && el.scrollTop + el.clientHeight >= el.scrollHeight - 24) notes.loadMore();
  };

  const q = query.trim();
  // Pinned notes lead the list only while the sort keeps them on top.
  const pinnedCount = sort.pinnedFirst ? browse.items.filter((n) => n.pinned !== null).length : 0;
  const noteHeader = (i: number) => {
    if (q) return i === 0 ? "Notes" : null;
    if (i === 0 && pinnedCount) return "Pinned";
    return i === pinnedCount ? restHeader(sort.field) : null;
  };

  const renderRow = (row: Row, i: number) => {
    const isSelected = i === selected && !inSubmenu;
    const common = {
      role: "option" as const,
      "aria-selected": i === selected,
      tabIndex: i === selected ? 0 : -1,
      onMouseDown: keepFocus,
      onMouseEnter: () => setIndex(i),
    };
    if (row.kind === "note") {
      const { note } = row;
      const title = displayTitle({ title: note.title, text: note.preview });
      // A match in the body shows the passage around it; otherwise the meta line follows the sort.
      const bodyMatch = q && !title.toLocaleLowerCase().includes(q.toLocaleLowerCase());
      const header = noteHeader(i);
      return (
        <div key={note.id}>
          {header ? <div className="menu-section">{header}</div> : null}
          <div
            {...common}
            className={`panel-row${isSelected ? " is-selected" : ""}`}
            data-testid="browse-row"
            onClick={() => openNote(note.id)}
          >
            <Icon name="browse" />
            <div className="panel-row-text">
              <span className="panel-row-title">
                <Highlight text={title} query={q} />
              </span>
              <span className="panel-row-subtitle">
                {bodyMatch ? (
                  <Highlight text={snippetAround(note.snippet ?? note.preview, q, 12)} query={q} />
                ) : (
                  rowMeta(note, sort.field, note.id === props.currentId)
                )}
              </span>
            </div>
          </div>
        </div>
      );
    }
    if (row.kind === "create") {
      return (
        <div
          key="create"
          {...common}
          className={`panel-row${isSelected ? " is-selected" : ""}`}
          data-testid="search-create"
          onClick={createNote}
        >
          <Icon name="edit" />
          <span className="panel-row-title">{`New note “${q}”`}</span>
          <Keys shortcut="⌘↩" />
        </div>
      );
    }
    if (row.kind === "submenu") {
      const { entry } = row;
      return (
        <div key={entry.id}>
          {entry.divider ? <div className="menu-divider" /> : null}
          <div
            {...common}
            className={`panel-row${i === selected ? " is-selected" : ""}`}
            data-testid={`submenu-${entry.id}`}
            onClick={() => activate(row)}
          >
            <Icon name={entry.icon} />
            <span className="panel-row-title">{entry.title}</span>
            <Icon name="chevron" />
          </div>
        </div>
      );
    }
    const { action } = row;
    const previous = rows[i - 1];
    // Matching actions under the notes get their own header; pushed lists divide their sections.
    const header =
      view === "browse" && previous?.kind === "note" ? "Actions" : view === "browse" && i === 0 ? "Actions" : null;
    const divider =
      row.divider || (!split && !q && previous?.kind === "action" && previous.action.section !== action.section);
    return (
      <div key={action.id}>
        {header ? <div className="menu-section">{header}</div> : null}
        {divider ? <div className="menu-divider" /> : null}
        <ActionRow action={action} selected={isSelected} common={common} onRun={() => runAction(action)} />
      </div>
    );
  };

  const side = () => {
    if (submenu) {
      return (
        <div className="search-submenu" data-testid="search-submenu" role="listbox" aria-label={submenu.title}>
          <div className="menu-section">{submenu.title}</div>
          {submenu.children.map((action, i) => (
            <ActionRow
              key={action.id}
              action={action}
              selected={inSubmenu && i === subSelected}
              common={{
                role: "option",
                "aria-selected": inSubmenu && i === subSelected,
                tabIndex: -1,
                onMouseDown: keepFocus,
                onMouseEnter: () => dispatch({ type: "selectInSubmenu", index: i }),
              }}
              onRun={() => runAction(action)}
            />
          ))}
        </div>
      );
    }
    if (view === "deleted") {
      // Dimmed, so it is clear the note is gone until it is restored.
      const item = deletedRows[selected];
      if (!item) return null;
      const lines = item.preview.split("\n");
      return (
        <div className="search-preview is-dimmed" data-testid="search-preview">
          <div className="search-preview-title">{displayTitle({ title: item.title, text: item.preview })}</div>
          <div className="search-preview-body">{lines.slice(1).join("\n").trim()}</div>
        </div>
      );
    }
    if (!previewNote) return null;
    const full = fullNotes.get(previewNote.id);
    const title = displayTitle({ title: previewNote.title, text: previewNote.preview });
    // Until the note loads, a match deep in it still shows through the row's snippet.
    const text = full?.text ?? (q && previewNote.snippet ? `\n${previewNote.snippet}` : previewNote.preview);
    // The body without its first line, which is the title above it.
    const body = text.slice(text.indexOf("\n") >= 0 ? text.indexOf("\n") + 1 : text.length).trim();
    return (
      <div className="search-preview" data-testid="search-preview">
        <div className="search-preview-title">
          <Highlight text={title} query={q} />
        </div>
        <div className="search-preview-body">
          <Highlight text={snippetAround(body, q, 80)} query={q} />
        </div>
        <div className="search-preview-meta">
          <span>Created {shortDate(previewNote.createdAt)}</span>
          <span>Edited {relativeTime(previewNote.updatedAt)}</span>
          <span>{wordLabel(full ? countWords(full.text) : previewNote.wordCount)}</span>
        </div>
      </div>
    );
  };

  const keyActions = KEY_ACTIONS.map((chip) => ({ ...chip, action: byId.get(chip.id) })).filter(
    (chip): chip is typeof chip & { action: PanelAction } => chip.action !== undefined,
  );

  return (
    <div className="panel-backdrop" onMouseDown={props.onClose}>
      <div
        className={`popover panel${split ? " is-split" : ""}${inSubmenu && submenu ? " is-in-submenu" : ""}`}
        data-testid="command-panel"
        data-view={view}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="search-field">
          {view === "root" || view === "deleted" ? (
            <span className="search-token" data-testid="search-token">
              {view === "root" ? "Actions" : "Recently Deleted"}
            </span>
          ) : (
            <Icon name="search" />
          )}
          <input
            ref={inputRef}
            className="panel-search"
            value={query}
            placeholder={PLACEHOLDERS[view]}
            aria-label={PLACEHOLDERS[view]}
            spellCheck={false}
            onChange={(event) => dispatch({ type: "type", query: event.target.value })}
          />
          {view === "browse" ? (
            <button
              type="button"
              className="search-token search-sort"
              data-testid="search-sort"
              aria-haspopup="menu"
              aria-expanded={sortAnchor !== null}
              aria-label={`Sort: ${sortLabel(sort.field)}`}
              tabIndex={-1}
              onMouseDown={(event) => event.preventDefault()}
              onClick={(event) => (sortAnchor ? closeSortMenu() : setSortAnchor(event.currentTarget))}
            >
              {sortLabel(sort.field)} ▾
            </button>
          ) : null}
          {view === "browse" && sortAnchor ? (
            <Menu
              items={sortItems}
              anchor={sortAnchor}
              prefer="below"
              align="end"
              onSelect={chooseSort}
              onClose={closeSortMenu}
            />
          ) : null}
        </div>
        {view === "browse" && !q ? (
          <div className="search-chips" data-testid="key-actions">
            {keyActions.map(({ id, label, icon, action }) => (
              <button
                key={id}
                type="button"
                className="search-chip"
                data-testid={`chip-${id}`}
                aria-label={action.shortcut ? `${label} (${action.shortcut})` : label}
                title={label}
                aria-disabled={action.enabled === false}
                tabIndex={-1}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => runAction(action)}
              >
                <Icon name={icon} />
                <span className="search-chip-label">{label}</span>
                {action.shortcut ? <kbd>{action.shortcut}</kbd> : null}
              </button>
            ))}
            <button
              type="button"
              className="search-chip is-outlined"
              data-testid="chip-actions"
              tabIndex={-1}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => swap("root")}
            >
              <span className="search-chip-label">All actions</span>
              <kbd>⌘K</kbd>
            </button>
          </div>
        ) : null}
        <div className="search-body">
          <div className="panel-list" key={view} ref={listRef} onScroll={onScroll} role="listbox">
            {view === "browse" && !browse.items.length && browseStatus === "loading" ? <SkeletonRows /> : null}
            {view === "browse" && !browse.items.length && browseStatus === "error" ? (
              <EmptyState
                icon="search"
                title="Could Not Load Notes"
                hint="Something went wrong while reading your notes."
                error
                action={{ title: "Try Again", run: retryBrowse }}
              />
            ) : null}
            {view === "browse" && !browse.items.length && browseStatus === "loaded" && !q ? (
              <EmptyState icon="search" title="No Notes Yet" hint="Notes you write show up here." />
            ) : null}
            {view !== "deleted" && view !== "settings" ? rows.map(renderRow) : null}
            {view === "deleted" ? (
              <>
                {deleted.status === "loading" && !deletedRows.length ? <SkeletonRows /> : null}
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
                      hint={`Deleted notes stay here for ${rpc.TRASH_RETENTION_DAYS} days before they are removed.`}
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
                    tabIndex={i === selected ? 0 : -1}
                    onMouseEnter={() => setIndex(i)}
                    onClick={() => {
                      props.onClose();
                      props.onPreview(note);
                    }}
                  >
                    <div className="panel-row-text">
                      <span className="panel-row-title">{displayTitle({ title: note.title, text: note.preview })}</span>
                      <span className="panel-row-subtitle">{deletedMeta(note.deletedAt ?? note.updatedAt)}</span>
                    </div>
                    {i === selected ? (
                      <span className="panel-row-buttons">
                        <button
                          type="button"
                          className="icon-button"
                          title="Restore"
                          aria-label="Restore"
                          tabIndex={-1}
                          onClick={(event) => {
                            event.stopPropagation();
                            void props.onRecover(note.id).then(refresh);
                          }}
                        >
                          <Icon name="restore" />
                        </button>
                        <button
                          type="button"
                          className="icon-button"
                          title="Delete Permanently"
                          aria-label="Delete Permanently"
                          tabIndex={-1}
                          onClick={(event) => {
                            event.stopPropagation();
                            void props.onPermanentlyDelete(note.id).then(refresh);
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
                onReset={props.onResetSettings}
              />
            ) : null}
            {view !== "browse" && view !== "deleted" && view !== "settings" && !rows.length ? (
              <EmptyState icon="search" title="No Matching Actions" />
            ) : null}
            {view === "settings" && !settingRows.length ? (
              <EmptyState icon="search" title="No Matching Settings" />
            ) : null}
          </div>
          {split ? <div className="search-side">{side()}</div> : null}
        </div>
        {view === "browse" ? (
          <div className="search-footer" data-testid="search-footer">
            <span>
              <kbd>↩</kbd> Open
            </span>
            <span>
              <kbd>⌘↩</kbd> New note
            </span>
            <span>
              <kbd>⌘⌫</kbd> Delete
            </span>
            <span className="search-footer-count">
              {`${browse.items.length}${browse.cursor ? "+" : ""} ${browse.items.length === 1 && !browse.cursor ? "note" : "notes"}`}
            </span>
          </div>
        ) : null}
        {view === "deleted" ? (
          <div className="search-footer" data-testid="search-footer">
            <span>
              <kbd>↩</kbd> Restore
            </span>
            <span>
              <kbd>⌘⌫</kbd> Delete forever
            </span>
            <span className="search-footer-count">{`Kept ${rpc.TRASH_RETENTION_DAYS} days`}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** A deleted row's meta line (board 11): when it was deleted, and the days left before the helper purges it. */
function deletedMeta(deletedAt: number, now = Date.now()): string {
  const left = Math.max(0, Math.ceil((deletedAt + rpc.TRASH_RETENTION_DAYS * DAY_MS - now) / DAY_MS));
  return `Deleted ${relativeTime(deletedAt)} · ${left} ${left === 1 ? "day" : "days"} left`;
}

interface RowProps {
  role: "option";
  "aria-selected": boolean;
  tabIndex: number;
  onMouseDown: (event: React.MouseEvent) => void;
  onMouseEnter: () => void;
}

/** A click on a row keeps focus in the search field, so the keys still reach Search after a click. */
const keepFocus = (event: React.MouseEvent) => event.preventDefault();

/** An action row, shared by every list: icon, title, then its shortcut or a chevron when it opens a view. */
function ActionRow({
  action,
  selected,
  common,
  onRun,
}: {
  action: PanelAction;
  selected: boolean;
  common: RowProps;
  onRun: () => void;
}) {
  return (
    <button
      type="button"
      {...common}
      aria-disabled={action.enabled === false}
      className={`panel-row${selected ? " is-selected" : ""}${action.destructive ? " is-destructive" : ""}${action.enabled === false ? " is-disabled" : ""}`}
      data-testid={`action-${action.id}`}
      onClick={onRun}
    >
      {action.icon ? <Icon name={action.icon} /> : null}
      <span className="panel-row-title">{action.title}</span>
      {action.push ? <Icon name="chevron" /> : action.shortcut ? <Keys shortcut={action.shortcut} /> : null}
    </button>
  );
}
/**
 * Inert stand-ins for a first load that has not answered yet: two line rows built from the real row
 * classes, so they take the same height as the notes they make room for at every panel size and zoom.
 */
function SkeletonRows() {
  return (
    <div className="panel-skeleton" data-testid="panel-skeleton" aria-hidden="true">
      {[0, 1, 2, 3].map((row) => (
        <div key={row} className="panel-row panel-skeleton-row">
          <span className="panel-row-text">
            <span className="panel-row-title">
              <span className="skeleton-line" />
            </span>
            <span className="panel-row-subtitle">
              <span className="skeleton-line" />
            </span>
          </span>
        </div>
      ))}
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
