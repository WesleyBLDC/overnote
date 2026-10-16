/**
 * An in-memory model of the helper's notes service, following docs/architecture.md section 5.
 * Used by the browser dev harness and the Playwright tests; never shipped in the build.
 */
import {
  DEFAULT_SETTINGS,
  displayTitle,
  rpc,
  type Note,
  type NoteId,
  type NoteSummary,
  type Settings,
  type WindowData,
} from "@overnote/core";

export class MockRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

function socketOnly(method: string): never {
  throw new MockRpcError(rpc.ErrorCode.UnknownMethod, `${method} is only available on the socket`);
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function makeUlid(now: number, random: () => number = Math.random): string {
  let time = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  let rand = "";
  for (let i = 0; i < 16; i++) rand += CROCKFORD[Math.floor(random() * 32)];
  return time + rand;
}

type Handler = (params: never) => unknown;

export interface MockStoreOptions {
  now?: () => number;
  emit?: (event: rpc.EventName, payload: unknown) => void;
}

export class MockStore {
  notes = new Map<NoteId, Note>();
  settings: Settings = { ...DEFAULT_SETTINGS };
  currentNoteId: NoteId | null = null;
  visible = true;
  private lastNow = 0;
  private readonly clock: () => number;
  private readonly emit: (event: rpc.EventName, payload: unknown) => void;

  constructor(options: MockStoreOptions = {}) {
    this.clock = options.now ?? Date.now;
    this.emit = options.emit ?? (() => undefined);
  }

  /** Strictly increasing time so ordering by updatedAt is deterministic. */
  now(): number {
    this.lastNow = Math.max(this.clock(), this.lastNow + 1);
    return this.lastNow;
  }

  seed(contents: Array<Partial<Note> & Pick<Note, "rawContent" | "markdown" | "text" | "title">>): Note[] {
    return contents.map((content) => {
      const at = this.now();
      const note: Note = {
        id: makeUlid(at),
        pinned: null,
        createdAt: at,
        updatedAt: at,
        deletedAt: null,
        lastAccessedAt: at,
        caretPosition: 0,
        ...content,
      };
      this.notes.set(note.id, note);
      this.currentNoteId = note.id;
      return note;
    });
  }

  private live(): Note[] {
    return [...this.notes.values()].filter((n) => n.deletedAt === null);
  }

  private stack(): Note[] {
    return this.live().sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  }

  private pinnedSorted(): Note[] {
    return this.live()
      .filter((n) => n.pinned !== null)
      .sort((a, b) => (a.pinned ?? 0) - (b.pinned ?? 0));
  }

  private require(id: NoteId): Note {
    const note = this.notes.get(id);
    if (!note) throw new MockRpcError(rpc.ErrorCode.NotFound, `Note ${id} not found`);
    return note;
  }

  private summary(note: Note): NoteSummary {
    return {
      id: note.id,
      title: note.title,
      preview: note.text.slice(0, 200),
      charCount: Array.from(note.text).length,
      pinned: note.pinned,
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
      deletedAt: note.deletedAt,
      lastAccessedAt: note.lastAccessedAt,
    };
  }

  private changed(ids: NoteId[]): void {
    this.emit(rpc.Event.NotesChanged, { ids });
  }

  windowData(noteId?: NoteId): WindowData {
    const stack = this.stack();
    const wanted = noteId ?? this.currentNoteId ?? undefined;
    const current = stack.find((n) => n.id === wanted) ?? stack[0] ?? null;
    const index = current ? stack.indexOf(current) : -1;
    return {
      current: current ? { ...current } : null,
      previousNoteId: index > 0 ? (stack[index - 1]?.id ?? null) : null,
      nextNoteId: index >= 0 ? (stack[index + 1]?.id ?? null) : null,
      pinnedShortcutNoteIds: this.pinnedSorted()
        .slice(0, 9)
        .map((n) => n.id),
    };
  }

  private filtered(filter: string | undefined, order: (a: Note, b: Note) => number, titleFirst: boolean): Note[] {
    const term = filter?.trim().toLocaleLowerCase() ?? "";
    const pinOrder = (a: Note, b: Note) =>
      (a.pinned ?? Number.POSITIVE_INFINITY) - (b.pinned ?? Number.POSITIVE_INFINITY) || order(a, b);
    let notes = this.live().sort(pinOrder);
    if (term) {
      notes = notes.filter(
        (n) => n.title.toLocaleLowerCase().includes(term) || n.text.toLocaleLowerCase().includes(term),
      );
      if (titleFirst) {
        const hit = (n: Note) => (displayTitle(n).toLocaleLowerCase().includes(term) ? 0 : 1);
        notes = notes.sort((a, b) => hit(a) - hit(b) || pinOrder(a, b));
      }
    }
    return notes;
  }

  private page(notes: Note[], params: rpc.ListParams): rpc.ListResult {
    const limit = params.limit ?? 100;
    const start = params.cursor ? Number(params.cursor) : 0;
    const items = notes.slice(start, start + limit).map((n) => this.summary(n));
    const next = start + limit < notes.length ? String(start + limit) : null;
    return { items, nextCursor: next };
  }

  readonly handlers: { [M in rpc.MethodName]: (params: rpc.Params<M>) => rpc.Result<M> } = {
    "system.ping": () => ({ version: "mock", pid: 0 }),
    "system.shutdown": () => ({}),
    "system.ready": () => ({ settings: { ...this.settings }, windowData: this.windowData() }),
    // Socket-only on the real helper, so the bridge refuses them the same way.
    "system.status": () => socketOnly("system.status"),
    "system.backup": () => socketOnly("system.backup"),
    "system.listBackups": () => socketOnly("system.listBackups"),
    "system.restoreBackup": () => socketOnly("system.restoreBackup"),
    "system.dismissRestoreOffer": () => socketOnly("system.dismissRestoreOffer"),
    "window.toggle": () => {
      this.visible = !this.visible;
      this.emit(this.visible ? rpc.Event.WindowDidShow : rpc.Event.WindowDidHide, {});
      return { visible: this.visible };
    },
    "window.show": (params) => {
      this.visible = true;
      this.emit(rpc.Event.WindowDidShow, {});
      if (params.noteId) this.emit(rpc.Event.NoteOpen, { id: params.noteId });
      return { visible: true };
    },
    "window.hide": () => {
      this.visible = false;
      this.emit(rpc.Event.WindowDidHide, {});
      return { visible: false };
    },
    "window.resize": () => ({}),
    "window.setOverhang": () => ({}),
    "window.resignFocus": () => ({}),
    // The helper turns these into native drag areas; the mock only records the call.
    "window.setDragRegions": () => ({}),
    "clipboard.copy": () => ({}),
    "app.openURL": () => ({}),
    "file.saveAs": (params) => ({ saved: true, path: `/tmp/${params.suggestedName}` }),
    "notes.create": (params) => {
      const at = this.now();
      const { show, ...content } = params;
      const note: Note = {
        ...content,
        id: makeUlid(at),
        pinned: null,
        createdAt: at,
        updatedAt: at,
        deletedAt: null,
        lastAccessedAt: at,
        caretPosition: 0,
      };
      this.notes.set(note.id, note);
      this.currentNoteId = note.id;
      if (show) {
        this.visible = true;
        this.emit(rpc.Event.NoteNew, { note: { ...note } });
      }
      return { ...note };
    },
    "notes.get": (params) => ({ ...this.require(params.id) }),
    "notes.update": (params) => {
      const note = this.require(params.id);
      const { id: _id, expectedUpdatedAt, caretPosition, ...content } = params;
      const hasContent = Object.keys(content).length > 0;
      if (!hasContent) {
        if (caretPosition !== undefined && note.deletedAt === null) note.caretPosition = caretPosition;
        return { status: "ok", note: { ...note } };
      }
      if (expectedUpdatedAt !== undefined && expectedUpdatedAt !== note.updatedAt) {
        return { status: "conflict", note: { ...note } };
      }
      Object.assign(note, content);
      if (caretPosition !== undefined) note.caretPosition = caretPosition;
      note.updatedAt = this.now();
      return { status: "ok", note: { ...note } };
    },
    "notes.delete": (params) => {
      const note = this.require(params.id);
      if (note.deletedAt === null) {
        note.deletedAt = this.now();
        note.pinned = null;
        note.updatedAt += 1;
      }
      return {};
    },
    "notes.deleteAll": () => {
      const live = this.live();
      const at = this.now();
      for (const note of live) {
        note.deletedAt = at;
        note.pinned = null;
        note.updatedAt += 1;
      }
      return { count: live.length };
    },
    "notes.recover": (params) => {
      const note = this.require(params.id);
      if (note.deletedAt !== null) {
        note.deletedAt = null;
        note.updatedAt += 1;
      }
      return { ...note };
    },
    "notes.permanentlyDelete": (params) => {
      const note = this.notes.get(params.id);
      if (note && note.deletedAt !== null) this.notes.delete(params.id);
      return {};
    },
    "notes.emptyTrash": () => {
      let count = 0;
      for (const note of [...this.notes.values()]) {
        if (note.deletedAt !== null) {
          this.notes.delete(note.id);
          count++;
        }
      }
      return { count };
    },
    "notes.duplicate": (params) => {
      const source = this.require(params.id);
      const at = this.now();
      const copy: Note = {
        ...source,
        id: makeUlid(at),
        title: params.titleSuffix ? `${source.title}${params.titleSuffix}` : source.title,
        pinned: null,
        createdAt: at,
        updatedAt: at,
        lastAccessedAt: at,
        deletedAt: null,
        caretPosition: 0,
      };
      this.notes.set(copy.id, copy);
      this.currentNoteId = copy.id;
      return { ...copy };
    },
    "notes.pin": (params) => {
      const note = this.require(params.id);
      if (note.pinned === null) {
        const max = Math.max(0, ...this.pinnedSorted().map((n) => n.pinned ?? 0));
        note.pinned = max + 1000;
      }
      return { ...note };
    },
    "notes.unpin": (params) => {
      const note = this.require(params.id);
      note.pinned = null;
      return { ...note };
    },
    "notes.movePinnedUp": (params) => {
      this.swapPin(params.id, -1);
      return {};
    },
    "notes.movePinnedDown": (params) => {
      this.swapPin(params.id, 1);
      return {};
    },
    "notes.list": (params) =>
      this.page(
        this.filtered(params.filter, (a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id), false),
        params,
      ),
    "notes.browse": (params) =>
      this.page(
        this.filtered(
          params.filter,
          (a, b) => (b.lastAccessedAt ?? 0) - (a.lastAccessedAt ?? 0) || a.id.localeCompare(b.id),
          true,
        ),
        params,
      ),
    "notes.listDeleted": () => ({
      items: [...this.notes.values()]
        .filter((n) => n.deletedAt !== null)
        .sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0))
        .map((n) => ({ ...this.summary(n), markdown: n.markdown, rawContent: n.rawContent })),
    }),
    "notes.count": () => ({ count: this.live().length }),
    "notes.setCurrentNote": (params) => {
      this.currentNoteId = params.noteId;
      return {};
    },
    "notes.touchAccessed": (params) => {
      const note = this.notes.get(params.id);
      if (note && note.deletedAt === null) note.lastAccessedAt = this.now();
      return {};
    },
    "notes.windowData": (params) => this.windowData(params.noteId),
    "settings.get": () => ({ ...this.settings }),
    "settings.set": (params) => {
      this.settings = { ...this.settings, ...params };
      this.emit(rpc.Event.SettingsChanged, { ...this.settings });
      return { ...this.settings };
    },
    "settings.reset": () => {
      this.settings = { ...DEFAULT_SETTINGS };
      this.emit(rpc.Event.SettingsChanged, { ...this.settings });
      return { ...this.settings };
    },
  };

  private swapPin(id: NoteId, direction: -1 | 1): void {
    const pins = this.pinnedSorted();
    const index = pins.findIndex((n) => n.id === id);
    const other = pins[index + direction];
    const note = pins[index];
    if (index < 0 || !other || !note) return;
    [note.pinned, other.pinned] = [other.pinned, note.pinned];
  }

  /** Dispatches one request; throws MockRpcError for protocol errors. */
  dispatch(method: string, params: unknown): unknown {
    const handler = (this.handlers as Record<string, Handler | undefined>)[method];
    if (!handler) throw new MockRpcError(rpc.ErrorCode.UnknownMethod, `Unknown method ${method}`);
    return handler((params ?? {}) as never);
  }

  /** Simulates a write that came in through the socket (another process), which emits notes.changed. */
  externalUpdate(id: NoteId, content: Partial<Pick<Note, "rawContent" | "markdown" | "text" | "title">>): Note {
    const note = this.require(id);
    Object.assign(note, content);
    note.updatedAt = this.now();
    this.changed([id]);
    return { ...note };
  }
}
