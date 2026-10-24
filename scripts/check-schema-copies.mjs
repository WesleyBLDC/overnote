#!/usr/bin/env node
// Schema copy drift check.
//
// Schema version 2 SQL lives canonically in helper/Sources/OvernoteCore/Migrations.swift,
// and two test and fixture builders copy it by hand: scripts/perf/generate-fixture.mjs and
// src/__tests__/readonly-db.test.ts. Building a real database from each copy and comparing
// the resulting schema catches any drift between them, including a changed generated
// column expression, index definition, FTS tokenizer, or trigger body, while ignoring the
// formatting differences between the Swift, fixture, and test spellings.
//
// Usage: node scripts/check-schema-copies.mjs
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(relative) {
  return fs.readFileSync(path.join(root, relative), "utf8");
}

function swiftBlocks() {
  const source = read("helper/Sources/OvernoteCore/Migrations.swift");
  const blocks = [...source.matchAll(/"""\n([\s\S]*?)\n\s*"""/g)].map((match) => match[1]);
  if (blocks.length !== 3) throw new Error(`expected 3 SQL blocks in Migrations.swift, found ${blocks.length}`);
  return blocks; // version 1 sql, version 2 sql, version 2 ftsSQL
}

function perfSchema() {
  const source = read("scripts/perf/generate-fixture.mjs");
  const match = source.match(/const schema = `([\s\S]*?)`;/);
  if (!match) throw new Error("schema template not found in generate-fixture.mjs");
  return match[1];
}

function tsSchema() {
  const source = read("src/__tests__/readonly-db.test.ts");
  const constant = (name) => {
    const match = source.match(new RegExp(`const ${name} = \`([\\s\\S]*?)\`;`));
    if (!match) throw new Error(`${name} not found in readonly-db.test.ts`);
    return match[1];
  };
  // The v2-fts variant in schemaFor: base table and indexes, then the FTS table and triggers.
  return [
    constant("NOTES_TABLE_V2"),
    constant("ORDER_INDEXES"),
    constant("PAGING_INDEXES"),
    constant("FTS"),
    "PRAGMA user_version = 2;",
  ].join("\n");
}

function normalize(sql) {
  return sql
    .replace(/\s+/g, " ")
    .replace(/\s*([(),;])\s*/g, "$1")
    .trim()
    .replace(/;$/, "");
}

function canonicalSchema(sqlStatements) {
  const db = new DatabaseSync(":memory:");
  try {
    for (const sql of sqlStatements) db.exec(sql);
    const objects = db
      .prepare(
        "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type, name",
      )
      .all()
      .map((row) => `${row.type}|${row.name}|${row.tbl_name}|${normalize(String(row.sql))}`);
    const columns = db
      .prepare("PRAGMA table_xinfo(notes)")
      .all()
      .map((row) => `${row.name}:${row.type}:${row.hidden}:${row.dflt_value ?? ""}:${row.pk}`);
    const indexes = db
      .prepare("PRAGMA index_list(notes)")
      .all()
      .map((row) => {
        const parts = db
          .prepare(`PRAGMA index_xinfo(${JSON.stringify(String(row.name))})`)
          .all()
          .map((column) => `${column.seqno}:${column.cid}:${column.name}:${column.desc}:${column.coll}`);
        return `${row.name}:${row.unique}:${row.origin}|${parts.join(",")}`;
      })
      .sort();
    const version = db.prepare("PRAGMA user_version").get();
    return { objects, columns, indexes, userVersion: Number(version.user_version) };
  } finally {
    db.close();
  }
}

const [v1, v2, fts] = swiftBlocks();
const copies = {
  "Migrations.swift": canonicalSchema([v1, v2, fts, "PRAGMA user_version = 2;"]),
  "generate-fixture.mjs": canonicalSchema([perfSchema()]),
  "readonly-db.test.ts": canonicalSchema([tsSchema()]),
};

const [referenceName, ...otherNames] = Object.keys(copies);
const reference = copies[referenceName];
let failed = false;
for (const name of otherNames) {
  for (const section of ["objects", "columns", "indexes", "userVersion"]) {
    const expected = JSON.stringify(reference[section], null, 1);
    const actual = JSON.stringify(copies[name][section], null, 1);
    if (expected !== actual) {
      failed = true;
      console.error(`schema drift: ${name} differs from ${referenceName} in ${section}`);
      console.error(`--- ${referenceName}\n${expected}\n--- ${name}\n${actual}`);
    }
  }
}
if (failed) process.exit(1);
console.log(
  `[schema] copies agree: ${Object.keys(copies).join(", ")} (${reference.objects.length} objects, user_version ${reference.userVersion})`,
);
