#!/usr/bin/env node
// Serializer bench for @overnote/core at large note sizes.
//
// Plain Node cannot import the core TypeScript sources (extensionless imports), so this
// bundles packages/core/src/index.ts with the esbuild binary already in node_modules
// (a Vite dependency) into a temporary file, then imports that. No new dependency.
// When esbuild is absent the bench reports itself as skipped instead of failing.
//
// Usage: node scripts/perf/serializer-bench.mjs [--sizes 1024,51200,512000]
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const sizesArg = (process.argv.indexOf("--sizes") >= 0 ? process.argv[process.argv.indexOf("--sizes") + 1] : "1024,51200,512000");
const sizes = sizesArg.split(",").map(Number).filter(Boolean);

const esbuild = path.join(root, "node_modules", ".bin", "esbuild");
if (!fs.existsSync(esbuild)) {
  console.log(JSON.stringify({ skipped: "esbuild not found in node_modules/.bin; run npm install first" }, null, 2));
  process.exit(0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "overnote-serializer-bench-"));
try {
  const bundle = path.join(tmp, "core.mjs");
  execFileSync(esbuild, [
    path.join(root, "packages/core/src/index.ts"),
    "--bundle", "--format=esm", "--platform=node", `--outfile=${bundle}`, "--log-level=error",
  ], { stdio: "inherit" });
  const core = await import(pathToFileURL(bundle).href);

  function markdownOfSize(target) {
    const para = "The quick brown fox jumps over the lazy dog while a very long note keeps growing with ordinary prose, a few numbers 12345, and punctuation. ";
    let md = "# Large bench note\n\n";
    let i = 0;
    while (Buffer.byteLength(md, "utf8") < target) {
      if (i % 20 === 19) md += "- a task like item with some text\n";
      else md += para + "\n\n";
      i++;
    }
    return Buffer.from(md, "utf8").subarray(0, target).toString("utf8");
  }

  const stats = (samples) => {
    const s = [...samples].sort((a, b) => a - b);
    const pick = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
    const r = (v) => Math.round(v * 1000) / 1000;
    return { n: s.length, medianMs: r(pick(0.5)), p95Ms: r(pick(0.95)), minMs: r(s[0]), maxMs: r(s.at(-1)) };
  };
  async function bench(fn, reps) {
    fn(); // warmup
    const samples = [];
    for (let i = 0; i < reps; i++) {
      const t0 = process.hrtime.bigint();
      fn();
      samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    return stats(samples);
  }

  const results = [];
  for (const size of sizes) {
    const markdown = markdownOfSize(size);
    const reps = size > 100000 ? 7 : size > 10000 ? 15 : 30;
    const doc = core.markdownToDoc(markdown);
    const row = {
      targetBytes: size,
      actualBytes: Buffer.byteLength(markdown, "utf8"),
      noteContentFromMarkdown: await bench(() => core.noteContentFromMarkdown(markdown), reps),
      markdownToDoc: await bench(() => core.markdownToDoc(markdown), reps),
      buildNoteContentFromDoc: await bench(() => core.buildNoteContent(doc), reps),
      docToMarkdownOnly: await bench(() => core.docToMarkdown(doc), reps),
    };
    // Round trip stability is the serializer contract; a fast but wrong bench is useless.
    const once = core.noteContentFromMarkdown(markdown);
    const twice = core.noteContentFromMarkdown(once.markdown);
    row.roundTripStable = twice.markdown === once.markdown;
    results.push(row);
    console.error(`[perf] serializer ${size} bytes: parse+build median ${row.noteContentFromMarkdown.medianMs} ms, build from doc median ${row.buildNoteContentFromDoc.medianMs} ms`);
  }
  console.log(JSON.stringify({
    kind: "serializer",
    generatedAt: new Date().toISOString(),
    machine: { platform: os.platform(), arch: os.arch(), cpu: os.cpus()[0]?.model ?? "unknown", node: process.version },
    results,
  }, null, 2));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
