/** Data types shared by every component (docs/contract.md section 4). */

/** ULID, 26 chars, Crockford base32, lexicographically sortable. */
export type NoteId = string;

/** Unix epoch milliseconds. */
export type Millis = number;

export interface NoteContent {
  /** JSON.stringify(ProseMirror doc JSON); canonical. */
  rawContent: string;
  /** Derived by @better-notes/core. */
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

export interface PanelFrame {
  x: number;
  y: number;
  width: number;
  height?: number;
}

export interface Settings {
  /** Default false: Esc hides the panel. */
  escapeLosesFocus: boolean;
  /** Default false. */
  hideWhileScreenSharing: boolean;
  /** Default 1.0, range 0.75 to 2.0, step 0.05. */
  zoom: number;
  /** Default true: height follows content; false keeps the user's height. */
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
  windowAutoSize: true,
  showFormatBar: false,
  countMode: "characters",
  panelFrame: null,
});
