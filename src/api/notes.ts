import { closeMainWindow } from "@raycast/api";

import { normalizeFilter, titleMatchesFirst } from "../domain/fold";
import { summaryTitle } from "../domain/format";
import { ReadOnlyNotesDb } from "../domain/readonly-db";
import type { DeletedNoteSummary, ListParams, Note, NoteContent, NoteId, NoteSummary, Page } from "../domain/types";
import { callHelper, getLauncher, helperPaths } from "./helper";
import { refreshMenuBar } from "./menu-bar";

const LIST_LIMIT = 100;

/**
 * Runs a read against the helper when it is already up, and against the read-only database
 * otherwise. Reads never start the helper, so lists stay instant on a cold start.
 */
async function read<T>(viaHelper: () => Promise<T>, viaDb: (db: ReadOnlyNotesDb) => T, empty: T): Promise<T> {
  if (await getLauncher().ping(300)) return viaHelper();
  const db = ReadOnlyNotesDb.open(helperPaths().database);
  if (!db) return empty;
  try {
    return viaDb(db);
  } finally {
    db.close();
  }
}

/**
 * One page of live notes in Search Notes order, optionally filtered. Title matches move to the
 * front of each page, as docs/architecture.md asks of the client.
 */
export async function listNotesPage(filter?: string, cursor?: string, limit = LIST_LIMIT): Promise<Page<NoteSummary>> {
  const normalized = normalizeFilter(filter);
  const params: ListParams = { limit };
  if (normalized !== undefined) params.filter = normalized;
  if (cursor !== undefined) params.cursor = cursor;
  const page = await read(
    () => getLauncher().client.call("notes.list", params),
    (db) => db.list(params),
    { items: [], nextCursor: null },
  );
  return { items: titleMatchesFirst(page.items, normalized, summaryTitle), nextCursor: page.nextCursor };
}

/** The first page of live notes. */
export async function listNotes(filter?: string, limit = LIST_LIMIT): Promise<NoteSummary[]> {
  return (await listNotesPage(filter, undefined, limit)).items;
}

/** Every trashed note, most recently deleted first, with markdown for the preview. */
export function listDeletedNotes(): Promise<DeletedNoteSummary[]> {
  return read(
    async () => (await getLauncher().client.call("notes.listDeleted", {})).items,
    (db) => db.listDeleted(),
    [],
  );
}

export function getNote(id: NoteId): Promise<Note | null> {
  return read(
    () => getLauncher().client.call("notes.get", { id }),
    (db) => db.get(id),
    null,
  );
}

/** Loads a note for copy and paste actions, failing loudly when it is gone. */
export async function requireNote(id: NoteId): Promise<Note> {
  const note = await getNote(id);
  if (!note) throw new Error("The note no longer exists");
  return note;
}

/** Closes Raycast, then shows the floating panel, optionally on one note. */
export async function openInOvernote(noteId?: NoteId): Promise<void> {
  await closeMainWindow();
  await callHelper("window.show", noteId ? { noteId } : {});
}

async function write<T>(work: () => Promise<T>): Promise<T> {
  const result = await work();
  await refreshMenuBar();
  return result;
}

export function createNote(content: NoteContent, options: { show?: boolean } = {}): Promise<Note> {
  return write(() => callHelper("notes.create", { ...content, show: options.show ?? false }));
}

export function pinNote(id: NoteId): Promise<Note> {
  return write(() => callHelper("notes.pin", { id }));
}

export function unpinNote(id: NoteId): Promise<Note> {
  return write(() => callHelper("notes.unpin", { id }));
}

export function movePinnedUp(id: NoteId): Promise<void> {
  return write(async () => {
    await callHelper("notes.movePinnedUp", { id });
  });
}

export function movePinnedDown(id: NoteId): Promise<void> {
  return write(async () => {
    await callHelper("notes.movePinnedDown", { id });
  });
}

/** Duplicates a note and makes the copy current, so the panel opens on it next. */
export function duplicateNote(id: NoteId, titleSuffix?: string): Promise<Note> {
  return write(async () => {
    const copy = await callHelper("notes.duplicate", titleSuffix === undefined ? { id } : { id, titleSuffix });
    await callHelper("notes.setCurrentNote", { noteId: copy.id });
    return copy;
  });
}

export function deleteNote(id: NoteId): Promise<void> {
  return write(async () => {
    await callHelper("notes.delete", { id });
  });
}

export function deleteAllNotes(): Promise<number> {
  return write(async () => (await callHelper("notes.deleteAll", {})).count);
}

export function recoverNote(id: NoteId): Promise<Note> {
  return write(() => callHelper("notes.recover", { id }));
}

export function permanentlyDeleteNote(id: NoteId): Promise<void> {
  return write(async () => {
    await callHelper("notes.permanentlyDelete", { id });
  });
}

export function emptyTrash(): Promise<number> {
  return write(async () => (await callHelper("notes.emptyTrash", {})).count);
}
