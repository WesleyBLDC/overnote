/**
 * Settings (board 08, SPEC §10): one page inside the panel, in four short groups. Every control writes through
 * settings.set; the Data group reads the backups list and runs Back up now, Show in Finder, Reset, and Delete all.
 * The search field keeps focus: ↑↓ pick a row, ↩ toggles or runs it, ←→ step a choice or the zoom, Esc clears
 * the search and then closes, and ⌘F returns to the search field.
 */
import { ZOOM, type Settings } from "@overnote/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Api } from "../bridge/api";
import { fuzzyScore } from "../editor/slash";
import type { Notify } from "../lib/notice";
import { stepZoom, zoomLabel } from "../lib/zoom";
import { Icon } from "./icons";
import { CloseButton } from "./Toolbar";

type ToggleKey =
  | "floatOnTop"
  | "windowAutoSize"
  | "allSpaces"
  | "hideWhileScreenSharing"
  | "escapeLosesFocus"
  | "showFormatBar"
  | "spellcheck"
  | "smartTypography";
type ChoiceKey = "appearance" | "font" | "countMode";
type SettingsAction = "revealFolder" | "backup" | "reset" | "deleteAll";

const SECTIONS = ["Window", "Display", "Editor", "Data"] as const;
type Section = (typeof SECTIONS)[number];

interface RowBase {
  id: string;
  section: Section;
  title: string;
  keywords?: string[];
  shortcut?: string;
}

export type SettingRow = RowBase &
  (
    | { kind: "toggle"; key: ToggleKey }
    | {
        kind: "choice";
        key: ChoiceKey;
        control: "segmented" | "menu";
        options: readonly { value: string; label: string }[];
      }
    | { kind: "zoom" }
    | { kind: "action"; action: SettingsAction; button: string; danger?: boolean }
  );

const SETTING_ROWS: readonly SettingRow[] = [
  {
    id: "floatOnTop",
    kind: "toggle",
    key: "floatOnTop",
    section: "Window",
    title: "Float above other apps",
    keywords: ["level", "top", "pin"],
  },
  {
    id: "windowAutoSize",
    kind: "toggle",
    key: "windowAutoSize",
    section: "Window",
    title: "Auto-size to note",
    shortcut: "⇧⌘/",
    keywords: ["height", "resize"],
  },
  {
    id: "allSpaces",
    kind: "toggle",
    key: "allSpaces",
    section: "Window",
    title: "Show in all Spaces",
    keywords: ["desktop", "mission control"],
  },
  {
    id: "hideWhileScreenSharing",
    kind: "toggle",
    key: "hideWhileScreenSharing",
    section: "Window",
    title: "Hide while screen sharing",
    keywords: ["privacy", "record"],
  },
  {
    id: "escapeLosesFocus",
    kind: "toggle",
    key: "escapeLosesFocus",
    section: "Window",
    title: "Esc returns to the previous app",
    keywords: ["escape", "hide", "focus"],
  },
  {
    id: "appearance",
    kind: "choice",
    key: "appearance",
    control: "segmented",
    section: "Display",
    title: "Appearance",
    keywords: ["theme", "dark", "light", "mode"],
    options: [
      { value: "light", label: "Light" },
      { value: "dark", label: "Dark" },
      { value: "auto", label: "Auto" },
    ],
  },
  {
    id: "font",
    kind: "choice",
    key: "font",
    control: "menu",
    section: "Display",
    title: "Font",
    keywords: ["typeface", "geist", "sf"],
    options: [
      { value: "geist", label: "Geist" },
      { value: "system", label: "SF Pro" },
    ],
  },
  { id: "zoom", kind: "zoom", section: "Display", title: "Zoom", keywords: ["size", "scale", "text"] },
  {
    id: "countMode",
    kind: "choice",
    key: "countMode",
    control: "segmented",
    section: "Display",
    title: "Corner count",
    keywords: ["counter", "characters", "words"],
    options: [
      { value: "words", label: "Words" },
      { value: "characters", label: "Characters" },
      { value: "off", label: "Off" },
    ],
  },
  {
    id: "showFormatBar",
    kind: "toggle",
    key: "showFormatBar",
    section: "Editor",
    title: "Pin format island",
    shortcut: "⌥⌘,",
    keywords: ["toolbar", "format bar"],
  },
  {
    id: "spellcheck",
    kind: "toggle",
    key: "spellcheck",
    section: "Editor",
    title: "Spellcheck",
    keywords: ["spelling"],
  },
  {
    id: "smartTypography",
    kind: "toggle",
    key: "smartTypography",
    section: "Editor",
    title: "Smart quotes and dashes",
    keywords: ["typography", "curly"],
  },
  {
    id: "revealFolder",
    kind: "action",
    action: "revealFolder",
    button: "Show in Finder",
    section: "Data",
    title: "Notes folder",
    keywords: ["finder", "database", "location"],
  },
  {
    id: "backup",
    kind: "action",
    action: "backup",
    button: "Back up now",
    section: "Data",
    title: "Backups",
    keywords: ["backup", "restore"],
  },
  {
    id: "reset",
    kind: "action",
    action: "reset",
    button: "Reset",
    section: "Data",
    title: "Reset all settings",
    keywords: ["default", "restore"],
  },
  {
    id: "deleteAll",
    kind: "action",
    action: "deleteAll",
    button: "Delete…",
    danger: true,
    section: "Data",
    title: "Delete all notes",
    keywords: ["erase", "trash"],
  },
];

