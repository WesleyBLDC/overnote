import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HelperBinaryError } from "../domain/helper-binary";
import { HelperLauncher } from "../domain/launcher";
import { resolvePaths, type HelperPaths } from "../domain/paths";
import { isProcessAlive } from "../domain/process";
import { RpcClient } from "../domain/rpc-client";
import { installFakeHelper, shortTempDir } from "./helpers";

// The launcher logic the real-helper end-to-end test cannot reach cheaply: version restarts,
// a helper that ignores shutdown, stale pid files, racing commands, and checksum refusal.
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

  it("restarts the helper when the bundled version changes", async () => {
    const old = await makeLauncher().ensure();
    installFakeHelper(paths.binary.replace(/\/bin\/OvernoteHelper$/, ""), "version-two");
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
    installFakeHelper(paths.binary.replace(/\/bin\/OvernoteHelper$/, ""), "version-three");
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
});
