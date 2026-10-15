import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HelperBinaryError, removeQuarantine } from "../domain/helper-binary";
import { HelperLaunchError, HelperLauncher, backoffDelays, helperArgs } from "../domain/launcher";
import { resolvePaths, type HelperPaths } from "../domain/paths";
import { isProcessAlive } from "../domain/process";
import { RpcClient } from "../domain/rpc-client";
import { installFakeHelper, shortTempDir } from "./helpers";

describe("helper launcher", () => {
  let root: string;
  let paths: HelperPaths;
  const launchers: HelperLauncher[] = [];

  const makeLauncher = () => {
    const launcher = new HelperLauncher({ paths, client: new RpcClient({ socketPath: paths.socket }) });
    launchers.push(launcher);
    return launcher;
  };

  const spawnedPids = (): number[] =>
    fs.existsSync(paths.supportDir)
      ? fs
          .readdirSync(paths.supportDir)
          .filter((name) => name.startsWith("args-"))
          .map((name) => Number(name.slice(5, -5)))
      : [];

  const argsOf = (pid: number): string[] =>
    JSON.parse(fs.readFileSync(path.join(paths.supportDir, `args-${pid}.json`), "utf8"));

  beforeEach(() => {
    root = shortTempDir();
    const assetsPath = path.join(root, "assets");
    installFakeHelper(assetsPath, "v1");
    paths = resolvePaths({ supportPath: path.join(root, "support"), assetsPath, runtimeRoot: root });
    process.env.FAKE_HELPER_VERSION = "1.0.0";
    delete process.env.FAKE_HELPER_BEHAVIOR;
    delete process.env.FAKE_HELPER_DELAY_MS;
  });

  afterEach(() => {
    for (const launcher of launchers.splice(0)) launcher.client.close();
    for (const pid of spawnedPids()) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already exited.
      }
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("builds the contract command line", () => {
    expect(helperArgs(paths)).toEqual([
      "--support-dir",
      paths.supportDir,
      "--socket",
      paths.socket,
      "--pid-file",
      paths.pidFile,
      "--editor-dir",
      paths.editorDir,
    ]);
    expect(helperArgs(paths, { show: true }).at(-1)).toBe("--show");
  });

  it("backs off from 25 ms up to 400 ms within the budget", () => {
    const delays = backoffDelays(3000);
    expect(delays.slice(0, 5)).toEqual([25, 50, 100, 200, 400]);
    expect(delays.reduce((sum, delay) => sum + delay, 0)).toBe(3000);
    expect(Math.max(...delays)).toBe(400);
  });

  it("starts a cold helper detached, with --show, and a private runtime dir", async () => {
    const result = await makeLauncher().ensure({ show: true });
    expect(result.started).toBe(true);
    expect(result.version).toBe("1.0.0");
    expect(isProcessAlive(result.pid)).toBe(true);
    expect(argsOf(result.pid)).toEqual(helperArgs(paths, { show: true }));
    expect(fs.statSync(paths.runtimeDir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(paths.binary).mode & 0o777).toBe(0o755);
    await expect(result.client.call("window.toggle", {})).resolves.toEqual({ visible: false });
  });

  it("reuses a running helper without spawning again", async () => {
    const first = await makeLauncher().ensure();
    const second = await makeLauncher().ensure({ show: true });
    expect(second.started).toBe(false);
    expect(second.pid).toBe(first.pid);
    expect(spawnedPids()).toHaveLength(1);
  });

  it("restarts the helper when the bundled version changes", async () => {
    const old = await makeLauncher().ensure();
    installFakeHelper(paths.binary.replace(/\/bin\/BetterNotesHelper$/, ""), "version-two");
    process.env.FAKE_HELPER_VERSION = "2.0.0";
    const next = await makeLauncher().ensure();
    expect(next.started).toBe(true);
    expect(next.version).toBe("2.0.0");
    expect(next.pid).not.toBe(old.pid);
    expect(isProcessAlive(old.pid)).toBe(false);
  });

  it("falls back to SIGTERM when the old helper ignores system.shutdown", async () => {
    process.env.FAKE_HELPER_BEHAVIOR = "ignore-shutdown";
    const old = await makeLauncher().ensure();
    delete process.env.FAKE_HELPER_BEHAVIOR;
    installFakeHelper(paths.binary.replace(/\/bin\/BetterNotesHelper$/, ""), "version-three");
    process.env.FAKE_HELPER_VERSION = "3.0.0";
    const next = await makeLauncher().ensure();
    expect(next.version).toBe("3.0.0");
    expect(isProcessAlive(old.pid)).toBe(false);
  });

  it("cleans up a stale pid file and socket left by a dead helper", async () => {
    fs.mkdirSync(paths.runtimeDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(paths.pidFile, "999999\n");
    fs.writeFileSync(paths.socket, "");
    const result = await makeLauncher().ensure();
    expect(result.started).toBe(true);
    expect(fs.readFileSync(paths.pidFile, "utf8").trim()).toBe(String(result.pid));
  });

  it("waits for a slow helper to start listening", async () => {
    process.env.FAKE_HELPER_DELAY_MS = "600";
    const result = await makeLauncher().ensure();
    expect(result.started).toBe(true);
  });

  it("spawns only one helper when several commands race", async () => {
    const results = await Promise.all([makeLauncher().ensure(), makeLauncher().ensure(), makeLauncher().ensure()]);
    expect(new Set(results.map((result) => result.pid)).size).toBe(1);
    expect(spawnedPids()).toHaveLength(1);
  });

  it("refuses a binary that does not match its checksum", async () => {
    fs.appendFileSync(paths.binary, "// tampered\n");
    await expect(makeLauncher().ensure()).rejects.toBeInstanceOf(HelperBinaryError);
    expect(spawnedPids()).toHaveLength(0);
  });

  it("explains a missing helper build", async () => {
    fs.rmSync(paths.binary);
    await expect(makeLauncher().ensure()).rejects.toThrow(/npm run build:helper/);
  });

  it("reports a helper that exits during startup", async () => {
    process.env.FAKE_HELPER_BEHAVIOR = "crash";
    const started = Date.now();
    await expect(makeLauncher().ensure()).rejects.toBeInstanceOf(HelperLaunchError);
    expect(Date.now() - started).toBeLessThan(2500);
  });

  it("removes com.apple.quarantine only when it is present", async () => {
    const calls: string[][] = [];
    const present = async (_file: string, args: readonly string[]) => {
      calls.push([...args]);
      return { stdout: "", stderr: "" };
    };
    await expect(removeQuarantine("/bin/x", present)).resolves.toBe(true);
    expect(calls).toEqual([
      ["-p", "com.apple.quarantine", "/bin/x"],
      ["-d", "com.apple.quarantine", "/bin/x"],
    ]);

    const absent = async () => {
      throw new Error("No such xattr");
    };
    await expect(removeQuarantine("/bin/x", absent)).resolves.toBe(false);
  });
});
