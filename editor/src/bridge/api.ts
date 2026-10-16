/** Typed wrappers for the protocol methods the editor uses (docs/architecture.md), on top of BridgeClient.call. */
import { rpc } from "@overnote/core";
import type { BridgeClient } from "./client";

const M = rpc.Method;
type P<K extends rpc.MethodName> = rpc.Params<K>;

export function createApi(client: BridgeClient) {
  const call = client.call.bind(client);
  return {
    system: {
      ready: () => call(M.SystemReady, {}),
    },
    window: {
      hide: () => call(M.WindowHide, {}),
      resize: (contentHeight: number, temporary = false) =>
        call(M.WindowResize, temporary ? { contentHeight, temporary } : { contentHeight }),
      setOverhang: (height: number) => call(M.WindowSetOverhang, { height }),
      resignFocus: () => call(M.WindowResignFocus, {}),
      setDragRegions: (rects: rpc.DragRect[]) => call(M.WindowSetDragRegions, { rects }),
    },
    clipboard: {
      copy: (params: P<"clipboard.copy">) => call(M.ClipboardCopy, params),
    },
    app: {
      openURL: (url: string) => call(M.AppOpenURL, { url }),
    },
    file: {
      saveAs: (params: P<"file.saveAs">) => call(M.FileSaveAs, params),
    },
    notes: {
      create: (params: P<"notes.create">) => call(M.NotesCreate, params),
      update: (params: P<"notes.update">) => call(M.NotesUpdate, params),
      delete: (id: string) => call(M.NotesDelete, { id }),
      deleteAll: () => call(M.NotesDeleteAll, {}),
      recover: (id: string) => call(M.NotesRecover, { id }),
      permanentlyDelete: (id: string) => call(M.NotesPermanentlyDelete, { id }),
      duplicate: (params: P<"notes.duplicate">) => call(M.NotesDuplicate, params),
      pin: (id: string) => call(M.NotesPin, { id }),
      unpin: (id: string) => call(M.NotesUnpin, { id }),
      browse: (params: P<"notes.browse"> = {}) => call(M.NotesBrowse, params),
      listDeleted: () => call(M.NotesListDeleted, {}),
      setCurrentNote: (noteId: string) => call(M.NotesSetCurrentNote, { noteId }),
      touchAccessed: (id: string) => call(M.NotesTouchAccessed, { id }),
      windowData: (params: P<"notes.windowData"> = {}) => call(M.NotesWindowData, params),
    },
    settings: {
      get: () => call(M.SettingsGet, {}),
      set: (params: P<"settings.set">) => call(M.SettingsSet, params),
      reset: () => call(M.SettingsReset, {}),
    },
    on: client.on.bind(client),
  };
}

export type Api = ReturnType<typeof createApi>;
