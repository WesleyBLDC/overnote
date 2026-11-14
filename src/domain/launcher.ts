import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import { bundledVersion, prepareBinary, readExpectedChecksum } from "./helper-binary";
import { ensureRuntimeDir, isErrno, type HelperPaths } from "./paths";
import { isProcessAlive, isProcessNamed, readPidFile, sleep, terminate, waitForExit } from "./process";
import { RpcClient, sharedClient } from "./rpc-client";

const HELPER_NAME = "OvernoteHelper";
/** The executable inside Overnote.app (Contents/MacOS/Overnote). */
const APP_NAME = "Overnote";
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
  /** Which packaging runs the helper: Overnote.app, or this extension (also for helpers that report no host). */
  host: HelperHostKind;
}

export type HelperHostKind = "app" | "extension";

/** `system.ping`'s answer, with `host` filled in for helpers that do not report one. */
export interface PingResult {
  version: string;
  pid: number;
  host: HelperHostKind;
}

export interface LauncherConfig {
  paths: HelperPaths;
  /** How long a helper gets to exit after `system.shutdown` before SIGTERM (default 2000 ms). */
  stopGraceMs?: number;
  /** Development only: pass `--watch-editor`, so the panel reloads on every new editor build. */
  watchEditor?: boolean;
  /** How long to wait for a freshly spawned helper to answer `system.ping`. */
  readyTimeoutMs?: number;
  client?: RpcClient;
}

