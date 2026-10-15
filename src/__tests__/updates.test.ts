/**
 * The update check's version logic and its GitHub call, against a local fake of the releases API
 * (the Raycast command itself only adds the toast, HUD, and clipboard around these).
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { compareVersions, fetchLatestRelease } from "../domain/updates";

describe("update check", () => {
  let server: http.Server;
  let base: string;
  const routes: Record<string, (res: http.ServerResponse) => void> = {};

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const route = routes[req.url ?? ""];
      if (route) route(res);
      else res.writeHead(404).end("{}");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.closeAllConnections();
    server.close();
  });

  it("orders versions by semver precedence", () => {
    const ordered = [
      "0.9.9",
      "1.0.0-alpha",
      "1.0.0-alpha.1",
      "1.0.0-beta.2",
      "1.0.0-beta.11",
      "1.0.0",
      "1.0.1",
      "1.10.0",
    ];
    for (let i = 1; i < ordered.length; i++) expect(compareVersions(ordered[i]!, ordered[i - 1]!)).toBeGreaterThan(0);
    expect(compareVersions("v1.2.3", "1.2.3")).toBe(0);
    expect(() => compareVersions("latest", "1.0.0")).toThrow("Not a version: latest");
  });

  it("reads the latest release, and fails clearly on a timeout or a missing release", async () => {
    routes["/ok/latest"] = (res) =>
      res.end(
        JSON.stringify({ tag_name: "v0.4.0", html_url: "https://github.com/WesleyBLDC/overnote/releases/tag/v0.4.0" }),
      );
    routes["/slow/latest"] = (res) => setTimeout(() => res.end("{}"), 2000);
    await expect(fetchLatestRelease(`${base}/ok`)).resolves.toMatchObject({ version: "0.4.0", tag: "v0.4.0" });
    await expect(fetchLatestRelease(`${base}/slow`, 200)).rejects.toThrow("did not answer within 0.2 s");
    await expect(fetchLatestRelease(`${base}/none`)).rejects.toThrow("no published release");
  });
});
