/**
 * The read-only fallback against fixture databases built with the schema from
 * docs/architecture.md section 6. The helper semantics these tests pin are the ones that
 * document states for `notes.list`: pinned key asc (pinned first), then `updatedAt` desc, then
 * `id` asc, with a folded substring match on title or text. Every variant database holds the
 * same notes, so a query must return the same ids in the same order whether it took the FTS5
 * trigram path, the folded `LIKE` path, or the retry after a failed `MATCH`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { foldForMatch } from "../domain/fold";
import { loadSqlite, ReadOnlyNotesDb } from "../domain/readonly-db";

type FixtureNote = {
  id: string;
  title: string;
  text: string;
  pinned: number | null;
  updatedAt: number;
  deletedAt?: number | null;
};

const NOTES: FixtureNote[] = [
  { id: "note-emoji", title: "😀 Happy", text: "😀 Happy\n👍🏽 yes, 😀 happy again", pinned: null, updatedAt: 7000 },
  {
    id: "note-wild",
    title: "Progress",
    text: "Progress\n100% done_now and under_score",
    pinned: null,
    updatedAt: 6000,
  },
  { id: "note-cafe", title: "Café list", text: "Café list\nÜber milk and eggs", pinned: 1000, updatedAt: 5000 },
  {
    id: "note-groceries",
    title: "Groceries",
    text: "Groceries\nAsk about the cafe hours and the ﬁle cabinet",
    pinned: null,
    updatedAt: 4000,
  },
  {
    id: "note-ligature",
    title: "ﬀect report",
    text: "ﬀect report\nthe ﬁle opens slowly",
    pinned: null,
    updatedAt: 3000,
  },
  { id: "note-cjk", title: "中文標題", text: "中文標題\n東京のメモ中文", pinned: null, updatedAt: 2000 },
  {
    id: "note-quote",
    title: 'Don\'t "quote" me',
    text: 'Don\'t "quote" me\nback\\slash path',
    pinned: null,
    updatedAt: 1500,
  },
  { id: "note-strasse", title: "Straße walk", text: "Straße walk\nan angstrom walk", pinned: null, updatedAt: 1000 },
  { id: "note-pinned-cafe", title: "Pinned Café", text: "Pinned Café\nsecond pin", pinned: 2000, updatedAt: 500 },
  {
    id: "note-trash",
    title: "Café trash",
    text: "Café trash\nthe cafe in trash",
    pinned: null,
    updatedAt: 9000,
    deletedAt: 9000,
  },
];

/** The documented `notes.list` semantics, computed from the folded copies the way core folds. */
function referenceIds(notes: FixtureNote[], filter?: string): string[] {
  const query = filter?.trim() ? foldForMatch(filter.trim()) : undefined;
  return notes
    .filter((note) => note.deletedAt == null)
    .filter(
      (note) =>
        query === undefined || foldForMatch(note.title).includes(query) || foldForMatch(note.text).includes(query),
    )
    .sort((a, b) => {
      const pinGroup = Number(a.pinned === null) - Number(b.pinned === null);
      if (pinGroup !== 0) return pinGroup;
      const pinKey = (a.pinned ?? 0) - (b.pinned ?? 0);
      if (pinKey !== 0) return pinKey;
      if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    })
    .map((note) => note.id);
}

const NOTES_TABLE_V2 = `CREATE TABLE notes (
  id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', text TEXT NOT NULL DEFAULT '',
  markdown TEXT NOT NULL DEFAULT '', raw_content TEXT NOT NULL,
  title_fold TEXT NOT NULL DEFAULT '', text_fold TEXT NOT NULL DEFAULT '',
  pinned REAL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  deleted_at INTEGER, last_accessed_at INTEGER, caret_position INTEGER,
  sort_pin_group INTEGER GENERATED ALWAYS AS (pinned IS NULL) VIRTUAL,
  sort_pin_key REAL GENERATED ALWAYS AS (COALESCE(pinned, 0.0)) VIRTUAL,
  sort_updated_neg INTEGER GENERATED ALWAYS AS (-updated_at) VIRTUAL,
  sort_accessed_neg INTEGER GENERATED ALWAYS AS (-COALESCE(last_accessed_at, -1)) VIRTUAL
) STRICT, WITHOUT ROWID;`;

