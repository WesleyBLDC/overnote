/**
 * NoteSession's switches: only the newest switch changes what the editor shows, and a deleted note preview refuses
 * actions on the current note. Saving, merging, and everyday switching run end to end in tests/.
 */
import type { JSONContent, Note, WindowData } from "@overnote/core";
import { describe, expect, it } from "vitest";
import type { Api } from "../src/bridge/api";
import { NoteSession, type EditorPort } from "../src/session/session";

const note = (id: string, text = id): Note => ({
  id,
  title: text,
  text,
  markdown: text,
  rawContent: "",
  pinned: null,
  createdAt: 1,
  updatedAt: 1,
  deletedAt: null,
  lastAccessedAt: null,
  caretPosition: null,
});

const windowData = (current: Note | null): WindowData => ({
  current,
  previousNoteId: null,
  nextNoteId: null,
  pinnedShortcutNoteIds: [],
});

/** A promise the test settles by hand. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function setup() {
  const pending: Record<string, ReturnType<typeof deferred<unknown>>[]> = {};
  const wait = <T>(key: string) => {
    const d = deferred<unknown>();
    (pending[key] ??= []).push(d);
    return d.promise as Promise<T>;
  };
  const resolve = (key: string, value: unknown) => pending[key]!.shift()!.resolve(value);
  const quiet = () => Promise.resolve({});
  const api = {
    notes: {
      windowData: ({ noteId }: { noteId: string }) => wait<WindowData>(`windowData:${noteId}`),
      duplicate: () => wait<Note>("duplicate"),
      setCurrentNote: quiet,
      touchAccessed: quiet,
      delete: quiet,
    },
  } as unknown as Api;
  let editable = true;
  let doc: JSONContent = { type: "doc", content: [] };
  const editor: EditorPort = {
    getDoc: () => doc,
    getCaret: () => 0,
    load: (next) => (doc = next),
    replace: (next) => (doc = next),
    isComposing: () => false,
    getText: () => "text",
    setEditable: (value) => (editable = value),
  };
  const session = new NoteSession({ api, editor, setTimer: () => 0, clearTimer: () => undefined });
  return { session, resolve, isEditable: () => editable };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("NoteSession", () => {
  it("a duplicate that answers after a newer open never replaces the opened note", async () => {
    const { session, resolve } = setup();
    await session.applyBoot(windowData(note("a")));
    const duplicating = session.duplicate();
    await tick();
    const opening = session.open("b");
    await tick();
    resolve("windowData:b", windowData(note("b")));
    expect(await opening).toBe(true);
    resolve("duplicate", note("a-copy"));
    expect(await duplicating).toBe(false);
    expect(session.getState().current?.id).toBe("b");
  });

  it("a preview refuses actions on the current note, and leaving it makes the editor editable", async () => {
    const { session, isEditable } = setup();
    await session.applyBoot(windowData(note("a")));
    const item = { ...note("gone"), deletedAt: 2, preview: "gone", charCount: 4 };
    expect(await session.startPreview(item)).toBe(true);
    expect([session.getState().mode.kind, isEditable()]).toEqual(["preview", false]);
    expect(await session.duplicate()).toBe(false);
    expect(await session.deleteCurrent()).toBe(false);
    expect(await session.togglePin()).toBe(false);
    session.exitPreview();
    expect([session.getState().mode.kind, isEditable()]).toEqual(["editing", true]);
  });
});
