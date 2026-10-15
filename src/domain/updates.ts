import fs from "node:fs/promises";
import path from "node:path";

/** GitHub's releases API for this repository (the same one `npm run update-extension` uses). */
export const RELEASES_API = "https://api.github.com/repos/WesleyBLDC/overnote/releases";
export const CHECK_TIMEOUT_MS = 5000;

export interface InstalledVersion {
  version: string;
  /** "release" when installed from a release zip (assets/prebuilt.json), "source" for a checkout. */
  source: "release" | "source";
  /** The folder `npm run install-extension` ran in, recorded in assets/install-location.json. */
  installDir: string | null;
}

export interface LatestRelease {
  version: string;
  tag: string;
  url: string;
}

interface ParsedVersion {
  core: [number, number, number];
  prerelease: string[];
}

/** Parses `1.2.3`, `v1.2.3`, and `1.2.3-beta.1` (build metadata after `+` is ignored). */
export function parseVersion(text: string): ParsedVersion | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(text.trim());
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

/** Semver precedence: negative when `a` is older than `b`, 0 when equal, positive when newer. */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) throw new Error(`Not a version: ${left ? b : a}`);
  for (let i = 0; i < 3; i++) {
    if (left.core[i] !== right.core[i]) return left.core[i]! - right.core[i]!;
  }
  // A release is newer than any of its prereleases.
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return right.prerelease.length - left.prerelease.length;
  }
  for (let i = 0; i < Math.max(left.prerelease.length, right.prerelease.length); i++) {
    const x = left.prerelease[i];
    const y = right.prerelease[i];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) return Number(x) - Number(y);
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = JSON.parse(await fs.readFile(file, "utf8"));
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The installed version: `assets/prebuilt.json` in a release install, else `fallback()` (the
 * bundled helper's version) for a source checkout.
 */
export async function readInstalledVersion(
  assetsPath: string,
  fallback: () => Promise<string>,
): Promise<InstalledVersion> {
  const prebuilt = await readJson(path.join(assetsPath, "prebuilt.json"));
  const location = await readJson(path.join(assetsPath, "install-location.json"));
  const installDir = typeof location?.installDir === "string" ? location.installDir : null;
  if (typeof prebuilt?.version === "string") return { version: prebuilt.version, source: "release", installDir };
  return { version: await fallback(), source: "source", installDir };
}

/** The latest published (non draft, non prerelease) release, with a short timeout. */
export async function fetchLatestRelease(apiBase = RELEASES_API, timeoutMs = CHECK_TIMEOUT_MS): Promise<LatestRelease> {
  let response: Response;
  try {
    response = await fetch(`${apiBase.replace(/\/+$/, "")}/latest`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "overnote-update-check" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new Error(`GitHub did not answer within ${timeoutMs / 1000} s`);
    }
    throw new Error("Could not reach GitHub. Check your internet connection.");
  }
  if (response.status === 404) throw new Error("There is no published release yet");
  if (!response.ok) throw new Error(`GitHub answered ${response.status} ${response.statusText}`.trim());
  const body = (await response.json()) as { tag_name?: unknown; html_url?: unknown };
  const tag = typeof body.tag_name === "string" ? body.tag_name : "";
  if (!parseVersion(tag)) throw new Error(`The latest release has an unexpected tag: ${tag || "(none)"}`);
  return { version: tag.replace(/^v/, ""), tag, url: typeof body.html_url === "string" ? body.html_url : "" };
}

/** The one line a person pastes into Terminal to update (it never runs on its own). */
export function updateCommand(installDir: string | null): string {
  const quoted = installDir === null ? null : `'${installDir.replace(/'/g, `'\\''`)}'`;
  return quoted === null ? "npm run update-extension" : `cd ${quoted} && npm run update-extension`;
}
