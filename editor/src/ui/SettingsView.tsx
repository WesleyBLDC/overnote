/** The in-panel Settings view (⌘,): switches, the counter mode, and the zoom stepper, all through settings.set. */
import { ZOOM, type Settings } from "@overnote/core";
import { fuzzyScore } from "../editor/slash";
import { stepZoom, zoomLabel } from "../lib/zoom";
import { Icon } from "./icons";

type SwitchKey = "escapeLosesFocus" | "windowAutoSize" | "hideWhileScreenSharing" | "showFormatBar";

export type SettingRow =
  | { id: SwitchKey; kind: "switch"; title: string; subtitle: string; section: string; keywords?: string[] }
  | { id: "countMode"; kind: "segment"; title: string; subtitle: string; section: string; keywords?: string[] }
  | { id: "zoom"; kind: "stepper"; title: string; subtitle: string; section: string; keywords?: string[] }
  | { id: "reset"; kind: "action"; title: string; subtitle: string; section: string; keywords?: string[] };

export const SETTING_ROWS: readonly SettingRow[] = [
  {
    id: "escapeLosesFocus",
    kind: "switch",
    section: "Window",
    title: "Escape Key Loses Focus",
    subtitle: "Escape returns to the previous app",
    keywords: ["esc", "hide"],
  },
  {
    id: "windowAutoSize",
    kind: "switch",
    section: "Window",
    title: "Auto-Size Window to Content",
    subtitle: "Window height follows the note",
    keywords: ["height", "resize"],
  },
  {
    id: "hideWhileScreenSharing",
    kind: "switch",
    section: "Window",
    title: "Hide While Screen Sharing",
    subtitle: "Hidden from shares and recordings",
    keywords: ["privacy", "record"],
  },
  {
    id: "zoom",
    kind: "stepper",
    section: "Display",
    title: "Zoom",
    subtitle: "⌘=  ⌘-  ⌘0",
    keywords: ["size", "scale", "text"],
  },
  {
    id: "countMode",
    kind: "segment",
    section: "Display",
    title: "Counter",
    subtitle: "Shown in the bottom bar",
    keywords: ["characters", "words", "count"],
  },
  {
    id: "showFormatBar",
    kind: "switch",
    section: "Display",
    title: "Show Format Bar",
    subtitle: "Buttons in place of the counter",
    keywords: ["toolbar", "buttons"],
  },
  {
    id: "reset",
    kind: "action",
    section: "Reset",
    title: "Reset All Settings",
    subtitle: "Window size, zoom, and every option",
    keywords: ["default", "restore", "size"],
  },
];

export function filterSettings(query: string): SettingRow[] {
  const q = query.trim();
  if (!q) return [...SETTING_ROWS];
  return SETTING_ROWS.filter(
    (row) =>
      Math.max(...[row.title, ...(row.keywords ?? [])].map((text) => fuzzyScore(q, text))) >=
      Math.max(2, q.length * 1.5),
  );
}

/**
 * The change a key makes on a row: Enter (0) flips a switch or the counter, the arrows (-1, 1)
 * step the zoom or pick a counter mode. Null when the key does nothing there.
 */
export function adjustSetting(row: SettingRow, settings: Settings, direction: -1 | 0 | 1): Partial<Settings> | null {
  switch (row.kind) {
    case "switch":
      return direction === 0 ? { [row.id]: !settings[row.id] } : null;
    case "segment":
      if (direction === 0) return { countMode: settings.countMode === "words" ? "characters" : "words" };
      return { countMode: direction < 0 ? "characters" : "words" };
    case "action":
      return null;
    case "stepper": {
      if (direction === 0) return null;
      const zoom = stepZoom(settings.zoom, direction);
      return zoom === settings.zoom ? null : { zoom };
    }
  }
}

interface SettingsListProps {
  rows: SettingRow[];
  settings: Settings;
  selected: number;
  grouped: boolean;
  onHover: (index: number) => void;
  onChange: (patch: Partial<Settings>) => void;
  onReset: () => void;
}

/** Keeps focus in the panel search field when a control is clicked. */
const keepFocus = (event: React.MouseEvent) => event.preventDefault();

export function SettingsList({ rows, settings, selected, grouped, onHover, onChange, onReset }: SettingsListProps) {
  return (
    <>
      {rows.map((row, i) => {
        const header = grouped && row.section !== rows[i - 1]?.section ? row.section : null;
        return (
          <div key={row.id}>
            {header ? <div className="menu-section">{header}</div> : null}
            <div
              role="option"
              aria-selected={i === selected}
              className={`panel-row setting-row${i === selected ? " is-selected" : ""}`}
              data-testid={`setting-${row.id}`}
              onMouseEnter={() => onHover(i)}
              onMouseDown={keepFocus}
              onClick={() => {
                if (row.kind === "action") onReset();
                else if (row.kind !== "stepper") {
                  const patch = adjustSetting(row, settings, 0);
                  if (patch) onChange(patch);
                }
              }}
            >
              <div className="panel-row-text">
                <span className="panel-row-title">{row.title}</span>
                <span className="panel-row-subtitle">{row.subtitle}</span>
              </div>
              <SettingControl row={row} settings={settings} onChange={onChange} />
            </div>
          </div>
        );
      })}
    </>
  );
}

function SettingControl({
  row,
  settings,
  onChange,
}: {
  row: SettingRow;
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
}) {
  if (row.kind === "switch") {
    const on = settings[row.id];
    return <span role="switch" aria-checked={on} aria-label={row.title} className={`switch${on ? " is-on" : ""}`} />;
  }
  if (row.kind === "action") {
    return (
      <span className="text-button setting-action" aria-hidden>
        Reset
      </span>
    );
  }
  if (row.kind === "segment") {
    return (
      <span className="segmented" role="radiogroup" aria-label={row.title}>
        {(["characters", "words"] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            role="radio"
            tabIndex={-1}
            aria-checked={settings.countMode === mode}
            className={settings.countMode === mode ? "is-on" : ""}
            data-testid={`count-${mode}`}
            onMouseDown={keepFocus}
            onClick={(event) => {
              event.stopPropagation();
              onChange({ countMode: mode });
            }}
          >
            {mode === "characters" ? "Characters" : "Words"}
          </button>
        ))}
      </span>
    );
  }
  const step = (direction: -1 | 1) => (event: React.MouseEvent) => {
    event.stopPropagation();
    const patch = adjustSetting(row, settings, direction);
    if (patch) onChange(patch);
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
      <button
        type="button"
        tabIndex={-1}
        className="text-button stepper-reset"
        data-testid="zoom-reset"
        disabled={settings.zoom === ZOOM.default}
        onMouseDown={keepFocus}
        onClick={(event) => {
          event.stopPropagation();
          onChange({ zoom: ZOOM.default });
        }}
      >
        Reset
      </button>
    </span>
  );
}
