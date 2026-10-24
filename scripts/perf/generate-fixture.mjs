#!/usr/bin/env node
// Deterministic fixture generator for the perf harness.
//
// Builds a support folder holding notes.sqlite without starting the helper, using the
// schema in docs/architecture.md section 6 and the fold rule in section 5.
// The same seed always builds the same database, apart from nothing at all: timestamps,
// ids, titles, and bodies are all derived from the seed and the note index.
//
// Usage:
//   node scripts/perf/generate-fixture.mjs --notes 1000 --out <dir>
//   node scripts/perf/generate-fixture.mjs --bytes 512000 --out <dir>
//   node scripts/perf/generate-fixture.mjs --notes 100 --large-bytes 51200 --out <dir>
//
// Output layout:
//   <dir>/support/notes.sqlite
//   <dir>/manifest.json
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const noteCount = Number(arg("notes", "0"));
const singleBytes = Number(arg("bytes", "0"));
const largeBytes = Number(arg("large-bytes", "0"));
const seed = Number(arg("seed", "20261024"));
const out = arg("out", null);
if (!out || (!noteCount && !singleBytes)) {
  console.error("usage: generate-fixture.mjs --notes N [--large-bytes B] --out DIR | --bytes B --out DIR");
  process.exit(64);
}

// mulberry32: tiny deterministic PRNG, stable across Node versions.
function rng(seedValue) {
  let a = seedValue >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const fold = (v) => v.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
const sqlStr = (v) => `'${String(v).replaceAll("'", "''")}'`;

// Crockford base32 ULID: 10 chars of millisecond time plus 16 chars of counter.
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function ulid(timeMs, counter) {
  let t = BigInt(timeMs);
  let timePart = "";
  for (let i = 0; i < 10; i++) {
    timePart = CROCKFORD[Number(t % 32n)] + timePart;
    t /= 32n;
  }
  let c = BigInt(counter);
  let randPart = "";
  for (let i = 0; i < 16; i++) {
    randPart = CROCKFORD[Number(c % 32n)] + randPart;
    c /= 32n;
  }
  return timePart + randPart;
}

const WORDS = [
  "alpha",
  "bravo",
  "charlie",
  "delta",
  "ember",
  "fjord",
  "granite",
  "harbor",
  "ink",
  "juniper",
  "keepsake",
  "lantern",
  "meadow",
  "north",
  "onyx",
  "prairie",
  "quartz",
  "river",
  "sable",
  "timber",
  "umbrella",
  "velvet",
  "willow",
  "xenon",
  "yellow",
  "zephyr",
  "garden",
  "market",
  "notebook",
  "pencil",
  "window",
  "bridge",
];
const BASE_MS = 1_700_000_000_000;

function bodyFor(rand, paragraphs, wordsPerParagraph) {
  const lines = [];
  for (let p = 0; p < paragraphs; p++) {
    const words = [];
    for (let w = 0; w < wordsPerParagraph; w++) words.push(WORDS[Math.floor(rand() * WORDS.length)]);
    lines.push(words.join(" "));
  }
  return lines.join("\n");
}

function sizedText(title, targetBytes) {
  // One title line plus filler lines of about 72 bytes, trimmed to the target size.
  // Size is measured in UTF-8 bytes, the way a person would quote a note size on disk.
  const filler = "The quick brown fox jumps over the lazy dog while the notes panel stays ready. ";
  let text = `${title}\n`;
  while (Buffer.byteLength(text, "utf8") < targetBytes) text += filler;
  const buf = Buffer.from(text, "utf8").subarray(0, targetBytes);
  return buf.toString("utf8");
}

function docJson(text) {
  const content = text.split("\n").map((line) => ({
    type: "paragraph",
    content: line ? [{ type: "text", text: line }] : [],
  }));
  return JSON.stringify({ type: "doc", content });
}

function noteRow({ id, title, text, createdAt, pinned }) {
  const markdown = text;
  const raw = docJson(text);
  return (
    `(${sqlStr(id)}, ${sqlStr(title)}, ${sqlStr(text)}, ${sqlStr(markdown)}, ${sqlStr(raw)}, ` +
    `${sqlStr(fold(title))}, ${sqlStr(fold(text))}, ${pinned === null ? "NULL" : pinned}, ` +
    `${createdAt}, ${createdAt}, NULL, ${createdAt}, 0)`
  );
}

const support = path.join(out, "support");
fs.mkdirSync(support, { recursive: true });
const dbPath = path.join(support, "notes.sqlite");
for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(dbPath + suffix, { force: true });

const rand = rng(seed);
const rows = [];
const ids = [];
let needleTitleId = null;
let needleTextId = null;
let diacriticId = null;
let largeNoteId = null;
let largeNoteBytes = 0;

if (singleBytes > 0) {
  const title = `Large note ${singleBytes}`;
  const text = sizedText(title, singleBytes);
  const id = ulid(BASE_MS, 1);
  largeNoteId = id;
  largeNoteBytes = Buffer.byteLength(text, "utf8");
  rows.push(noteRow({ id, title, text, createdAt: BASE_MS, pinned: null }));
  ids.push(id);
} else {
  for (let i = 0; i < noteCount; i++) {
    const createdAt = BASE_MS + i * 1000;
    const id = ulid(createdAt, i + 1);
    ids.push(id);
    let title = `Note ${i} ${WORDS[Math.floor(rand() * WORDS.length)]}`;
    let text = `${title}\n${bodyFor(rand, 3, 14)}`;
    // Sparse needles with known placement, so filtered search has a truthful target.
    if (i % 500 === 250) {
      title = `Quixotic title ${i}`;
      text = `${title}\n${text.split("\n").slice(1).join("\n")}`;
      needleTitleId = needleTitleId ?? id;
    }
    if (i % 100 === 42) {
      text += "\na quixotic paragraph hides in this note";
      if (!needleTextId) needleTextId = id;
    }
    if (i % 250 === 7) {
      title = `Café Über note ${i}`;
      text = `${title}\n${text.split("\n").slice(1).join("\n")}`;
      diacriticId = diacriticId ?? id;
    }
    const pinned = i < 5 ? (i + 1) * 1000 : null;
    rows.push(noteRow({ id, title, text, createdAt, pinned }));
  }
  if (largeBytes > 0) {
    const title = `Large note ${largeBytes}`;
    const text = sizedText(title, largeBytes);
    const id = ulid(BASE_MS + noteCount * 1000, noteCount + 1);
    largeNoteId = id;
    largeNoteBytes = Buffer.byteLength(text, "utf8");
    rows.push(noteRow({ id, title, text, createdAt: BASE_MS + noteCount * 1000, pinned: null }));
    ids.push(id);
  }
}

const schema = `
CREATE TABLE notes (
  id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', text TEXT NOT NULL DEFAULT '',
  markdown TEXT NOT NULL DEFAULT '', raw_content TEXT NOT NULL,
  title_fold TEXT NOT NULL DEFAULT '', text_fold TEXT NOT NULL DEFAULT '',
  pinned REAL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  deleted_at INTEGER, last_accessed_at INTEGER, caret_position INTEGER,
  sort_pin_group INTEGER GENERATED ALWAYS AS (pinned IS NULL) VIRTUAL,
  sort_pin_key REAL GENERATED ALWAYS AS (COALESCE(pinned, 0.0)) VIRTUAL,
  sort_updated_neg INTEGER GENERATED ALWAYS AS (-updated_at) VIRTUAL,
  sort_accessed_neg INTEGER GENERATED ALWAYS AS (-COALESCE(last_accessed_at, -1)) VIRTUAL
) STRICT, WITHOUT ROWID;
CREATE INDEX notes_list_order ON notes (deleted_at, pinned, updated_at DESC, id);
CREATE INDEX notes_browse_order ON notes (deleted_at, pinned, last_accessed_at DESC, id);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE INDEX notes_list_page ON notes (deleted_at, sort_pin_group, sort_pin_key, sort_updated_neg, id);
CREATE INDEX notes_browse_page ON notes (deleted_at, sort_pin_group, sort_pin_key, sort_accessed_neg, id);
CREATE VIRTUAL TABLE notes_fts USING fts5(id UNINDEXED, title_fold, text_fold, tokenize = 'trigram');
CREATE TRIGGER notes_fts_after_insert AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts (id, title_fold, text_fold) VALUES (NEW.id, NEW.title_fold, NEW.text_fold);
END;
CREATE TRIGGER notes_fts_after_update AFTER UPDATE OF title_fold, text_fold ON notes BEGIN
  DELETE FROM notes_fts WHERE id = OLD.id;
  INSERT INTO notes_fts (id, title_fold, text_fold) VALUES (NEW.id, NEW.title_fold, NEW.text_fold);
END;
CREATE TRIGGER notes_fts_after_delete AFTER DELETE ON notes BEGIN
  DELETE FROM notes_fts WHERE id = OLD.id;
END;
PRAGMA user_version = 2;
`;

const CHUNK = 500;
let insertSql = "";
for (let i = 0; i < rows.length; i += CHUNK) {
  insertSql +=
    "INSERT INTO notes (id, title, text, markdown, raw_content, title_fold, text_fold, pinned, created_at, updated_at, deleted_at, last_accessed_at, caret_position) VALUES\n" +
    rows.slice(i, i + CHUNK).join(",\n") +
    ";\n";
}
const sqlPath = path.join(out, "fixture.sql");
fs.writeFileSync(
  sqlPath,
  `PRAGMA journal_mode = WAL;\nBEGIN;\n${schema}\n${insertSql}COMMIT;\nPRAGMA wal_checkpoint(TRUNCATE);\nPRAGMA journal_mode = DELETE;\n`,
);
execFileSync("sqlite3", [dbPath], { input: fs.readFileSync(sqlPath) });
fs.rmSync(sqlPath);

const manifest = {
  kind: singleBytes > 0 ? "large" : "count",
  seed,
  noteCount: singleBytes > 0 ? 1 : noteCount,
  largeBytes: singleBytes > 0 ? largeNoteBytes : largeBytes || null,
  largeNoteBytesActual: largeNoteId ? largeNoteBytes : null,
  largeNoteId,
  firstId: ids[0] ?? null,
  lastId: ids.at(-1) ?? null,
  needleTitleId,
  needleTextId,
  diacriticId,
  pinnedCount: singleBytes > 0 ? 0 : Math.min(5, noteCount),
  dbBytes: fs.statSync(dbPath).size,
  search: { sparseTerm: "quixotic", foldedTerm: "cafe", foldedQuery: "CAFÉ", commonTerm: "note" },
};
fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(
  `[perf] fixture notes=${manifest.noteCount} largeBytes=${manifest.largeNoteBytesActual ?? 0} dbBytes=${manifest.dbBytes} out=${out}`,
);
