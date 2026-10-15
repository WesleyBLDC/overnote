/**
 * NoteSession owns everything about "which note is open" and "is it saved":
 * autosave, caret saves, note switching, history, create, duplicate, delete, pins, and
 * reacting to native events. It has no React or DOM dependency so it can be unit tested.
 */
import {
  buildNoteContent,
  emptyDoc,
  loadDoc,
  type JSONContent,
  type Note,
  type NoteId,
  type WindowData,
} from "@overnote/core";
import type { Api } from "../bridge/api";
import { NoteHistory } from "./history";

export const SAVE_DEBOUNCE_MS = 300;
/** An edit this recent counts as "the user is typing". */
export const TYPING_WINDOW_MS = 1000;

/** What the session needs from the editor view. */
export interface EditorPort {
  getDoc(): JSONContent;
  getCaret(): number;
  /** Replaces the document without emitting a change, then places the caret. */
  load(doc: JSONContent, caret: number | null): void;
  isComposing(): boolean;
  /** Plain text of the current document, used for the blank check. */
  getText(): string;
}

export type NoticeKind = "info" | "error";

export interface SessionState {
  current: Note | null;
  previousNoteId: NoteId | null;
  nextNoteId: NoteId | null;
  pinnedShortcutNoteIds: NoteId[];
  canGoBack: boolean;
  canGoForward: boolean;
  saving: boolean;
  ready: boolean;
  /** The editor shows something else (a deleted note preview) and edits are not tracked. */
  paused: boolean;
}

export interface SessionOptions {
  api: Api;
  editor: EditorPort;
  notice?: (message: string, kind: NoticeKind) => void;
  now?: () => number;
  debounceMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

type HistoryCommit = (previous: NoteId | null) => void;

function docFromNote(note: Note): JSONContent {
  return loadDoc(note.rawContent || null, note.text ?? "");
}

export class NoteSession {
  readonly history = new NoteHistory();
  private state: SessionState = {
    current: null,
    previousNoteId: null,
    nextNoteId: null,
    pinnedShortcutNoteIds: [],
    canGoBack: false,
    canGoForward: false,
    saving: false,
    ready: false,
    paused: false,
  };
  private readonly listeners = new Set<() => void>();
  private readonly api: Api;
  private readonly editor: EditorPort;
  private readonly notify: (message: string, kind: NoticeKind) => void;
  private readonly now: () => number;
  private readonly debounceMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  private timer: unknown = null;
  private editVersion = 0;
  private savedVersion = 0;
  private savedCaret: number | null = null;
  private caretDirty = false;
  private lastEditAt = Number.NEGATIVE_INFINITY;
  private loading = false;
  private chain: Promise<boolean> = Promise.resolve(true);
  /** True after a background save failed, until one succeeds, so the failure is reported once. */
  private backgroundSaveFailing = false;
  private transition = 0;

