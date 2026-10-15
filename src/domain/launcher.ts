import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import { bundledVersion, prepareBinary } from "./helper-binary";
import { ensureRuntimeDir, isErrno, type HelperPaths } from "./paths";
import { isProcessAlive, isProcessNamed, readPidFile, sleep, terminate, waitForExit } from "./process";
import { RpcClient, sharedClient } from "./rpc-client";

const HELPER_NAME = "BetterNotesHelper";
const PING_TIMEOUT_MS = 1000;
const LOCK_STALE_MS = 15000;
const LOCK_WAIT_MS = 8000;

export class HelperLaunchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HelperLaunchError";
  }
}

export interface EnsureOptions {
  /** Pass `--show` when the helper has to be started, so the panel opens right away. */
  show?: boolean;
  /** Pass `--headless` (no window), for end-to-end tests and CI only. */
  headless?: boolean;
}

export interface EnsureResult {
  client: RpcClient;
  version: string;
  pid: number;
  /** True when this call started (or restarted) the helper. */
  started: boolean;
}

export interface LauncherConfig {
  paths: HelperPaths;
  /** How long to wait for a freshly spawned helper to answer `system.ping`. */
  readyTimeoutMs?: number;
  client?: RpcClient;
}

/** Arguments from contract section 1. */
export function helperArgs(paths: HelperPaths, options: EnsureOptions = {}): string[] {
  const args = [
    "--support-dir",
    paths.supportDir,
    "--socket",
    paths.socket,
    "--pid-file",
    paths.pidFile,
    "--editor-dir",
    paths.editorDir,
  ];
  if (options.show) args.push("--show");
  if (options.headless) args.push("--headless");
  return args;
}

/** Ping delays for the startup wait: 25 ms doubling up to 400 ms, inside `totalMs`. */
export function backoffDelays(totalMs: number): number[] {
  const delays: number[] = [];
  let next = 25;
  let sum = 0;
  while (sum < totalMs) {
    const delay = Math.min(next, totalMs - sum);
    delays.push(delay);
    sum += delay;
    next = Math.min(next * 2, 400);
  }
  return delays;
}

/**
 * Starts the helper when it is not running, restarts it when its version differs from the bundled
 * binary, and returns a connected client. This follows the keyraycast lifecycle: pid file,
 * `kill(pid, 0)` liveness, and SIGTERM, plus a socket ping as the source of truth.
 */
export class HelperLauncher {
  readonly paths: HelperPaths;
  readonly client: RpcClient;
  private readonly readyTimeoutMs: number;
  private readonly versionCache: string;

  constructor(config: LauncherConfig) {
    this.paths = config.paths;
    this.client = config.client ?? sharedClient(config.paths.socket);
    this.readyTimeoutMs = config.readyTimeoutMs ?? 3000;
    this.versionCache = path.join(config.paths.runtimeDir, "helper-version.json");
  }

  /** Answers `system.ping` from a running helper, or null when none answers. Never starts one. */
  async ping(timeoutMs = PING_TIMEOUT_MS): Promise<{ version: string; pid: number } | null> {
    try {
      return await this.client.call("system.ping", {}, { timeoutMs });
    } catch {
      this.client.close();
      return null;
    }
  }

  async expectedVersion(): Promise<string> {
    return bundledVersion(this.paths.binary, this.paths.binaryChecksum, this.versionCache);
  }

  async ensure(options: EnsureOptions = {}): Promise<EnsureResult> {
    await ensureRuntimeDir(this.paths.runtimeDir);
    const expected = await this.expectedVersion();

    const running = await this.ping();
    if (running && running.version === expected) {
      return { client: this.client, ...running, started: false };
    }

    return this.withLaunchLock(async () => {
      // Another command may have fixed things while we waited for the lock.
      const current = await this.ping();
      if (current && current.version === expected) {
        return { client: this.client, ...current, started: false };
      }
      if (current) await this.stop(current.pid);
      else await this.clearStale();

      const pid = await this.spawn(options);
      const ready = await this.waitForReady(pid);
      if (ready.version !== expected) {
        throw new HelperLaunchError(`The helper reports version ${ready.version}, expected ${expected}.`);
      }
      return { client: this.client, ...ready, started: true };
    });
  }

