import { ensureHelper } from "./helper";
import { listNotes } from "./notes";
import type { NoteSummary } from "../domain/types";

export interface MenuData {
  pinned: NoteSummary[];
  recent: NoteSummary[];
}

const RECENT_COUNT = 10;

/**
 * The menu bar's one side effect, documented in contract section 8: it restarts a dead helper.
 * It then reads pinned notes and the most recently edited unpinned ones.
 */
export async function loadMenuData(): Promise<MenuData> {
  await ensureHelper();
  const notes = await listNotes();
  return {
    pinned: notes.filter((note) => note.pinned !== null),
    recent: notes.filter((note) => note.pinned === null).slice(0, RECENT_COUNT),
  };
}