  constructor(options: SessionOptions) {
    this.api = options.api;
    this.editor = options.editor;
    this.notify = options.notice ?? (() => undefined);
    this.now = options.now ?? Date.now;
    this.debounceMs = options.debounceMs ?? SAVE_DEBOUNCE_MS;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  // ---- state for the UI ----

  getState = (): SessionState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private setState(patch: Partial<SessionState>): void {
    const next = { ...this.state, ...patch };
    const currentId = next.current?.id ?? null;
    next.canGoBack = this.history.peekBack(currentId) !== null || next.previousNoteId !== null;
    next.canGoForward = this.history.peekForward(currentId) !== null || next.nextNoteId !== null;
    this.state = next;
    for (const listener of this.listeners) listener();
  }

  /** Recomputes history flags after the stacks changed. */
  private refreshFlags(): void {
    this.setState({});
  }

  get isDirty(): boolean {
    return this.editVersion !== this.savedVersion;
  }

  isBlank(): boolean {
    return this.editor.getText().trim() === "";
  }

  // ---- boot ----

  async boot(): Promise<void> {
    const ready = await this.api.system.ready();
    await this.applyBoot(ready.windowData);
  }

  async applyBoot(windowData: WindowData): Promise<void> {
    if (!windowData.current) {
      await this.createAndOpen(null);
    } else {
      this.apply(windowData, true);
      void this.api.notes.setCurrentNote(windowData.current.id).catch(() => undefined);
    }
    this.setState({ ready: true });
  }

  // ---- edits and saving ----

  /** The user changed the document. */
  contentChanged(): void {
    if (this.loading || this.paused) return;
    this.editVersion++;
    this.lastEditAt = this.now();
    this.schedule();
  }

  /** The selection moved. */
  selectionChanged(): void {
    if (this.loading || this.paused) return;
    const caret = this.editor.getCaret();
    if (caret === this.savedCaret) return;
    this.caretDirty = true;
    this.schedule();
  }

  isTyping(): boolean {
    return this.editor.isComposing() || this.now() - this.lastEditAt < TYPING_WINDOW_MS;
  }

  private schedule(): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.saveInBackground();
    }, this.debounceMs);
  }

  /**
   * Saves without anyone waiting for the result (autosave, hide, blur). The first failure shows a
   * notice; later ones stay quiet until a save succeeds again, so typing never repeats it.
   */
  saveInBackground(): void {
    void this.flush().then((ok) => {
      if (!ok && !this.backgroundSaveFailing) this.notify("Could not save note. Try again.", "error");
      this.backgroundSaveFailing = !ok;
    });
  }

  /** Runs a person's action; a failure becomes an error notice instead of an unhandled rejection. */
  private async guard(what: string, work: () => Promise<boolean>): Promise<boolean> {
    try {
      return await work();
    } catch (error) {
      console.error(`[session] ${what} failed`, error);
      this.notify(`Could not ${what}. Try again.`, "error");
      return false;
    }
  }

  /** Saves pending content and caret now. Resolves false when the save failed. */
  flush(): Promise<boolean> {
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    this.chain = this.chain.then(
      () => this.saveNow(),
      () => this.saveNow(),
    );
    return this.chain;
  }

  private async saveNow(): Promise<boolean> {
    const note = this.state.current;
    if (!note) return true;
    if (!this.isDirty && !this.caretDirty) return true;
    this.setState({ saving: true });
    try {
      if (this.isDirty) return await this.saveContent(note);
      return await this.saveCaret(note);
    } catch (error) {
      console.error("[session] save failed", error);
      return false;
    } finally {
      this.setState({ saving: false });
    }
  }

  private async saveContent(note: Note): Promise<boolean> {
    const version = this.editVersion;
    const caret = this.editor.getCaret();
    const content = buildNoteContent(this.editor.getDoc());
    let expected = note.updatedAt;
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await this.api.notes.update({
        id: note.id,
        expectedUpdatedAt: expected,
        ...content,
        caretPosition: caret,
      });
      if (result.status === "ok") {
        this.savedVersion = version;
        this.savedCaret = caret;
        this.caretDirty = this.editor.getCaret() !== caret;
        if (this.state.current?.id === note.id) this.setState({ current: result.note });
        return true;
      }
      // Conflict: the user typed in this note since it was loaded, so the local edit wins.
      expected = result.note.updatedAt;
    }
    return false;
  }

  private async saveCaret(note: Note): Promise<boolean> {
    const caret = this.editor.getCaret();
    await this.api.notes.update({ id: note.id, caretPosition: caret });
    this.savedCaret = caret;
    this.caretDirty = this.editor.getCaret() !== caret;
    return true;
  }

  // ---- read-only previews ----

  /**
   * Saves pending edits, then stops tracking the editor so it can show something else
   * (a deleted note preview). Resolves false when the save failed.
   */
  async pause(): Promise<boolean> {
    if (!(await this.flush())) {
      this.notify("Could not save note. Try again.", "error");
      return false;
    }
    this.setPaused(true);
    return true;
  }

  /** Puts the current note back into the editor and resumes saving. */
  resume(): void {
    if (!this.paused) return;
    this.setPaused(false);
    const current = this.state.current;
    if (current) this.loadNote(current, current.caretPosition);
  }

  private get paused(): boolean {
    return this.state.paused;
  }

  private setPaused(paused: boolean): void {
    if (this.state.paused !== paused) this.setState({ paused });
  }

  // ---- loading notes into the editor ----

  private apply(windowData: WindowData, reload: boolean): void {
    const current = windowData.current;
    if (reload) this.setPaused(false);
    if (reload && current) this.loadNote(current, current.caretPosition);
    this.setState({
      current,
      previousNoteId: windowData.previousNoteId,
      nextNoteId: windowData.nextNoteId,
      pinnedShortcutNoteIds: windowData.pinnedShortcutNoteIds,
    });
  }

  private loadNote(note: Note, caret: number | null): void {
    this.loading = true;
    try {
      this.editor.load(docFromNote(note), caret);
    } finally {
      this.loading = false;
    }
    this.savedVersion = this.editVersion;
    this.savedCaret = this.editor.getCaret();
    this.caretDirty = false;
    this.lastEditAt = Number.NEGATIVE_INFINITY;
  }

  /**
   * Flushes, then switches to `id`. `commit` updates the history stacks once the switch is certain.
   * A newer switch cancels an older one that is still waiting.
   */
  private switchTo(id: NoteId, commit: HistoryCommit | null): Promise<boolean> {
    return this.guard("open the note", () => this.switchToNow(id, commit));
  }

  private async switchToNow(id: NoteId, commit: HistoryCommit | null): Promise<boolean> {
    this.setPaused(false);
    const token = ++this.transition;
    if (!(await this.flush())) {
      if (token === this.transition) this.notify("Could not save note. Try again.", "error");
      return false;
    }
    if (token !== this.transition) return false;
    const windowData = await this.api.notes.windowData({ noteId: id });
    if (token !== this.transition) return false;
    if (!windowData.current) {
      await this.createAndOpen(this.state.current?.id ?? null);
      return true;
    }
    if (windowData.current.id !== id) this.history.remove(id);
    const previous = this.state.current?.id ?? null;
    if (commit && previous !== windowData.current.id) commit(previous);
    this.apply(windowData, true);
    this.touch(windowData.current.id);
    return true;
  }

  private touch(id: NoteId): void {
    void this.api.notes.touchAccessed(id).catch(() => undefined);
    void this.api.notes.setCurrentNote(id).catch(() => undefined);
  }

  private visitCommit: HistoryCommit = (previous) => {
    if (previous) this.history.visit(previous);
  };

  /** Opens a note the normal way (browse, pin slot, deeplink): records history. */
  open(id: NoteId): Promise<boolean> {
    if (id === this.state.current?.id) return Promise.resolve(true);
    return this.switchTo(id, this.visitCommit);
  }

  openPinSlot(slot: number): Promise<boolean> | null {
    const id = this.state.pinnedShortcutNoteIds[slot - 1];
    return id ? this.open(id) : null;
  }

  async back(): Promise<boolean> {
    const currentId = this.state.current?.id ?? null;
    const target = this.history.peekBack(currentId);
    if (target) {
      return this.switchTo(target, (previous) => {
        this.history.commitBack(previous);
      });
    }
    if (this.state.previousNoteId) return this.switchTo(this.state.previousNoteId, null);
    return false;
  }

  async forward(): Promise<boolean> {
    const currentId = this.state.current?.id ?? null;
    const target = this.history.peekForward(currentId);
    if (target) {
      return this.switchTo(target, (previous) => {
        this.history.commitForward(previous);
      });
    }
    if (this.state.nextNoteId) return this.switchTo(this.state.nextNoteId, null);
    return false;
  }

  /** Creates an empty note and makes it current. `previous` is pushed on the back stack. */
  private async createAndOpen(previous: NoteId | null): Promise<Note> {
    const note = await this.api.notes.create(buildNoteContent(emptyDoc()));
    const windowData = await this.api.notes.windowData({ noteId: note.id });
    if (previous && previous !== note.id) this.history.visit(previous);
    this.apply({ ...windowData, current: windowData.current ?? note }, true);
    return note;
  }

  /** ⌘N: refuses on a blank note, otherwise creates an empty note. */
  newNote(): Promise<boolean> {
    return this.guard("create a note", () => this.newNoteNow());
  }

  private async newNoteNow(): Promise<boolean> {
    if (this.state.current && this.isBlank()) {
      this.notify("You already have an empty note", "info");
      return false;
    }
    const token = ++this.transition;
    if (!(await this.flush())) {
      this.notify("Could not save note. Try again.", "error");
      return false;
    }
    if (token !== this.transition) return false;
    await this.createAndOpen(this.state.current?.id ?? null);
    return true;
  }

  /** ⌘D: the copy becomes current and is pushed onto history. */
  duplicate(): Promise<boolean> {
    return this.guard("duplicate the note", () => this.duplicateNow());
  }

  private async duplicateNow(): Promise<boolean> {
    const note = this.state.current;
    if (!note || this.isBlank()) return false;
    if (!(await this.flush())) {
      this.notify("Could not save note. Try again.", "error");
      return false;
    }
    const copy = await this.api.notes.duplicate({ id: note.id });
    const windowData = await this.api.notes.windowData({ noteId: copy.id });
    this.history.visit(note.id);
    this.apply({ ...windowData, current: windowData.current ?? copy }, true);
    this.notify("Note duplicated", "info");
    return true;
  }

  /** ⌃X: no confirmation; opens the older neighbor, else the newer, else a fresh note. */
  deleteCurrent(): Promise<boolean> {
    return this.guard("delete the note", () => this.deleteCurrentNow());
  }

  private async deleteCurrentNow(): Promise<boolean> {
    const note = this.state.current;
    if (!note) return false;
    const token = ++this.transition;
    if (!(await this.flush())) {
      this.notify("Could not save note. Try again.", "error");
      return false;
    }
    if (token !== this.transition) return false;
    const { nextNoteId, previousNoteId } = this.state;
    await this.api.notes.delete(note.id);
    this.history.remove(note.id);
    const target = nextNoteId ?? previousNoteId;
    const windowData = target ? await this.api.notes.windowData({ noteId: target }) : null;
    if (windowData?.current) {
      this.apply(windowData, true);
      this.touch(windowData.current.id);
    } else {
      await this.createAndOpen(null);
    }
    this.notify("Note deleted", "info");
    return true;
  }

  /** ⌃⇧X after the UI confirmed: everything goes to the trash, one fresh note remains. */
  deleteAll(): Promise<boolean> {
    return this.guard("delete all notes", () => this.deleteAllNow());
  }

  private async deleteAllNow(): Promise<boolean> {
    const token = ++this.transition;
    if (!(await this.flush())) {
      this.notify("Could not save note. Try again.", "error");
      return false;
    }
    if (token !== this.transition) return false;
    await this.api.notes.deleteAll();
    this.history.clear();
    await this.createAndOpen(null);
    this.notify("All notes moved to Recently Deleted", "info");
    return true;
  }

  /** ⇧⌘P on the current note. */
  togglePin(): Promise<boolean> {
    return this.guard("pin the note", () => this.togglePinNow());
  }

  private async togglePinNow(): Promise<boolean> {
    const note = this.state.current;
    if (!note) return false;
    const pinned = note.pinned === null;
    if (pinned) await this.api.notes.pin(note.id);
    else await this.api.notes.unpin(note.id);
    await this.refresh();
    this.notify(pinned ? "Note pinned" : "Note unpinned", "info");
    return true;
  }

  // ---- native events ----

  /** note.open from an external caller. */
  handleNoteOpen(id: NoteId): Promise<boolean> {
    return this.open(id);
  }

  /** note.new: an external caller created a note (already current in the helper). */
  async handleNoteNew(note: Note): Promise<boolean> {
    if (note.id === this.state.current?.id) return true;
    return this.switchTo(note.id, this.visitCommit);
  }

  /** notes.changed: data changed through the socket. */
  async handleNotesChanged(_ids: NoteId[]): Promise<void> {
    // Even when the current note is not among the ids, its neighbors and pins may have changed.
    // Nobody asked for this reload, so a failure is logged, not shown; the next change retries.
    await this.refresh().catch((error: unknown) => console.error("[session] reload failed", error));
  }

  /**
   * Re-reads window data for the current note. Rebases onto newer stored content unless the user
   * has unsaved edits or is typing; follows the helper's fallback if the note disappeared.
   */
  async refresh(): Promise<void> {
    const current = this.state.current;
    if (!current || this.paused) return;
    const token = this.transition;
    const windowData = await this.api.notes.windowData({ noteId: current.id });
    if (token !== this.transition || this.state.current?.id !== current.id) return;
    const stored = windowData.current;
    if (!stored) {
      this.history.clear();
      await this.createAndOpen(null);
      return;
    }
    if (stored.id !== current.id) {
      this.history.remove(current.id);
      this.apply(windowData, true);
      this.touch(stored.id);
      return;
    }
    const contentChanged = stored.rawContent !== current.rawContent && stored.updatedAt !== current.updatedAt;
    if (contentChanged && !this.isDirty && !this.isTyping()) {
      this.loadNote(stored, this.editor.getCaret());
      this.apply(windowData, false);
      return;
    }
    // Keep the local edit and our updatedAt so the next save detects the conflict.
    const merged = contentChanged
      ? { ...stored, rawContent: current.rawContent, updatedAt: current.updatedAt }
      : stored;
    this.apply({ ...windowData, current: merged }, false);
    this.refreshFlags();
  }
}
