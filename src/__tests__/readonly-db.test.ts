import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { foldForMatch, titleMatchesFirst } from "../domain/fold";
import { ReadOnlyNotesDb, loadSqlite } from "../domain/readonly-db";
import { shortTempDir } from "./helpers";

// docs/architecture.md section 6, verbatim apart from comments.
const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE notes (
  id               TEXT PRIMARY KEY,
  title            TEXT NOT NULL DEFAULT '',
  text             TEXT NOT NULL DEFAULT '',
  markdown         TEXT NOT NULL DEFAULT '',
  raw_content      TEXT NOT NULL,
  title_fold       TEXT NOT NULL DEFAULT '',
  text_fold        TEXT NOT NULL DEFAULT '',
  pinned           REAL,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  deleted_at       INTEGER,
  last_accessed_at INTEGER,
  caret_position   INTEGER
) STRICT, WITHOUT ROWID;
CREATE INDEX notes_list_order   ON notes (deleted_at, pinned, updated_at DESC, id);
CREATE INDEX notes_browse_order ON notes (deleted_at, pinned, last_accessed_at DESC, id);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
`;

interface Seed {
  id: string;
  title: string;
  text: string;
  updatedAt: number;
  pinned?: number | null;
  deletedAt?: number | null;
}

type Writer = InstanceType<ReturnType<typeof loadSqlite>["DatabaseSync"]>;

function openWriter(file: string): Writer {
  const { DatabaseSync } = loadSqlite();
  return new DatabaseSync(file);
}

function insert(db: Writer, seed: Seed) {
  db.prepare(
    `INSERT INTO notes (id, title, text, markdown, raw_content, title_fold, text_fold, pinned, created_at,
                        updated_at, deleted_at, last_accessed_at, caret_position)
     VALUES (?, ?, ?, ?, '{}', ?, ?, ?, ?, ?, ?, ?, 0)`,
  ).run(
    seed.id,
    seed.title,
    seed.text,
    `# ${seed.text}`,
    foldForMatch(seed.title),
    foldForMatch(seed.text),
    seed.pinned ?? null,
    1000,
    seed.updatedAt,
    seed.deletedAt ?? null,
    seed.updatedAt,
  );
}

describe("read-only notes database", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = shortTempDir();
    file = path.join(dir, "notes.sqlite");
    const writer = openWriter(file);
    writer.exec(SCHEMA);
    const seeds: Seed[] = [
      { id: "A", title: "Groceries", text: "Groceries\nmilk, eggs", updatedAt: 100 },
      { id: "B", title: "Café ideas", text: "Café ideas\nlatte art", updatedAt: 300 },
      { id: "C", title: "Meeting", text: "Meeting\nTalk about groceries budget", updatedAt: 200 },
      { id: "D", title: "Pinned second", text: "Pinned second", updatedAt: 50, pinned: 2000 },
      { id: "E", title: "Pinned first", text: "Pinned first", updatedAt: 40, pinned: 1000 },
      { id: "F", title: "Percent", text: "Percent\n100% done_now", updatedAt: 10 },
      { id: "G", title: "Same time b", text: "x", updatedAt: 5 },
      { id: "H", title: "Same time a", text: "x", updatedAt: 5 },
      { id: "X", title: "Old trash", text: "Old trash", updatedAt: 1, deletedAt: 500 },
      { id: "Y", title: "New trash", text: "New trash body", updatedAt: 1, deletedAt: 900 },
    ];
    for (const seed of seeds) insert(writer, seed);
    writer.close();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const withDb = <T>(work: (db: ReadOnlyNotesDb) => T): T => {
    const db = ReadOnlyNotesDb.open(file);
    if (!db) throw new Error("expected a database");
    try {
      return work(db);
    } finally {
      db.close();
    }
  };

  it("lists live notes: pinned by key, then updatedAt desc, then id asc", () => {
    const ids = withDb((db) => db.list().items.map((note) => note.id));
    expect(ids).toEqual(["E", "D", "B", "C", "A", "F", "G", "H"]);
  });

  it("pages with an opaque cursor without gaps or duplicates", () => {
    const seen: string[] = [];
    withDb((db) => {
      let cursor: string | undefined;
      do {
        const page = db.list({ limit: 3, cursor });
        seen.push(...page.items.map((note) => note.id));
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
    });
    expect(seen).toEqual(["E", "D", "B", "C", "A", "F", "G", "H"]);
  });

  it("filters by folded substring on title or text", () => {
    withDb((db) => {
      expect(db.list({ filter: "GROCER" }).items.map((note) => note.id)).toEqual(["C", "A"]);
      expect(db.list({ filter: "cafe" }).items.map((note) => note.id)).toEqual(["B"]);
      expect(db.list({ filter: "CAFÉ" }).items.map((note) => note.id)).toEqual(["B"]);
      expect(db.list({ filter: "trash" }).items).toEqual([]);
      expect(db.list({ filter: "   " }).items).toHaveLength(8);
    });
  });

  it("treats LIKE wildcards in the filter literally", () => {
    withDb((db) => {
      expect(db.list({ filter: "%" }).items.map((note) => note.id)).toEqual(["F"]);
      expect(db.list({ filter: "_" }).items.map((note) => note.id)).toEqual(["F"]);
      expect(db.list({ filter: "0% d" }).items.map((note) => note.id)).toEqual(["F"]);
    });
  });

  it("lists every trashed note with markdown, newest deletion first", () => {
    const items = withDb((db) => db.listDeleted());
    expect(items.map((note) => note.id)).toEqual(["Y", "X"]);
    expect(items[0]).toMatchObject({ markdown: "# New trash body", deletedAt: 900 });
  });
});

describe("title matches first", () => {
  it("moves title matches first and keeps order inside each group", () => {
    const items = [
      { id: "1", title: "Budget" },
      { id: "2", title: "Groceries list" },
      { id: "3", title: "Notes" },
      { id: "4", title: "More groceries" },
    ];
    expect(titleMatchesFirst(items, "GROCERIES", (item) => item.title).map((item) => item.id)).toEqual([
      "2",
      "4",
      "1",
      "3",
    ]);
    expect(titleMatchesFirst(items, " ", (item) => item.title)).toBe(items);
  });
});
