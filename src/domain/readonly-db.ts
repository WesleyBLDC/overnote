import fs from "node:fs";

import { foldForMatch, likeSubstringPattern, normalizeFilter } from "./fold";
import type { DeletedNoteSummary, ListParams, Note, NoteSummary, Page } from "./types";

type SqliteModule = typeof import("node:sqlite");
type DatabaseSync = InstanceType<SqliteModule["DatabaseSync"]>;
type Row = Record<string, unknown>;

const DEFAULT_LIMIT = 100;

const SUMMARY_COLUMNS = `id, title, substr(text, 1, 200) AS preview, length(text) AS char_count, pinned,
  created_at, updated_at, deleted_at, last_accessed_at`;

/**
 * The `notes.list` order, and the same order spelled over the schema version 2 generated sort
 * columns. The generated columns are defined as exactly this order (`sort_pin_group` is
 * `pinned IS NULL`, `sort_pin_key` is the pin key, `sort_updated_neg` is the negated update
 * time), so the two spellings return the same rows in the same order, and the version 2
 * spelling is the one the `notes_list_page` paging index holds, which lets SQLite read a page
 * in order instead of sorting the whole table first.
 */
const LIST_ORDER = `pinned IS NULL, pinned ASC, updated_at DESC, id ASC`;
const LIST_ORDER_V2 = `sort_pin_group ASC, sort_pin_key ASC, sort_updated_neg ASC, id ASC`;
const FTS_LIST_ORDER = `notes.pinned IS NULL, notes.pinned ASC, notes.updated_at DESC, notes.id ASC`;
const FTS_LIST_ORDER_V2 = `notes.sort_pin_group ASC, notes.sort_pin_key ASC, notes.sort_updated_neg ASC, notes.id ASC`;

const LIST_SQL = `SELECT ${SUMMARY_COLUMNS} FROM notes
  WHERE deleted_at IS NULL
  ORDER BY ${LIST_ORDER}
  LIMIT ? OFFSET ?`;

const LIST_SQL_V2 = `SELECT ${SUMMARY_COLUMNS} FROM notes
  WHERE deleted_at IS NULL
  ORDER BY ${LIST_ORDER_V2}
  LIMIT ? OFFSET ?`;

const LIST_FILTERED_SQL = `SELECT ${SUMMARY_COLUMNS} FROM notes
  WHERE deleted_at IS NULL AND (title_fold LIKE ?1 ESCAPE '\\' OR text_fold LIKE ?1 ESCAPE '\\')
  ORDER BY ${LIST_ORDER}
  LIMIT ?2 OFFSET ?3`;

const LIST_FILTERED_SQL_V2 = `SELECT ${SUMMARY_COLUMNS} FROM notes
  WHERE deleted_at IS NULL AND (title_fold LIKE ?1 ESCAPE '\\' OR text_fold LIKE ?1 ESCAPE '\\')
  ORDER BY ${LIST_ORDER_V2}
  LIMIT ?2 OFFSET ?3`;

const FTS_SUMMARY_COLUMNS = `notes.id, notes.title, substr(notes.text, 1, 200) AS preview, length(notes.text) AS char_count, notes.pinned,
  notes.created_at, notes.updated_at, notes.deleted_at, notes.last_accessed_at`;

/**
 * The helper query shape from docs/architecture.md section 5, mirrored for the fallback: the
 * FTS5 trigram index only narrows the candidate set, and the same escaped folded `LIKE`
 * predicate is then applied to those candidates, so the result set is the `LIKE` result set by
 * construction. Ordering is the `notes.list` order, never an index rank.
 */
const LIST_FILTERED_FTS_SQL = `SELECT ${FTS_SUMMARY_COLUMNS}
  FROM notes_fts CROSS JOIN notes ON notes.id = notes_fts.id
  WHERE notes.deleted_at IS NULL AND notes_fts MATCH ?1
    AND (notes.title_fold LIKE ?2 ESCAPE '\\' OR notes.text_fold LIKE ?2 ESCAPE '\\')
  ORDER BY ${FTS_LIST_ORDER}
  LIMIT ?3 OFFSET ?4`;

