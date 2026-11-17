/** Data types shared by every component (docs/architecture.md section 4). */

/** ULID, 26 chars, Crockford base32, lexicographically sortable. */
export type NoteId = string;

/** Unix epoch milliseconds. */
export type Millis = number;

export interface NoteContent {
  /** JSON.stringify(ProseMirror doc JSON); canonical. */
  rawContent: string;
  /** Derived by @overnote/core. */
  markdown: string;
  /** Plain text, derived by core. */
  text: string;
  /** Derived by core: first line of the plain text, trimmed (may be empty). */
  title: string;
}

export interface Note extends NoteContent {
  id: NoteId;
  /** Fractional sort key; null means not pinned. */
  pinned: number | null;
  createdAt: Millis;
  updatedAt: Millis;
  deletedAt: Millis | null;
  lastAccessedAt: Millis | null;
  caretPosition: number | null;
}

/** List rows: no rawContent or markdown. */
export interface NoteSummary {
  id: NoteId;
  title: string;
  /** First 200 chars of text. */
  preview: string;
  /** Characters of text. */
  charCount: number;
  pinned: number | null;
  createdAt: Millis;
  updatedAt: Millis;
  deletedAt: Millis | null;
  lastAccessedAt: Millis | null;
}

/** A Search row (`notes.browse`): a list row plus its word count, and with a filter the passage around the first text match. */
export interface BrowseItem extends NoteSummary {
  /** Words of text (UAX #29 word-like segments, as countWords counts them). */
  wordCount: number;
  /** With a filter: the passage around the first match in text, starting up to 40 characters ahead of it on a word. */
  snippet?: string;
}

export type CountMode = "characters" | "words";

/** What Search orders notes by: Last opened, Modified, Created, Title, Length. */
export type BrowseSortField = "opened" | "modified" | "created" | "title" | "length";

export interface BrowseSort {
  field: BrowseSortField;
  /** "desc" is newest, longest, or Z to A first. */
  direction: "asc" | "desc";
}

/** Search's persisted sort: the order, and whether pinned notes stay on top. */
export interface SearchSort extends BrowseSort {
  pinnedFirst: boolean;
}

/** Where `window.place` puts the panel inside one display, named exactly as the protocol names it on the wire. */
export type PanelPlacement = "left" | "right" | "fill" | "center";

/** A remembered top left point on one display (`y` is the top edge), with the placed size and placement after `window.place`. */
export interface PanelPoint {
  x: number;
  y: number;
  width?: number;
  height?: number;
  placement?: PanelPlacement;
}

/** A panel frame in points: `x` is the left edge and `y` is the top edge. */
export interface PanelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PanelFrame {
  x: number;
  y: number;
  width: number;
  height?: number;
  /** One remembered point per display, keyed by `"<display uuid>@<width>x<height>"`. */
  displays?: { [key: string]: PanelPoint };
}

export interface Settings {
  /** Default false: Esc hides the panel. */
  escapeLosesFocus: boolean;
  /** Default false. */
  hideWhileScreenSharing: boolean;
  /** Default 1.0, range 0.75 to 2.0, step 0.05. */
  zoom: number;
  /** Default false: the first open uses a roomy 640 x 560 pt panel and keeps the user's height; true: height follows content. */
  windowAutoSize: boolean;
  /** Default false. */
  showFormatBar: boolean;
  /** Default "words" (v3.6; "characters" before). */
  countMode: CountMode;
  panelFrame: PanelFrame | null;
  /** The terminal drawer. Default `{ open: false }`; the drawer height is a fixed 260 pt. */
  terminal: TerminalSettings;
  /** Search's sort menu (v3.7). Default `{ field: "modified", direction: "desc", pinnedFirst: true }`. */
  searchSort: SearchSort;
}

export interface TerminalSettings {
  /** Whether the drawer is open, so the panel reopens it after a restart. */
  open: boolean;
}

export interface WindowData {
  /** Null only when no live notes exist. */
  current: Note | null;
  /** Newer neighbor in updatedAt desc order. */
  previousNoteId: NoteId | null;
  /** Older neighbor in updatedAt desc order. */
  nextNoteId: NoteId | null;
  /** Pin order, at most 9 (⌘1 through ⌘9); ⌘0 is reset zoom. */
  pinnedShortcutNoteIds: NoteId[];
}

/** Error payload used by both the socket and the bridge. */
export const ZOOM = Object.freeze({ min: 0.75, max: 2, step: 0.05, default: 1 });

export interface RpcErrorPayload {
  code: number;
  message: string;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  escapeLosesFocus: false,
  hideWhileScreenSharing: false,
  zoom: 1,
  windowAutoSize: false,
  showFormatBar: false,
  countMode: "words",
  panelFrame: null,
  terminal: Object.freeze({ open: false }),
  searchSort: Object.freeze({ field: "modified", direction: "desc", pinnedFirst: true }),
});