/** Arguments from docs/architecture.md section 1. */
export function helperArgs(paths: HelperPaths, options: EnsureOptions = {}, watchEditor = false): string[] {
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
  if (paths.legacySupportDir !== null) args.push("--legacy-support-dir", paths.legacySupportDir);
  if (watchEditor) args.push("--watch-editor");
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
  private readonly launchRecord: string;
  private readonly watchEditor: boolean;
  private readonly stopGraceMs: number;

  constructor(config: LauncherConfig) {
    this.paths = config.paths;
    this.client = config.client ?? sharedClient(config.paths.socket);
    this.readyTimeoutMs = config.readyTimeoutMs ?? 3000;
    this.watchEditor = config.watchEditor ?? false;
    this.stopGraceMs = config.stopGraceMs ?? 2000;
    this.versionCache = path.join(config.paths.runtimeDir, "helper-version.json");
    this.launchRecord = path.join(config.paths.runtimeDir, "helper-launch.json");
  }

  /** Answers `system.ping` from a running helper, or null when none answers. Never starts one. */
  async ping(timeoutMs = PING_TIMEOUT_MS): Promise<PingResult | null> {
    try {
      const answer = await this.client.call("system.ping", {}, { timeoutMs });
      return { version: answer.version, pid: answer.pid, host: answer.host === "app" ? "app" : "extension" };
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
    const launch = await this.launchKey();

    const running = await this.ping();
    if (running && (await this.reusable(running, expected, launch))) {
      return this.reused(running);
    }

    return this.withLaunchLock(async () => {
      // Another command may have fixed things while we waited for the lock.
      const current = await this.ping();
      if (current && (await this.reusable(current, expected, launch))) {
        return this.reused(current);
      }
      if (current) await this.stop(current.pid);
      else {
        // Overnote.app may be starting up: reuse it once it answers, never replace it.
        const app = await this.clearStale();
        if (app) return this.reused(app);
      }

      const pid = await this.spawn(options);
      const ready = await this.waitForReady(pid);
      // Overnote.app took the lock first, so ours exited and the app answered instead.
      if (ready.host === "app") return this.reused(ready);
      if (ready.version !== expected) {
        throw new HelperLaunchError(`The helper reports version ${ready.version}, expected ${expected}.`);
      }
      await this.recordLaunch(ready.pid, launch);
      return { client: this.client, ...ready, started: true };
    });
  }

  /**
   * A running helper this call did not start. Overnote.app never got this extension's legacy
   * folder, so it may have created an empty shared database first: hand it the folder with
   * `system.importLegacy`, which imports only into a database that holds no note at all
   * (docs/architecture.md section 9). Older apps without the method, and any failure, change nothing.
   */
  private async reused(running: PingResult): Promise<EnsureResult> {
    if (running.host === "app" && this.paths.legacySupportDir !== null) {
      try {
        await this.client.call("system.importLegacy", { dir: this.paths.legacySupportDir });
      } catch {
        // The app keeps running on its database as it is.
      }
    }
    return { client: this.client, ...running, started: false };
  }

  /**
   * Overnote.app is always reused as it is, whatever its version or launch: the app owns its own
   * lifetime, and the extension never restarts, replaces, or stops it. A helper this extension
   * started is reused only when it is the bundled version, launched the current way.
   */
  private async reusable(running: PingResult, expected: string, launch: string): Promise<boolean> {
    if (running.host === "app") return true;
    return running.version === expected && (await this.launchedAs(running.pid, launch));
  }

  /**
   * What a running helper must have been started with to be reused: the binary (by checksum, so a
   * rebuild with an unchanged version still counts as new) and the arguments that do not change
   * per launch. A helper this launcher did not record is restarted once.
   */
  private async launchKey(): Promise<string> {
    const checksum = await readExpectedChecksum(this.paths.binaryChecksum);
    return JSON.stringify([checksum, this.paths.binary, ...helperArgs(this.paths, {}, this.watchEditor)]);
  }

  private async launchedAs(pid: number, key: string): Promise<boolean> {
    try {
      const record = JSON.parse(await fs.readFile(this.launchRecord, "utf8")) as { pid?: unknown; key?: unknown };
      return record.pid === pid && record.key === key;
    } catch {
      return false;
    }
  }

  private async recordLaunch(pid: number, key: string): Promise<void> {
    const temp = `${this.launchRecord}.${process.pid}.tmp`;
    try {
      await fs.writeFile(temp, JSON.stringify({ pid, key }), { mode: 0o600 });
      await fs.rename(temp, this.launchRecord);
    } catch {
      await fs.rm(temp, { force: true });
    }
  }

  /** Graceful shutdown, then SIGTERM if the helper is still alive. */
  async stop(pid: number): Promise<void> {
    try {
      await this.client.call("system.shutdown", {});
    } catch {
      // Fall through to signals.
    }
    this.client.close();
    if (!(await waitForExit(pid, this.stopGraceMs))) {
      if (!(await terminate(pid))) throw new HelperLaunchError(`Could not stop the old helper (pid ${pid}).`);
    }
    await fs.rm(this.paths.pidFile, { force: true });
  }

  /**
   * Handles a helper that does not answer: a dead pid leaves stale files to remove, and a live but
   * silent helper gets the startup window to come up before it is terminated.
   */
  private async clearStale(): Promise<PingResult | null> {
    const pid = await readPidFile(this.paths.pidFile);
    if (pid !== null && isProcessAlive(pid)) {
      const isHelper = await isProcessNamed(pid, HELPER_NAME);
      if (isHelper || (await isProcessNamed(pid, APP_NAME))) {
        const late = await this.pollPing(this.readyTimeoutMs);
        if (late?.host === "app") return late;
        if (late) {
          await this.stop(late.pid);
          return null;
        }
        // A silent Overnote.app is left alone; its files are not ours to remove.
        if (!isHelper) throw new HelperLaunchError(`Overnote.app (pid ${pid}) is not responding.`);
        if (!(await terminate(pid))) throw new HelperLaunchError(`The helper (pid ${pid}) is not responding.`);
      }
    }
    await fs.rm(this.paths.pidFile, { force: true });
    await fs.rm(this.paths.socket, { force: true });
    return null;
  }

  private async spawn(options: EnsureOptions): Promise<number> {
    await fs.mkdir(this.paths.supportDir, { recursive: true });
    await prepareBinary(this.paths.binary, this.paths.binaryChecksum);

    const child = spawn(this.paths.binary, helperArgs(this.paths, options, this.watchEditor), {
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

  private async waitForReady(pid: number): Promise<PingResult> {
    const ready = await this.pollPing(this.readyTimeoutMs, pid);
    if (ready) return ready;
    if (!isProcessAlive(pid)) {
      throw new HelperLaunchError(
        "The helper exited during startup. See helper.log in ~/Library/Application Support/Overnote.",
      );
    }
    throw new HelperLaunchError(`The helper did not answer within ${this.readyTimeoutMs} ms.`);
  }

  private async pollPing(totalMs: number, pid?: number): Promise<PingResult | null> {
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