const NOTES_TABLE_V1 = `CREATE TABLE notes (
  id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', text TEXT NOT NULL DEFAULT '',
  markdown TEXT NOT NULL DEFAULT '', raw_content TEXT NOT NULL,
  title_fold TEXT NOT NULL DEFAULT '', text_fold TEXT NOT NULL DEFAULT '',
  pinned REAL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  deleted_at INTEGER, last_accessed_at INTEGER, caret_position INTEGER
) STRICT, WITHOUT ROWID;`;

const ORDER_INDEXES = `CREATE INDEX notes_list_order ON notes (deleted_at, pinned, updated_at DESC, id);
  CREATE INDEX notes_browse_order ON notes (deleted_at, pinned, last_accessed_at DESC, id);
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;`;

const PAGING_INDEXES = `CREATE INDEX notes_list_page ON notes (deleted_at, sort_pin_group, sort_pin_key, sort_updated_neg, id);
  CREATE INDEX notes_browse_page ON notes (deleted_at, sort_pin_group, sort_pin_key, sort_accessed_neg, id);`;

const FTS = `CREATE VIRTUAL TABLE notes_fts USING fts5(id UNINDEXED, title_fold, text_fold, tokenize = 'trigram');
  CREATE TRIGGER notes_fts_after_insert AFTER INSERT ON notes BEGIN
    INSERT INTO notes_fts (id, title_fold, text_fold) VALUES (NEW.id, NEW.title_fold, NEW.text_fold);
  END;
  CREATE TRIGGER notes_fts_after_update AFTER UPDATE OF title_fold, text_fold ON notes BEGIN
    DELETE FROM notes_fts WHERE id = OLD.id;
    INSERT INTO notes_fts (id, title_fold, text_fold) VALUES (NEW.id, NEW.title_fold, NEW.text_fold);
  END;
  CREATE TRIGGER notes_fts_after_delete AFTER DELETE ON notes BEGIN
    DELETE FROM notes_fts WHERE id = OLD.id;
  END;`;

type Variant = "v2-fts" | "v1" | "v2-no-fts" | "broken-fts";

function schemaFor(variant: Variant): string {
  if (variant === "v1") return `${NOTES_TABLE_V1}\n${ORDER_INDEXES}\nPRAGMA user_version = 1;`;
  const base = `${NOTES_TABLE_V2}\n${ORDER_INDEXES}\n${PAGING_INDEXES}`;
  if (variant === "v2-fts") return `${base}\n${FTS}\nPRAGMA user_version = 2;`;
  if (variant === "broken-fts") {
    // A table of the right name that is not an FTS table at all, so every MATCH fails and the
    // fallback must retry with the folded LIKE scan rather than fail the search.
    return `${base}\nCREATE TABLE notes_fts (id TEXT, title_fold TEXT, text_fold TEXT);\nPRAGMA user_version = 2;`;
  }
  return `${base}\nPRAGMA user_version = 2;`;
}

const roots: string[] = [];

