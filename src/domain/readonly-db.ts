import fs from "node:fs";

import { likeSubstringPattern, normalizeFilter } from "./fold";
import type { DeletedNoteSummary, ListParams, Note, NoteSummary, Page } from "./types";

type SqliteModule = typeof import("node:sqlite");
type DatabaseSync = InstanceType<SqliteModule["DatabaseSync"]>;
type Row = Record<string, unknown>;

const DEFAULT_LIMIT = 100;

const SUMMARY_COLUMNS = `id, title, substr(text, 1, 200) AS preview, length(text) AS char_count, pinned,
  created_at, updated_at, deleted_at, last_accessed_at`;

const LIST_SQL = `SELECT ${SUMMARY_COLUMNS} FROM notes
  WHERE deleted_at IS NULL
  ORDER BY pinned IS NULL, pinned ASC, updated_at DESC, id ASC
  LIMIT ? OFFSET ?`;

const LIST_FILTERED_SQL = `SELECT ${SUMMARY_COLUMNS} FROM notes
  WHERE deleted_at IS NULL AND (title_fold LIKE ?1 ESCAPE '\\' OR text_fold LIKE ?1 ESCAPE '\\')
  ORDER BY pinned IS NULL, pinned ASC, updated_at DESC, id ASC
  LIMIT ?2 OFFSET ?3`;

let sqliteModule: SqliteModule | null = null;

/**
 * Loads `node:sqlite` on first use while muting its one-time ExperimentalWarning, which would
 * otherwise land in the extension log on every launch. Other warnings pass through.
 */
export function loadSqlite(): SqliteModule {
  if (sqliteModule) return sqliteModule;
  const original = process.emitWarning;
  process.emitWarning = function (this: NodeJS.Process, warning: string | Error, ...rest: unknown[]) {
    const text = typeof warning === "string" ? warning : warning.message;
    const type = typeof rest[0] === "string" ? rest[0] : (rest[0] as { type?: string } | undefined)?.type;
    const name = typeof warning === "string" ? type : warning.name;
    if (name === "ExperimentalWarning" && /sqlite/i.test(text)) return;
    return (original as (...args: unknown[]) => void).call(this, warning, ...rest);
  } as typeof process.emitWarning;
  try {
    sqliteModule = process.getBuiltinModule("node:sqlite");
  } finally {
    process.emitWarning = original;
  }
  return sqliteModule;
}

/**
 * Read-only view of the helper's database (docs/architecture.md section 6), for instant lists and search when
 * the helper is not running. Every query is parameterized; nothing here writes.
 */
export class ReadOnlyNotesDb {
  private constructor(private readonly db: DatabaseSync) {}

  /** Opens the database, or returns null when the helper has not created it yet. */
  static open(file: string): ReadOnlyNotesDb | null {
    if (!fs.existsSync(file)) return null;
    const { DatabaseSync } = loadSqlite();
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      db.exec("PRAGMA query_only = ON");
      db.exec("PRAGMA busy_timeout = 1000");
    } catch (error) {
      db.close();
      throw error;
    }
    return new ReadOnlyNotesDb(db);
  }

  close(): void {
    this.db.close();
  }

  /**
   * Live notes in `notes.list` order: pinned key asc (pinned first), then `updated_at` desc, then
   * `id` asc. A filter is a folded substring match on title or text. The cursor is an offset.
   */
  list(options: ListParams = {}): Page<NoteSummary> {
    const limit = clampLimit(options.limit);
    const offset = parseCursor(options.cursor);
    const filter = normalizeFilter(options.filter);
    const rows = (
      filter === undefined
        ? this.db.prepare(LIST_SQL).all(limit + 1, offset)
        : this.db.prepare(LIST_FILTERED_SQL).all(likeSubstringPattern(filter), limit + 1, offset)
    ) as Row[];
    const items = rows.slice(0, limit).map(toSummary);
    return { items, nextCursor: rows.length > limit ? String(offset + limit) : null };
  }

  /** Every trashed note with its markdown and stored document, most recently deleted first (protocol `notes.listDeleted`). */
  listDeleted(): DeletedNoteSummary[] {
    const rows = this.db
      .prepare(
        `SELECT id, title, substr(text, 1, 200) AS preview, length(text) AS char_count, markdown, raw_content, pinned,
                created_at, updated_at, deleted_at, last_accessed_at
           FROM notes
          WHERE deleted_at IS NOT NULL
          ORDER BY deleted_at DESC, id ASC`,
      )
      .all() as Row[];
    return rows.map((row) => ({
      ...toSummary(row),
      markdown: String(row.markdown ?? ""),
      rawContent: String(row.raw_content ?? ""),
    }));
  }

  get(id: string): Note | null {
    const row = this.db
      .prepare(
        `SELECT id, title, text, markdown, raw_content, pinned, created_at, updated_at, deleted_at,
                last_accessed_at, caret_position
           FROM notes WHERE id = ?`,
      )
      .get(id) as Row | undefined;
    return row ? toNote(row) : null;
  }

  count(): number {
    const row = this.db.prepare("SELECT count(*) AS count FROM notes WHERE deleted_at IS NULL").get() as Row;
    return Number(row.count);
  }
}

function parseCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const offset = Number.parseInt(cursor, 10);
  return Number.isInteger(offset) && offset > 0 ? offset : 0;
}

function clampLimit(limit: number | undefined): number {
  const value = Math.trunc(limit ?? DEFAULT_LIMIT);
  return Math.min(Math.max(value, 1), 500);
}

function toSummary(row: Row): NoteSummary {
  return {
    id: String(row.id),
    title: String(row.title ?? ""),
    preview: String(row.preview ?? ""),
    charCount: Number(row.char_count ?? 0),
    pinned: nullableNumber(row.pinned),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    deletedAt: nullableNumber(row.deleted_at),
    lastAccessedAt: nullableNumber(row.last_accessed_at),
  };
}

function toNote(row: Row): Note {
  return {
    id: String(row.id),
    title: String(row.title ?? ""),
    text: String(row.text ?? ""),
    markdown: String(row.markdown ?? ""),
    rawContent: String(row.raw_content ?? ""),
    pinned: nullableNumber(row.pinned),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    deletedAt: nullableNumber(row.deleted_at),
    lastAccessedAt: nullableNumber(row.last_accessed_at),
    caretPosition: nullableNumber(row.caret_position),
  };
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}
