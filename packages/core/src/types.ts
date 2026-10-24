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

export type CountMode = "characters" | "words";

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
  /** Default "characters". */
  countMode: CountMode;
  panelFrame: PanelFrame | null;
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
  countMode: "characters",
  panelFrame: null,
});
