import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { isErrno } from "./paths";

const execFileAsync = promisify(execFile);

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** `kill(pid, 0)`: true when the process exists, including ones we may not signal. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrno(error, "EPERM");
  }
}

export async function readPidFile(file: string): Promise<number | null> {
  try {
    const raw = await fs.readFile(file, "utf8");
    const pid = Number.parseInt(raw.trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return null;
    throw error;
  }
}

/**
 * True when `pid` is running the executable named `executableName`. Used before signalling a pid
 * read from the pid file, so a reused pid never gets a SIGTERM meant for the helper.
 */
export async function isProcessNamed(pid: number, executableName: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("/bin/ps", ["-p", String(pid), "-o", "comm="]);
    const command = stdout.trim();
    return command.length > 0 && path.basename(command) === executableName;
  } catch {
    return false;
  }
}

export async function waitForExit(pid: number, timeoutMs: number, pollMs = 50): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await sleep(pollMs);
  }
  return !isProcessAlive(pid);
}

/** SIGTERM, wait, then SIGKILL as a last resort. Resolves true once the process is gone. */
export async function terminate(pid: number, graceMs = 2000): Promise<boolean> {
  if (!signal(pid, "SIGTERM")) return true;
  if (await waitForExit(pid, graceMs)) return true;
  signal(pid, "SIGKILL");
  return waitForExit(pid, 1000);
}

function signal(pid: number, name: NodeJS.Signals): boolean {
  try {
    process.kill(pid, name);
    return true;
  } catch (error) {
    if (isErrno(error, "ESRCH")) return false;
    throw error;
  }
}