const LIST_FILTERED_FTS_SQL_V2 = `SELECT ${FTS_SUMMARY_COLUMNS}
  FROM notes_fts CROSS JOIN notes ON notes.id = notes_fts.id
  WHERE notes.deleted_at IS NULL AND notes_fts MATCH ?1
    AND (notes.title_fold LIKE ?2 ESCAPE '\\' OR notes.text_fold LIKE ?2 ESCAPE '\\')
  ORDER BY ${FTS_LIST_ORDER_V2}
  LIMIT ?3 OFFSET ?4`;

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
  /** Whether the opened database has a `notes_fts` table, once looked up; false after a failed `MATCH`. */
  private ftsAvailable: boolean | null = null;

  /** Whether the opened database has the schema version 2 paging indexes, once looked up. */
  private pagingIndexAvailable: boolean | null = null;

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
   * `id` asc. A filter is a folded substring match on title or text.
   *
   * The cursor stays the offset this fallback has always issued. Architecture requires a cursor
   * to be valid only for the source that issued it, so the fallback may not adopt the helper
   * keyset format, and changing the offset format would strand cursors this fallback already
   * handed out. On a schema version 2 database the order is spelled over the generated sort
   * columns the paging indexes hold, so a page is read in index order instead of sorting the
   * whole table first. Deep offset paging is this fallback's structural gap: a page deep in
   * the list still walks every row before it, where a keyset cursor would seek straight to it. For a
   * filtered list the FTS narrowing below removes the matching scan, so an offset walk over
   * the narrowed candidates stays cheap at any depth.
   */
  list(options: ListParams = {}): Page<NoteSummary> {
    const limit = clampLimit(options.limit);
    const offset = parseCursor(options.cursor);
    const filter = normalizeFilter(options.filter);
    const rows = (
      filter === undefined
        ? this.db.prepare(this.hasPagingIndex() ? LIST_SQL_V2 : LIST_SQL).all(limit + 1, offset)
        : this.filteredRows(filter, limit + 1, offset)
    ) as Row[];
    const items = rows.slice(0, limit).map(toSummary);
    return { items, nextCursor: rows.length > limit ? String(offset + limit) : null };
  }

  /**
   * One filtered page. A folded term of at least three Unicode scalars first narrows candidates
   * through `notes_fts` when the opened database has that table, exactly as the helper does, and
   * the escaped folded `LIKE` predicate then decides membership, so both paths return the same
   * rows in the same order. Shorter terms, databases without the table (schema version 1, or
   * version 2 built where the trigram tokenizer was unavailable), and a `MATCH` that fails for
   * any reason all keep the pure `LIKE` path.
   */
  private filteredRows(filter: string, pageSize: number, offset: number): Row[] {
    const pattern = likeSubstringPattern(filter);
    const paging = this.hasPagingIndex();
    if (canUseFts(foldForMatch(filter)) && this.hasFtsTable()) {
      try {
        // `?2` is bound once and used for both LIKE branches, so four values fill `?1` to `?4`.
        return this.db
          .prepare(paging ? LIST_FILTERED_FTS_SQL_V2 : LIST_FILTERED_FTS_SQL)
          .all(ftsPhrase(foldForMatch(filter)), pattern, pageSize, offset) as Row[];
      } catch {
        // The table exists but cannot answer, for example a non FTS table of that name or an
        // index built without the trigram tokenizer. Never fail a search the LIKE scan can answer.
        this.ftsAvailable = false;
      }
    }
    return this.db.prepare(paging ? LIST_FILTERED_SQL_V2 : LIST_FILTERED_SQL).all(pattern, pageSize, offset) as Row[];
  }

  /** Whether the opened database carries the schema version 2 paging indexes, looked up once. */
  private hasPagingIndex(): boolean {
    if (this.pagingIndexAvailable === null) {
      try {
        const row = this.db
          .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'index' AND name = 'notes_list_page' LIMIT 1")
          .get() as Row | undefined;
        this.pagingIndexAvailable = row !== undefined;
      } catch {
        this.pagingIndexAvailable = false;
      }
    }
    return this.pagingIndexAvailable;
  }

  /** Whether the opened database carries the schema version 2 FTS table, looked up once. */
  private hasFtsTable(): boolean {
    if (this.ftsAvailable === null) {
      try {
        const row = this.db
          .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'notes_fts' LIMIT 1")
          .get() as Row | undefined;
        this.ftsAvailable = row !== undefined;
      } catch {
        this.ftsAvailable = false;
      }
    }
    return this.ftsAvailable;
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

/**
 * Whether the trigram index can narrow this folded term, mirroring the helper rule in
 * docs/architecture.md section 5: the tokenizer only forms an indexable gram from three or more
 * Unicode scalars. Spread counts code points, which equals the scalar count for the well formed
 * text folding produces and search callers pass.
 */
function canUseFts(foldedTerm: string): boolean {
  return [...foldedTerm].length >= 3;
}

/** The FTS5 phrase for a folded term, with embedded quotes doubled, as the helper builds it. */
function ftsPhrase(foldedTerm: string): string {
  return `"${foldedTerm.replace(/"/g, '""')}"`;
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