  /** Graceful shutdown, then SIGTERM if the helper is still alive. */
  async stop(pid: number): Promise<void> {
    try {
      await this.client.call("system.shutdown", {});
    } catch {
      // Fall through to signals.
    }
    this.client.close();
    if (!(await waitForExit(pid, 2000))) {
      if (!(await terminate(pid))) throw new HelperLaunchError(`Could not stop the old helper (pid ${pid}).`);
    }
    await fs.rm(this.paths.pidFile, { force: true });
  }

  /**
   * Handles a helper that does not answer: a dead pid leaves stale files to remove, and a live but
   * silent helper gets the startup window to come up before it is terminated.
   */
  private async clearStale(): Promise<void> {
    const pid = await readPidFile(this.paths.pidFile);
    if (pid !== null && isProcessAlive(pid) && (await isProcessNamed(pid, HELPER_NAME))) {
      const late = await this.pollPing(this.readyTimeoutMs);
      if (late) {
        await this.stop(late.pid);
        return;
      }
      if (!(await terminate(pid))) throw new HelperLaunchError(`The helper (pid ${pid}) is not responding.`);
    }
    await fs.rm(this.paths.pidFile, { force: true });
    await fs.rm(this.paths.socket, { force: true });
  }

  private async spawn(options: EnsureOptions): Promise<number> {
    await fs.mkdir(this.paths.supportDir, { recursive: true });
    await prepareBinary(this.paths.binary, this.paths.binaryChecksum);

    const child = spawn(this.paths.binary, helperArgs(this.paths, options), {
      cwd: this.paths.supportDir,
      detached: true,
      stdio: "ignore",
    });
    const pid = await new Promise<number>((resolve, reject) => {
      child.once("error", (error) => reject(new HelperLaunchError(`Could not start the helper: ${error.message}`)));
      child.once("spawn", () => resolve(child.pid ?? 0));
    });
    child.unref();
    return pid;
  }

  private async waitForReady(pid: number): Promise<{ version: string; pid: number }> {
    const ready = await this.pollPing(this.readyTimeoutMs, pid);
    if (ready) return ready;
    if (!isProcessAlive(pid)) {
      throw new HelperLaunchError("The helper exited during startup. See helper.log in the extension support folder.");
    }
    throw new HelperLaunchError(`The helper did not answer within ${this.readyTimeoutMs} ms.`);
  }

  private async pollPing(totalMs: number, pid?: number): Promise<{ version: string; pid: number } | null> {
    for (const delay of backoffDelays(totalMs)) {
      const answer = await this.ping(250);
      if (answer) return answer;
      if (pid !== undefined && !isProcessAlive(pid)) return null;
      await sleep(delay);
    }
    return this.ping(250);
  }

  /** A mkdir lock in the runtime dir, so two commands never spawn two helpers. */
  private async withLaunchLock<T>(work: () => Promise<T>): Promise<T> {
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        await fs.mkdir(this.paths.launchLock, { mode: 0o700 });
        break;
      } catch (error) {
        if (!isErrno(error, "EEXIST")) throw error;
        await this.removeStaleLock();
        if (Date.now() > deadline) throw new HelperLaunchError("Timed out waiting for another launch to finish.");
        await sleep(50);
      }
    }
    try {
      return await work();
    } finally {
      await fs.rm(this.paths.launchLock, { recursive: true, force: true });
    }
  }

  private async removeStaleLock(): Promise<void> {
    try {
      const stat = await fs.stat(this.paths.launchLock);
      if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
        await fs.rm(this.paths.launchLock, { recursive: true, force: true });
      }
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
    }
  }
}
