import { useCachedPromise } from "@raycast/utils";

import { getNote } from "../api/notes";
import type { Note } from "../domain/types";

async function loadNote(id: string): Promise<Note | null> {
  return id.length > 0 ? getNote(id) : null;
}

/** The full note (with markdown) for the selected row only, so lists stay metadata-only. */
export function useNote(id: string | undefined) {
  return useCachedPromise(loadNote, [id ?? ""], { execute: id !== undefined });
}