function filterSettings(query: string): SettingRow[] {
  const q = query.trim();
  if (!q) return [...SETTING_ROWS];
  return SETTING_ROWS.filter(
    (row) =>
      Math.max(...[row.title, ...(row.keywords ?? [])].map((text) => fuzzyScore(q, text))) >=
      Math.max(2, q.length * 1.5),
  );
}

/**
 * The change a key makes on a row: ↩ (0) flips a toggle or moves a choice to its next option, and ←→ (-1, 1)
 * step a choice or the zoom. Null when the key changes nothing there (actions run elsewhere).
 */
function adjustSetting(row: SettingRow, settings: Settings, direction: -1 | 0 | 1): Partial<Settings> | null {
  switch (row.kind) {
    case "toggle":
      return direction === 0 ? { [row.key]: !settings[row.key] } : null;
    case "choice": {
      const at = row.options.findIndex((option) => option.value === settings[row.key]);
      const next =
        direction === 0 ? (at + 1) % row.options.length : Math.min(row.options.length - 1, Math.max(0, at + direction));
      return next === at ? null : ({ [row.key]: row.options[next]!.value } as Partial<Settings>);
    }
    case "zoom": {
      if (direction === 0) return null;
      const zoom = stepZoom(settings.zoom, direction);
      return zoom === settings.zoom ? null : { zoom };
    }
    case "action":
      return null;
  }
}

/** "today 9:12", "yesterday 9:12", or "Nov 12" for an older backup. */
function backupLabel(at: number, now = Date.now()): string {
  const time = new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: false });
  const day = (ms: number) => new Date(ms).toDateString();
  if (day(at) === day(now)) return `today ${time}`;
  if (day(at) === day(now - 24 * 60 * 60 * 1000)) return `yesterday ${time}`;
  return new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** A home folder path shortened the way Finder's Go To Folder takes it: `~/Library/…`. */
const tildePath = (path: string) => path.replace(/^\/Users\/[^/]+/, "~");

interface SettingsPageProps {
  api: Api;
  settings: Settings;
  notify: Notify;
  onChange: (patch: Partial<Settings>) => void;
  onReset: () => void;
  onDeleteAll: () => void;
  /** Leaves Settings for the note (‹, Esc, ⌘,). */
  onBack: () => void;
  /** The red dot: hides the panel. */
  onHide: () => void;
}

interface DataInfo {
  folder: string | null;
  lastBackup: number | null;
}

/** Keeps focus in the search field when a control is clicked. */
const keepFocus = (event: React.MouseEvent) => event.preventDefault();

