import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { isErrno } from "./paths";

const execFileAsync = promisify(execFile);
const QUARANTINE = "com.apple.quarantine";
const XATTR = "/usr/bin/xattr";

export class HelperBinaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HelperBinaryError";
  }
}

export async function sha256OfFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** Reads the first token of a `.sha256` file, which may be a bare hash or `shasum` output. */
export async function readExpectedChecksum(file: string): Promise<string> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      throw new HelperBinaryError("The helper checksum file is missing. Run `npm run build:helper`.");
    }
    throw error;
  }
  const token = raw.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (!/^[0-9a-f]{64}$/.test(token)) {
    throw new HelperBinaryError(`${path.basename(file)} does not contain a sha256 hash.`);
  }
  return token;
}

export async function verifyChecksum(binary: string, checksumFile: string): Promise<void> {
  await assertBinaryExists(binary);
  const [expected, actual] = await Promise.all([readExpectedChecksum(checksumFile), sha256OfFile(binary)]);
  if (expected !== actual) {
    throw new HelperBinaryError("The helper binary does not match its checksum. Run `npm run build:helper` again.");
  }
}

export async function assertBinaryExists(binary: string): Promise<void> {
  try {
    const stat = await fs.stat(binary);
    if (!stat.isFile()) throw new HelperBinaryError(`${binary} is not a file.`);
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      throw new HelperBinaryError("The Better Notes helper is not built. Run `npm run build:helper`.");
    }
    throw error;
  }
}

/** Makes sure the binary is executable (mode 755); asset copies can lose the exec bit. */
export async function ensureExecutable(binary: string): Promise<void> {
  const stat = await fs.stat(binary);
  if ((stat.mode & 0o777) !== 0o755) await fs.chmod(binary, 0o755);
}

/** Removes `com.apple.quarantine` when present, so Gatekeeper does not block the first launch. */
export type RunFile = (file: string, args: readonly string[]) => Promise<unknown>;

const runFile: RunFile = (file, args) => execFileAsync(file, args);

export async function removeQuarantine(binary: string, run: RunFile = runFile): Promise<boolean> {
  try {
    await run(XATTR, ["-p", QUARANTINE, binary]);
  } catch {
    return false;
  }
  await run(XATTR, ["-d", QUARANTINE, binary]);
  return true;
}

export async function prepareBinary(binary: string, checksumFile: string): Promise<void> {
  await verifyChecksum(binary, checksumFile);
  await ensureExecutable(binary);
  await removeQuarantine(binary);
}

interface VersionCacheEntry {
  key: string;
  version: string;
}

/**
 * The version of the bundled helper, from `BetterNotesHelper --version`. The answer is cached on
 * disk keyed by the binary's size and mtime, so the warm path does not run the binary every time.
 * On a cache miss the binary is verified against its checksum before it runs.
 */
export async function bundledVersion(binary: string, checksumFile: string, cacheFile: string): Promise<string> {
  await assertBinaryExists(binary);
  const stat = await fs.stat(binary);
  const key = `${stat.size}:${stat.mtimeMs}`;

  const cached = await readVersionCache(cacheFile);
  if (cached?.key === key) return cached.version;

  await prepareBinary(binary, checksumFile);
  const { stdout } = await execFileAsync(binary, ["--version"], { timeout: 3000 });
  const version = stdout.trim();
  if (version.length === 0) throw new HelperBinaryError("The helper printed an empty version.");
  await writeVersionCache(cacheFile, { key, version });
  return version;
}

async function readVersionCache(file: string): Promise<VersionCacheEntry | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as Partial<VersionCacheEntry>;
    return typeof parsed.key === "string" && typeof parsed.version === "string"
      ? { key: parsed.key, version: parsed.version }
      : null;
  } catch {
    return null;
  }
}

async function writeVersionCache(file: string, entry: VersionCacheEntry): Promise<void> {
  const temp = `${file}.${process.pid}.tmp`;
  try {
    await fs.writeFile(temp, JSON.stringify(entry), { mode: 0o600 });
    await fs.rename(temp, file);
  } catch {
    await fs.rm(temp, { force: true });
  }
}
