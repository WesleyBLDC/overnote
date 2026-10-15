/**
 * Data and RPC types (docs/architecture.md sections 4 and 5), taken from @overnote/core (its light `text` entry) so the
 * extension and the editor share one definition. Type-only imports: nothing from core loads here.
 */
import type { rpc } from "@overnote/core/text";

export type { Millis, Note, NoteContent, NoteId, NoteSummary, Settings, WindowData } from "@overnote/core/text";

export type ListParams = rpc.ListParams;
export type DeletedNoteSummary = rpc.DeletedItem;
export type UpdateResult = rpc.UpdateResult;
export type BackupInfo = rpc.BackupInfo;
export type BackupReason = rpc.BackupReason;
export type SystemStatus = rpc.SystemStatus;
export type RestoreResult = rpc.RestoreResult;

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** Socket methods only; bridge-only methods are not reachable from the extension. */
export type RpcMethods = Omit<
  rpc.Methods,
  "system.ready" | "window.resize" | "window.resignFocus" | "clipboard.copy" | "file.saveAs"
>;
export type RpcMethod = keyof RpcMethods;
export type RpcParams<M extends RpcMethod> = RpcMethods[M]["params"];
export type RpcResult<M extends RpcMethod> = RpcMethods[M]["result"];
