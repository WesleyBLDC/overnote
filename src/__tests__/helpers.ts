import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * A short temporary directory under /tmp, since Unix socket paths are limited to 104 bytes on
 * macOS and the default temp dir is long.
 */
export function shortTempDir(prefix = "bnt-"): string {
  return fs.mkdtempSync(path.join("/tmp", prefix));
}

// Tests run from the repository root.
const FAKE_HELPER = path.resolve("src/__tests__/fixtures/fake-helper.mjs");

/** Writes assets/bin/BetterNotesHelper (a node shim around the fake helper) plus its .sha256. */
export function installFakeHelper(assetsPath: string, tag = "v1"): string {
  const binDir = path.join(assetsPath, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(path.join(assetsPath, "editor"), { recursive: true });
  const binary = path.join(binDir, "BetterNotesHelper");
  const source = `#!${process.execPath}\n// build ${tag}\nimport(${JSON.stringify(FAKE_HELPER)});\n`;
  fs.writeFileSync(binary, source, { mode: 0o644 });
  const hash = createHash("sha256").update(source).digest("hex");
  fs.writeFileSync(`${binary}.sha256`, `${hash}  BetterNotesHelper\n`);
  return binary;
}
