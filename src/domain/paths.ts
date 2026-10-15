import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Every location the extension and the helper agree on (contract section 1). */
export interface HelperPaths {
  runtimeDir: string;
  socket: string;
  pidFile: string;
  launchLock: string;
  supportDir: string;
  database: string;
  binary: string;
  binaryChecksum: string;
  editorDir: string;
}

export interface PathInputs {
  supportPath: string;
  assetsPath: string;
  /** Defaults to the current user's uid. */
  uid?: number;
  /** Defaults to `/tmp`. Tests point this at a temporary directory. */
  runtimeRoot?: string;
}

export function runtimeDirFor(uid: number, runtimeRoot = "/tmp"): string {
  return path.join(runtimeRoot, `better-notes-${uid}`);
}

export function databasePath(supportPath: string): string {
  return path.join(supportPath, "notes.sqlite");
}

export function resolvePaths(inputs: PathInputs): HelperPaths {
  const uid = inputs.uid ?? os.userInfo().uid;
  const runtimeDir = runtimeDirFor(uid, inputs.runtimeRoot);
  const binary = path.join(inputs.assetsPath, "bin", "BetterNotesHelper");
  return {
    runtimeDir,
    socket: path.join(runtimeDir, "helper.sock"),
    pidFile: path.join(runtimeDir, "helper.pid"),
    launchLock: path.join(runtimeDir, "launch.lock"),
    supportDir: inputs.supportPath,
    database: databasePath(inputs.supportPath),
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