function buildDatabase(variant: Variant, notes: FixtureNote[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `overnote-readonly-${variant}-`));
  roots.push(root);
  const file = path.join(root, "notes.sqlite");
  const { DatabaseSync } = loadSqlite();
  const db = new DatabaseSync(file);
  try {
    db.exec(schemaFor(variant));
    const insert = db.prepare(
      `INSERT INTO notes (id, title, text, markdown, raw_content, title_fold, text_fold, pinned,
         created_at, updated_at, deleted_at, last_accessed_at, caret_position)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    );
    for (const note of notes) {
      insert.run(
        note.id,
        note.title,
        note.text,
        note.text,
        "{}",
        foldForMatch(note.title),
        foldForMatch(note.text),
        note.pinned,
        note.updatedAt,
        note.updatedAt,
        note.deletedAt ?? null,
        note.updatedAt,
      );
    }
  } finally {
    db.close();
  }
  return file;
}

function withDb<T>(file: string, work: (db: ReadOnlyNotesDb) => T): T {
  const db = ReadOnlyNotesDb.open(file);
  expect(db).not.toBeNull();
  try {
    return work(db as ReadOnlyNotesDb);
  } finally {
    db?.close();
  }
}

const QUERIES = [
  "CAFÉ",
  "cafe",
  "Café list",
  "ﬁle",
  "file",
  "ﬀect",
  "ffect",
  "100% done",
  "%",
  "_",
  "done_now",
  "under_score",
  "中文標",
  "中文",
  "😀",
  "😀 happy",
  "👍🏽",
  "don't",
  '"quote"',
  "back\\slash",
  "straße",
  "STRASSE",
  "é",
  "nothing matches this",
];

describe("read-only fallback open", () => {
  it("surfaces a file that is not a database at open, not at the first query", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "overnote-readonly-corrupt-"));
    roots.push(root);
    const file = path.join(root, "notes.sqlite");
    fs.writeFileSync(file, "not a database, only padding text........................");
    expect(() => ReadOnlyNotesDb.open(file)).toThrow();
  });
});

describe("read-only fallback filtered lists", () => {
  const files = new Map<Variant, string>();

  beforeAll(() => {
    for (const variant of ["v2-fts", "v1", "v2-no-fts", "broken-fts"] as Variant[]) {
      files.set(variant, buildDatabase(variant, NOTES));
    }
  });

  afterAll(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it("returns the same ids in the same order on every database variant", () => {
    for (const [variant, file] of files) {
      withDb(file, (db) => {
        expect(
          db.list().items.map((note) => note.id),
          variant,
        ).toEqual(referenceIds(NOTES));
        for (const query of QUERIES) {
          expect(
            db.list({ filter: query }).items.map((note) => note.id),
            `${variant} ${JSON.stringify(query)}`,
          ).toEqual(referenceIds(NOTES, query));
        }
      });
    }
  });

  it("pages a filtered list through the fallback cursor with no gaps or repeats", () => {
    withDb(files.get("v2-fts") as string, (db) => {
      for (const query of ["cafe", "😀 happy", "中文", "e"]) {
        const paged: string[] = [];
        let cursor: string | undefined;
        do {
          const page = db.list({ filter: query, limit: 2, cursor });
          paged.push(...page.items.map((note) => note.id));
          cursor = page.nextCursor ?? undefined;
        } while (cursor);
        expect(paged, JSON.stringify(query)).toEqual(referenceIds(NOTES, query));
        expect(new Set(paged).size).toBe(paged.length);
      }
    });
  });

  it("narrows through the index for terms of three scalars and scans for shorter ones", () => {
    // Remove one note's index row behind the triggers' back: only a query that really narrows
    // through notes_fts loses it, while a two scalar term keeps the LIKE scan and still finds it.
    const file = buildDatabase("v2-fts", NOTES);
    const { DatabaseSync } = loadSqlite();
    const writer = new DatabaseSync(file);
    try {
      writer.exec("DELETE FROM notes_fts WHERE id = 'note-pinned-cafe'");
    } finally {
      writer.close();
    }
    withDb(file, (db) => {
      const ids = (filter: string) => db.list({ filter }).items.map((note) => note.id);
      expect(ids("pinned café")).toEqual([]);
      expect(ids("cafe")).toEqual(referenceIds(NOTES, "cafe").filter((id) => id !== "note-pinned-cafe"));
      expect(ids("ca")).toContain("note-pinned-cafe");
    });
  });

  it("keeps the shared fold corpus searchable on the FTS path", () => {
    const corpus = JSON.parse(
      fs.readFileSync(
        path.join(path.dirname(fileURLToPath(import.meta.url)), "../../packages/core/tests/fold-corpus.json"),
        "utf8",
      ),
    ) as { input: string; folded: string }[];
    const notes: FixtureNote[] = corpus.map((entry, index) => ({
      id: `corpus-${String(index).padStart(3, "0")}`,
      title: entry.input,
      text: `${entry.input}\nbody ${index}`,
      pinned: null,
      updatedAt: 100_000 - index,
    }));
    withDb(buildDatabase("v2-fts", notes), (db) => {
      corpus.forEach((entry, index) => {
        for (const query of [entry.input, entry.folded]) {
          const found = db.list({ filter: query, limit: 500 }).items.map((note) => note.id);
          expect(found, JSON.stringify(query)).toEqual(referenceIds(notes, query));
          expect(found).toContain(notes[index]?.id);
        }
      });
    });
  });
});
