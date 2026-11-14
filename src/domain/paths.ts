import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Every location the extension and the helper agree on (docs/architecture.md section 1). */
export interface HelperPaths {
  runtimeDir: string;
  socket: string;
  pidFile: string;
  launchLock: string;
  supportDir: string;
  database: string;
  /** The extension's old data folder, copied into `supportDir` once by the helper; null when none. */
  legacySupportDir: string | null;
  binary: string;
  binaryChecksum: string;
  editorDir: string;
}

export interface PathInputs {
  /** The shared data folder (`sharedSupportDir()` in the extension). */
  supportPath: string;
  /** The extension's old data folder (Raycast's `environment.supportPath`), passed as `--legacy-support-dir`. */
  legacySupportPath?: string;
  assetsPath: string;
  /** Defaults to the current user's uid. */
  uid?: number;
  /** Defaults to `/tmp`. Tests point this at a temporary directory. */
  runtimeRoot?: string;
}

export function runtimeDirFor(uid: number, runtimeRoot = "/tmp"): string {
  return path.join(runtimeRoot, `overnote-${uid}`);
}

export function databasePath(supportPath: string): string {
  return path.join(supportPath, "notes.sqlite");
}

/**
 * The one data folder the extension and Overnote.app share: `~/Library/Application Support/Overnote`.
 * `OVERNOTE_SUPPORT_DIR` moves it, as in scripts/update-extension.sh; every test sets it to a
 * temporary folder (vitest.config.mts), so tests never reach the real notes.
 */
export function sharedSupportDir(): string {
  return process.env.OVERNOTE_SUPPORT_DIR || path.join(os.homedir(), "Library", "Application Support", "Overnote");
}

/**
 * The database a read-only reader should open while no helper runs: the shared one, or the
 * legacy one when no helper has copied it over yet.
 */
export function readableDatabase(paths: HelperPaths): string {
  if (existsSync(paths.database) || paths.legacySupportDir === null) return paths.database;
  const legacy = databasePath(paths.legacySupportDir);
  return existsSync(legacy) ? legacy : paths.database;
}

export function resolvePaths(inputs: PathInputs): HelperPaths {
  const uid = inputs.uid ?? os.userInfo().uid;
  // OVERNOTE_RUNTIME_DIR moves the socket and pid file, as in scripts/update-extension.sh; the
  // command end-to-end tests use it so they can never reach a helper the person is running.
  const runtimeDir =
    inputs.runtimeRoot === undefined && process.env.OVERNOTE_RUNTIME_DIR
      ? process.env.OVERNOTE_RUNTIME_DIR
      : runtimeDirFor(uid, inputs.runtimeRoot);
  const binary = path.join(inputs.assetsPath, "bin", "OvernoteHelper");
  return {
    runtimeDir,
    socket: path.join(runtimeDir, "helper.sock"),
    pidFile: path.join(runtimeDir, "helper.pid"),
    launchLock: path.join(runtimeDir, "launch.lock"),
    supportDir: inputs.supportPath,
    database: databasePath(inputs.supportPath),
    legacySupportDir:
      inputs.legacySupportPath && path.resolve(inputs.legacySupportPath) !== path.resolve(inputs.supportPath)
        ? inputs.legacySupportPath
        : null,
    binary,
    binaryChecksum: `${binary}.sha256`,
    editorDir: path.join(inputs.assetsPath, "editor"),
  };
}

/**
 * Creates the runtime directory with mode 0700, or checks that an existing one is a real directory
 * owned by us and closed to other users. Refusing anything else keeps another local user from
 * planting a socket we would talk to.
 */
export async function ensureRuntimeDir(dir: string, uid = os.userInfo().uid): Promise<void> {
  try {
    await fs.mkdir(dir, { mode: 0o700 });
  } catch (error) {
    if (!isErrno(error, "EEXIST")) throw error;
  }
  const stat = await fs.lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${dir} is not a directory`);
  }
  if (stat.uid !== uid) {
    throw new Error(`${dir} is owned by another user`);
  }
  if ((stat.mode & 0o077) !== 0) {
    await fs.chmod(dir, 0o700);
  }
}

export function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === code;
}

/**
 * The checkout's own `assets/` folder while `npm run dev` runs, so the helper and the editor are
 * always the latest builds instead of the copies Raycast made at install time. `scripts/dev.sh`
 * records it in `assets/dev.json`. A release (`assets/prebuilt.json`) never uses it, nor does a
 * record whose folder has no helper binary.
 */
export function developmentAssetsPath(assetsPath: string): string | null {
  if (existsSync(path.join(assetsPath, "prebuilt.json"))) return null;
  try {
    const record = JSON.parse(readFileSync(path.join(assetsPath, "dev.json"), "utf8")) as { assetsDir?: unknown };
    const dir = record.assetsDir;
    if (typeof dir !== "string" || !path.isAbsolute(dir)) return null;
    return existsSync(path.join(dir, "bin", "OvernoteHelper")) ? dir : null;
  } catch {
    return null;
  }
}
