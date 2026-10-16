/**
 * Method names, params, results, and events from docs/architecture.md sections 3 and 5.
 * Both the socket client (extension) and the bridge client (editor) use these.
 */
import type { Millis, Note, NoteContent, NoteId, NoteSummary, Settings, WindowData } from "./types";

export const ErrorCode = {
  UnknownMethod: -32601,
  BadParams: -32602,
  NotFound: 404,
  Conflict: 409,
  Internal: 500,
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Client timeouts in milliseconds. */
export const TIMEOUT_MS = 3000;
export const SHUTDOWN_TIMEOUT_MS = 10000;
/** `file.saveAs` waits for the person in a native save panel. */
export const SAVE_AS_TIMEOUT_MS = 30 * 60 * 1000;

export const Method = {
  SystemPing: "system.ping",
  SystemShutdown: "system.shutdown",
  SystemReady: "system.ready",
  SystemStatus: "system.status",
  SystemBackup: "system.backup",
  SystemListBackups: "system.listBackups",
  SystemRestoreBackup: "system.restoreBackup",
  SystemDismissRestoreOffer: "system.dismissRestoreOffer",
  WindowToggle: "window.toggle",
  WindowShow: "window.show",
  WindowHide: "window.hide",
  WindowResize: "window.resize",
  WindowResignFocus: "window.resignFocus",
  WindowSetDragRegions: "window.setDragRegions",
  ClipboardCopy: "clipboard.copy",
  FileSaveAs: "file.saveAs",
  AppOpenURL: "app.openURL",
  NotesCreate: "notes.create",
  NotesGet: "notes.get",
  NotesUpdate: "notes.update",
  NotesDelete: "notes.delete",
  NotesDeleteAll: "notes.deleteAll",
  NotesRecover: "notes.recover",
  NotesPermanentlyDelete: "notes.permanentlyDelete",
  NotesEmptyTrash: "notes.emptyTrash",
  NotesDuplicate: "notes.duplicate",
  NotesPin: "notes.pin",
  NotesUnpin: "notes.unpin",
  NotesMovePinnedUp: "notes.movePinnedUp",
  NotesMovePinnedDown: "notes.movePinnedDown",
  NotesList: "notes.list",
  NotesBrowse: "notes.browse",
  NotesListDeleted: "notes.listDeleted",
  NotesCount: "notes.count",
  NotesSetCurrentNote: "notes.setCurrentNote",
  NotesTouchAccessed: "notes.touchAccessed",
  NotesWindowData: "notes.windowData",
  SettingsGet: "settings.get",
  SettingsSet: "settings.set",
  SettingsReset: "settings.reset",
} as const;
export type MethodName = (typeof Method)[keyof typeof Method];

/** Methods that only exist on the WKWebView bridge. */
export const BRIDGE_ONLY_METHODS: readonly MethodName[] = [
  Method.SystemReady,
  Method.WindowResize,
  Method.WindowResignFocus,
  Method.WindowSetDragRegions,
  Method.ClipboardCopy,
  Method.FileSaveAs,
  Method.AppOpenURL,
];

/** Methods that only exist on the socket (backups and restores are for the extension and scripts). */
export const SOCKET_ONLY_METHODS: readonly MethodName[] = [
  Method.SystemStatus,
  Method.SystemBackup,
  Method.SystemListBackups,
  Method.SystemRestoreBackup,
  Method.SystemDismissRestoreOffer,
];

type Empty = Record<string, never>;

/** Why a backup was written; the last part of its file name. */
export type BackupReason = "manual" | "daily" | "pre-migration" | "pre-update" | "pre-restore";

/** One file in the backups folder: `notes-<UTC timestamp>-v<version>-<reason>.sqlite`. */
export interface BackupInfo {
  path: string;
  name: string;
  createdAt: Millis;
  /** The helper version that wrote it. */
  version: string;
  reason: BackupReason;
  sizeBytes: number;
}

export interface SystemStatus {
  version: string;
  pid: number;
  /** The database's `PRAGMA user_version`. */
  schemaVersion: number;
  /** Live notes. */
  noteCount: number;
  backupDir: string;
  backupCount: number;
  latestBackup: BackupInfo | null;
  /** The helper started without a database while backups existed, and nothing was restored or dismissed since. */
  restoreAvailable: boolean;
}

export interface RestoreResult {
  restored: BackupInfo;
  /** The backup of the database as it was just before the restore. */
  preRestoreBackup: BackupInfo;
  noteCount: number;
}

/** Params for notes.list and notes.browse. */
export interface ListParams {
  /** Case-insensitive substring match on title or text; blank means no filter. */
  filter?: string;
  /** Default 100. */
  limit?: number;
  /** Opaque keyset cursor from a previous page. */
  cursor?: string;
}

export interface ListResult {
  items: NoteSummary[];
  nextCursor: string | null;
}

export interface DeletedItem extends NoteSummary {
  markdown: string;
  rawContent: string;
}

export type UpdateParams = { id: NoteId; expectedUpdatedAt?: Millis } & Partial<NoteContent> & {
    caretPosition?: number;
  };

export type UpdateResult = { status: "ok"; note: Note } | { status: "conflict"; note: Note };

/** A window drag region in points, top-left origin relative to the web view, zoom already applied. */
export interface DragRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Params and result for every method, keyed by method name. */
export interface Methods {
  "system.ping": { params: Empty; result: { version: string; pid: number } };
  "system.shutdown": { params: Empty; result: Empty };
  "system.ready": { params: Empty; result: { settings: Settings; windowData: WindowData } };
  "system.status": { params: Empty; result: SystemStatus };
  "system.backup": { params: { reason?: BackupReason }; result: BackupInfo };
  "system.listBackups": { params: Empty; result: { directory: string; items: BackupInfo[] } };
  "system.restoreBackup": { params: { path: string }; result: RestoreResult };
  "system.dismissRestoreOffer": { params: Empty; result: Empty };
  "window.toggle": { params: Empty; result: { visible: boolean } };
  "window.show": { params: { noteId?: NoteId }; result: { visible: true } };
  "window.hide": { params: Empty; result: { visible: false } };
  "window.resize": { params: { contentHeight: number; temporary?: boolean }; result: Empty };
  "window.resignFocus": { params: Empty; result: Empty };
  "window.setDragRegions": { params: { rects: DragRect[] }; result: Empty };
  "clipboard.copy": { params: { text: string; html?: string }; result: Empty };
  "app.openURL": { params: { url: string }; result: Empty };
  "file.saveAs": { params: { suggestedName: string; content: string }; result: { saved: boolean; path?: string } };
  "notes.create": { params: NoteContent & { show?: boolean }; result: Note };
  "notes.get": { params: { id: NoteId }; result: Note };
  "notes.update": { params: UpdateParams; result: UpdateResult };
  "notes.delete": { params: { id: NoteId }; result: Empty };
  "notes.deleteAll": { params: Empty; result: { count: number } };
  "notes.recover": { params: { id: NoteId }; result: Note };
  "notes.permanentlyDelete": { params: { id: NoteId }; result: Empty };
  "notes.emptyTrash": { params: Empty; result: { count: number } };
  "notes.duplicate": { params: { id: NoteId; titleSuffix?: string }; result: Note };
  "notes.pin": { params: { id: NoteId }; result: Note };
  "notes.unpin": { params: { id: NoteId }; result: Note };
  "notes.movePinnedUp": { params: { id: NoteId }; result: Empty };
  "notes.movePinnedDown": { params: { id: NoteId }; result: Empty };
  "notes.list": { params: ListParams; result: ListResult };
  "notes.browse": { params: ListParams; result: ListResult };
  "notes.listDeleted": { params: Empty; result: { items: DeletedItem[] } };
  "notes.count": { params: Empty; result: { count: number } };
  "notes.setCurrentNote": { params: { noteId: NoteId }; result: Empty };
  "notes.touchAccessed": { params: { id: NoteId }; result: Empty };
  "notes.windowData": { params: { noteId?: NoteId }; result: WindowData };
  "settings.get": { params: Empty; result: Settings };
  "settings.set": { params: Partial<Settings>; result: Settings };
  /** Every setting back to its default, the window frame included; notes and the current note stay. */
  "settings.reset": { params: Empty; result: Settings };
}

export type Params<M extends MethodName> = Methods[M]["params"];
export type Result<M extends MethodName> = Methods[M]["result"];

export interface Request<M extends MethodName = MethodName> {
  id: number | string;
  method: M;
  params: Params<M>;
}

export type Response<M extends MethodName = MethodName> =
  { id: number | string; result: Result<M> } | { id: number | string; error: { code: number; message: string } };

export const Event = {
  WindowDidShow: "window.didShow",
  WindowDidHide: "window.didHide",
  WindowDidBecomeKey: "window.didBecomeKey",
  WindowDidResignKey: "window.didResignKey",
  NoteOpen: "note.open",
  NoteNew: "note.new",
  NotesChanged: "notes.changed",
  SettingsChanged: "settings.changed",
  EditorWillReload: "editor.willReload",
} as const;
export type EventName = (typeof Event)[keyof typeof Event];

/** Payload for every native to web event, keyed by event name. */
export interface Events {
  "window.didShow": Empty;
  "window.didHide": Empty;
  "window.didBecomeKey": Empty;
  "window.didResignKey": Empty;
  "note.open": { id: NoteId };
  "note.new": { note: Note };
  "notes.changed": { ids: NoteId[] };
  "settings.changed": Settings;
  /** Development only (`--watch-editor`): the editor build changed; save, then reload the page. */
  "editor.willReload": Empty;
}