export function SettingsPage(props: SettingsPageProps) {
  const { api, notify } = props;
  const [query, setQuery] = useState("");
  // No row is highlighted until the arrows, the pointer, or a search picks one.
  const [selected, setSelected] = useState(-1);
  const [data, setData] = useState<DataInfo>({ folder: null, lastBackup: null });
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const rows = useMemo(() => filterSettings(query), [query]);

  const loadData = useCallback(
    () =>
      api.system
        .listBackups()
        .then((list) => setData({ folder: list.dataDirectory, lastBackup: list.items[0]?.createdAt ?? null }))
        .catch(() => undefined),
    [api],
  );
  useEffect(() => {
    void loadData();
    searchRef.current?.focus();
  }, [loadData]);

  useEffect(() => {
    listRef.current?.querySelector(".settings-row.is-selected")?.scrollIntoView({ block: "nearest" });
  }, [selected, rows]);

  const run = (action: SettingsAction) => {
    if (action === "reset") props.onReset();
    else if (action === "deleteAll") props.onDeleteAll();
    else if (action === "revealFolder")
      void api.app.revealDataFolder().catch(() => notify("Could not open Finder.", "error"));
    else
      void api.system
        .backup()
        .then(() => {
          notify("Backed up", "success");
          return loadData();
        })
        .catch(() => notify("Could not back up. Try again.", "error"));
  };

  const activate = (row: SettingRow | undefined, direction: -1 | 0 | 1) => {
    if (!row) return false;
    if (row.kind === "action") {
      if (direction === 0) run(row.action);
      return direction === 0;
    }
    const patch = adjustSetting(row, props.settings, direction);
    if (patch) props.onChange(patch);
    return patch !== null || direction === 0;
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    let handled = true;
    if (event.key === "ArrowDown") setSelected((i) => Math.min(rows.length - 1, i + 1));
    else if (event.key === "ArrowUp") setSelected((i) => Math.max(0, i - 1));
    else if (event.key === "Enter") activate(rows[selected], 0);
    // Arrows on a row they do not adjust keep moving the caret in the search field.
    else if (event.key === "ArrowLeft" || event.key === "ArrowRight")
      handled = activate(rows[selected], event.key === "ArrowLeft" ? -1 : 1) && rows[selected]?.kind !== "action";
    else if (event.key === "Escape") {
      if (query) {
        setQuery("");
        setSelected(0);
      } else props.onBack();
    } else if (event.key === "f" && event.metaKey) searchRef.current?.select();
    else handled = false;
    if (!handled) return;
    event.preventDefault();
    event.stopPropagation();
  };

  const detail = (row: SettingRow) => {
    if (row.kind !== "action") return null;
    if (row.action === "revealFolder") return data.folder ? tildePath(data.folder) : null;
    if (row.action === "backup") return data.lastBackup ? `Last: ${backupLabel(data.lastBackup)}` : "None yet";
    return null;
  };

  return (
    <div className="settings-page" data-testid="settings" onKeyDown={onKeyDown}>
      <header className="settings-header">
        <div className="toolbar-leading">
          <CloseButton onClose={props.onHide} />
        </div>
        <button
          type="button"
          className="icon-button settings-back"
          aria-label="Back to the note"
          data-testid="settings-back"
          onMouseDown={keepFocus}
          onClick={props.onBack}
          tabIndex={-1}
        >
          <Icon name="back" />
        </button>
        <h1 className="settings-title">Settings</h1>
        <label className="settings-search">
          <Icon name="search" />
          <input
            ref={searchRef}
            value={query}
            placeholder="Search settings"
            aria-label="Search settings"
            aria-controls="settings-list"
            aria-activedescendant={rows[selected] ? `setting-row-${rows[selected].id}` : undefined}
            spellCheck={false}
            data-testid="settings-search"
            onChange={(event) => {
              setQuery(event.target.value);
              setSelected(0);
            }}
          />
        </label>
      </header>
      <div className="settings-body" ref={listRef} id="settings-list" role="listbox" aria-label="Settings">
        {SECTIONS.map((section) => {
          const inSection = rows.filter((row) => row.section === section);
          if (!inSection.length) return null;
          return (
            <div key={section} className="settings-group" role="group" aria-label={section}>
              <div className="settings-group-label">{section}</div>
              {inSection.map((row) => {
                const index = rows.indexOf(row);
                const note = detail(row);
                return (
                  <div
                    key={row.id}
                    id={`setting-row-${row.id}`}
                    role="option"
                    aria-selected={index === selected}
                    className={`settings-row${index === selected ? " is-selected" : ""}${row.kind === "action" && row.danger ? " is-danger" : ""}`}
                    data-testid={`setting-${row.id}`}
                    onMouseEnter={() => setSelected(index)}
                    onMouseDown={keepFocus}
                    onClick={() => row.kind === "toggle" && activate(row, 0)}
                  >
                    <span className="settings-row-title">{row.title}</span>
                    {row.shortcut ? (
                      <kbd className="settings-shortcut" aria-label={`Shortcut ${row.shortcut}`}>
                        {row.shortcut}
                      </kbd>
                    ) : null}
                    {note ? <span className="settings-row-detail">{note}</span> : null}
                    <SettingControl row={row} settings={props.settings} onChange={props.onChange} onRun={run} />
                  </div>
                );
              })}
            </div>
          );
        })}
        {!rows.length ? <div className="settings-empty">No matching settings</div> : null}
      </div>
    </div>
  );
}

