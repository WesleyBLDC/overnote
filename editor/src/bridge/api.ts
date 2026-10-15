/** Typed wrappers for every contract method, on top of BridgeClient.call. */
import { rpc } from "@better-notes/core";
import type { BridgeClient } from "./client";

const M = rpc.Method;
type P<K extends rpc.MethodName> = rpc.Params<K>;

export function createApi(client: BridgeClient) {
  const call = client.call.bind(client);
  return {
    system: {
      ping: () => call(M.SystemPing, {}),
      shutdown: () => call(M.SystemShutdown, {}),
      ready: () => call(M.SystemReady, {}),
    },
    window: {
      toggle: () => call(M.WindowToggle, {}),
      show: (params: P<"window.show"> = {}) => call(M.WindowShow, params),
      hide: () => call(M.WindowHide, {}),
      resize: (contentHeight: number, temporary = false) =>
        call(M.WindowResize, temporary ? { contentHeight, temporary } : { contentHeight }),
      resignFocus: () => call(M.WindowResignFocus, {}),
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
      get: (id: string) => call(M.NotesGet, { id }),
      update: (params: P<"notes.update">) => call(M.NotesUpdate, params),
      delete: (id: string) => call(M.NotesDelete, { id }),
      deleteAll: () => call(M.NotesDeleteAll, {}),
      recover: (id: string) => call(M.NotesRecover, { id }),
      permanentlyDelete: (id: string) => call(M.NotesPermanentlyDelete, { id }),
      emptyTrash: () => call(M.NotesEmptyTrash, {}),
      duplicate: (params: P<"notes.duplicate">) => call(M.NotesDuplicate, params),
      pin: (id: string) => call(M.NotesPin, { id }),
      unpin: (id: string) => call(M.NotesUnpin, { id }),
      movePinnedUp: (id: string) => call(M.NotesMovePinnedUp, { id }),
      movePinnedDown: (id: string) => call(M.NotesMovePinnedDown, { id }),
      list: (params: P<"notes.list"> = {}) => call(M.NotesList, params),
      browse: (params: P<"notes.browse"> = {}) => call(M.NotesBrowse, params),
      listDeleted: () => call(M.NotesListDeleted, {}),
      count: () => call(M.NotesCount, {}),
      setCurrentNote: (noteId: string) => call(M.NotesSetCurrentNote, { noteId }),
      touchAccessed: (id: string) => call(M.NotesTouchAccessed, { id }),
      windowData: (params: P<"notes.windowData"> = {}) => call(M.NotesWindowData, params),
    },
    settings: {
      get: () => call(M.SettingsGet, {}),
      set: (params: P<"settings.set">) => call(M.SettingsSet, params),
    },
    on: client.on.bind(client),
  };
}

export type Api = ReturnType<typeof createApi>;
