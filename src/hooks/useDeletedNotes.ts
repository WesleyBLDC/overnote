import { useCachedPromise } from "@raycast/utils";

import { listDeletedNotes } from "../api/notes";

/** Trashed notes, most recently deleted first. */
export function useDeletedNotes() {
  return useCachedPromise(listDeletedNotes, [], { keepPreviousData: true });
}
