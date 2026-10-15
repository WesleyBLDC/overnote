import { showInFinder } from "@raycast/api";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { BackupInfo, RestoreResult } from "../domain/types";
import { callHelper, getLauncher, helperPaths } from "./helper";
import { refreshMenuBar } from "./menu-bar";

/** Where the helper keeps backups unless OVERNOTE_BACKUP_DIR says otherwise (docs/architecture.md section 9). */
export const DEFAULT_BACKUP_DIR = path.join(os.homedir(), "Library", "Application Support", "Overnote", "backups");

export interface RestoreOffer {
  available: boolean;
  backupCount: number;
  latest: BackupInfo | null;
}

const NO_OFFER: RestoreOffer = { available: false, backupCount: 0, latest: null };

/** Writes a backup now, even when the database holds no notes. */
export function backUpNow(): Promise<BackupInfo> {
  return callHelper("system.backup", { reason: "manual" });
}

/** Every backup, newest first. */
export async function listBackups(): Promise<BackupInfo[]> {
  return (await callHelper("system.listBackups", {})).items;
}

/** Replaces every note with the backup at `file`, after the helper backs up the current notes. */
export async function restoreBackup(file: string): Promise<RestoreResult> {
  const result = await callHelper("system.restoreBackup", { path: file });
  await refreshMenuBar();
  return result;
}

export async function dismissRestoreOffer(): Promise<void> {
  await callHelper("system.dismissRestoreOffer", {});
  await refreshMenuBar();
}

/**
 * Whether to offer a restore. It asks a running helper, and starts one only when there is no
 * database yet (a fresh install), which is exactly when the helper decides to make the offer.
 * Otherwise it does not start the helper, so Search Notes stays instant.
 */
export async function loadRestoreOffer(): Promise<RestoreOffer> {
  const running = await getLauncher().ping(300);
  if (!running && (await exists(helperPaths().database))) return NO_OFFER;
  const status = await callHelper("system.status", {});
  return { available: status.restoreAvailable, backupCount: status.backupCount, latest: status.latestBackup };
}

/** Opens the backups folder in Finder, creating it first so there is always something to show. */
export async function revealBackupsFolder(): Promise<void> {
  let directory = DEFAULT_BACKUP_DIR;
  if (await getLauncher().ping(300)) directory = (await callHelper("system.status", {})).backupDir;
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await showInFinder(directory);
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}