function SettingControl({
  row,
  settings,
  onChange,
  onRun,
}: {
  row: SettingRow;
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  onRun: (action: SettingsAction) => void;
}) {
  switch (row.kind) {
    case "toggle": {
      const on = settings[row.key];
      return <span role="switch" aria-checked={on} aria-label={row.title} className={`toggle${on ? " is-on" : ""}`} />;
    }
    case "choice": {
      const value = settings[row.key];
      if (row.control === "menu")
        return (
          <span className="settings-menu">
            <select
              value={value}
              aria-label={row.title}
              tabIndex={-1}
              data-testid={`choice-${row.key}`}
              onChange={(event) => onChange({ [row.key]: event.target.value } as Partial<Settings>)}
            >
              {row.options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <Icon name="down" />
          </span>
        );
      return (
        <span className="segmented" role="radiogroup" aria-label={row.title}>
          {row.options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              tabIndex={-1}
              aria-checked={value === option.value}
              className={value === option.value ? "is-on" : ""}
              data-testid={`${row.key}-${option.value}`}
              onMouseDown={keepFocus}
              onClick={() => onChange({ [row.key]: option.value } as Partial<Settings>)}
            >
              {option.label}
            </button>
          ))}
        </span>
      );
    }
    case "zoom": {
      const step = (direction: -1 | 1) => () => {
        const zoom = stepZoom(settings.zoom, direction);
        if (zoom !== settings.zoom) onChange({ zoom });
      };
      return (
        <span className="stepper">
          <button
            type="button"
            tabIndex={-1}
            className="icon-button"
            aria-label="Zoom Out"
            data-testid="zoom-out"
            disabled={settings.zoom <= ZOOM.min}
            onMouseDown={keepFocus}
            onClick={step(-1)}
          >
            <Icon name="minus" />
          </button>
          <span className="stepper-value" data-testid="zoom-value">
            {zoomLabel(settings.zoom)}
          </span>
          <button
            type="button"
            tabIndex={-1}
            className="icon-button"
            aria-label="Zoom In"
            data-testid="zoom-in"
            disabled={settings.zoom >= ZOOM.max}
            onMouseDown={keepFocus}
            onClick={step(1)}
          >
            <Icon name="plus" />
          </button>
        </span>
      );
    }
    case "action":
      return (
        <button
          type="button"
          tabIndex={-1}
          className={`text-button settings-button${row.danger ? " is-danger" : ""}`}
          data-testid={`run-${row.action}`}
          onMouseDown={keepFocus}
          onClick={() => onRun(row.action)}
        >
          {row.button}
        </button>
      );
  }
}
