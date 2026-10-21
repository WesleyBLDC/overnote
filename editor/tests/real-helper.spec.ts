/**
 * The shipped editor (assets/editor) against the REAL helper binary (assets/bin/OvernoteHelper,
 * headless with test hooks): every bridge message the page sends goes over the helper's socket
 * through test.asBridge, so typing reaches the helper's SQLite database exactly as in the panel.
 * `npm run verify` builds the helper first; run `npm run build:helper` before running this alone.
 * OVERNOTE_HELPER_BIN points it at another build, such as helper/.build/release/OvernoteHelper.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { duplicateContent } from "@overnote/core";
import { expect, test, type Page } from "@playwright/test";
import { pauseClock } from "./harness";

const HELPER =
  process.env.OVERNOTE_HELPER_BIN || fileURLToPath(new URL("../../assets/bin/OvernoteHelper", import.meta.url));

interface RpcFailure {
  code: number;
  message: string;
}

/** One helper process with its own folders, and a line-delimited JSON-RPC client for its socket. */
class RealHelper {
  private process: ChildProcess | null = null;
  readonly socket: string;

  constructor(private readonly root: string) {
    this.socket = path.join(root, "helper.sock");
  }

  async start(): Promise<void> {
    this.process = spawn(
      HELPER,
      [
        "--support-dir",
        path.join(this.root, "support"),
        "--socket",
        this.socket,
        "--pid-file",
        path.join(this.root, "helper.pid"),
        "--headless",
        "--test-hooks",
      ],
      { env: { ...process.env, OVERNOTE_BACKUP_DIR: path.join(this.root, "backups") }, stdio: "ignore" },
    );
    await expect
      .poll(
        () =>
          this.call("system.ping").then(
            () => true,
            () => false,
          ),
        { timeout: 10_000 },
      )
      .toBe(true);
  }

  async stop(): Promise<void> {
    const child = this.process;
    if (!child || child.exitCode !== null) return;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    await this.call("system.shutdown").catch(() => child.kill("SIGTERM"));
    await exited;
  }

  call(method: string, params: unknown = {}): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const connection = net.createConnection(this.socket);
      let buffer = "";
      connection.on("error", reject);
      connection.on("connect", () => connection.write(`${JSON.stringify({ id: 1, method, params })}\n`));
      connection.on("data", (chunk) => {
        buffer += chunk.toString();
        const end = buffer.indexOf("\n");
        if (end < 0) return;
        connection.end();
        const reply = JSON.parse(buffer.slice(0, end)) as { result?: unknown; error?: RpcFailure };
        if (reply.error) reject(Object.assign(new Error(reply.error.message), { code: reply.error.code }));
        else resolve(reply.result);
      });
    });
  }
}

/** Routes every bridge message the page sends to `helper` over its socket (test.asBridge). */
async function bridgeTo(page: Page, helper: RealHelper): Promise<void> {
  await page.exposeBinding("__toHelper", async (_source, message: { method: string; params: unknown }) => {
    try {
      return { ok: true, result: await helper.call("test.asBridge", message) };
    } catch (error) {
      const failure = error as Error & { code?: number };
      return { ok: false, error: { code: failure.code ?? -1, message: failure.message } };
    }
  });
  await page.addInitScript(() => {
    type Reply = { ok: boolean; result?: unknown; error?: unknown };
    const w = window as unknown as {
      __toHelper(message: unknown): Promise<Reply>;
      overnoteBridge: { resolve(id: number, result: unknown): void; reject(id: number, error: unknown): void };
      webkit: unknown;
    };
    w.webkit = {
      messageHandlers: {
        overnote: {
          postMessage(message: { id: number; method: string; params: unknown }) {
            void w
              .__toHelper({ method: message.method, params: message.params })
              .then((reply) =>
                reply.ok
                  ? w.overnoteBridge.resolve(message.id, reply.result)
                  : w.overnoteBridge.reject(message.id, reply.error),
              );
          },
        },
      },
    };
  });
}

test.skip(!fs.existsSync(HELPER), "the helper is not built: run npm run build:helper");

test("typing in the shipped editor lands in the helper's database and survives a helper restart", async ({ page }) => {
  // A short root: Unix socket paths are limited to about 100 characters.
  const root = fs.mkdtempSync("/tmp/overnote-real-");
  const helper = new RealHelper(root);
  try {
    await helper.start();
    await bridgeTo(page, helper);

    // A fresh database: the editor creates the first note through the helper, then takes typing.
    await page.goto("http://127.0.0.1:5198/index.html");
    await expect(page.getByTestId("app")).toHaveAttribute("data-ready", "true");
    await expect(page.locator(".note-editor")).toBeFocused();
    await page.keyboard.type("Saved for real");
    await page.keyboard.press("Enter");
    await page.keyboard.type("second line");
    const stored = async () =>
      ((await helper.call("notes.list", {})) as { items: { title: string; preview: string }[] }).items;
    await expect.poll(async () => (await stored())[0]?.preview).toBe("Saved for real\n\nsecond line");
    expect((await stored())[0]?.title).toBe("Saved for real");

    // The helper stops and starts again on the same database; the reloaded editor shows the note.
    await helper.stop();
    await helper.start();
    await page.reload();
    await expect(page.getByTestId("title")).toHaveText("Saved for real");
    await expect(page.locator(".note-editor")).toHaveText("Saved for realsecond line");
    expect(await stored()).toHaveLength(1);
  } finally {
    await helper.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a socket write that lands while the person types is merged into their edits, never overwritten", async ({
  page,
}) => {
  const root = fs.mkdtempSync("/tmp/overnote-real-");
  const helper = new RealHelper(root);
  try {
    await helper.start();
    await bridgeTo(page, helper);
    // A paused page clock holds the autosave until the outside write has landed.
    await page.clock.install();
    await page.goto("http://127.0.0.1:5198/index.html");
    await expect(page.getByTestId("app")).toHaveAttribute("data-ready", "true");
    await expect(page.locator(".note-editor")).toBeFocused();
    await pauseClock(page);
    await page.keyboard.type("Draft");
    await page.clock.runFor(400);
    type Stored = { id: string; updatedAt: number; text: string };
    const note = async () => {
      const { items } = (await helper.call("notes.list", {})) as { items: { id: string }[] };
      return (await helper.call("notes.get", { id: items[0]?.id })) as Stored;
    };
    await expect.poll(async () => (await note()).text).toBe("Draft");

    await page.keyboard.type(" mine");
    // overnote-axi appends a paragraph through the socket, guarded by the version it read.
    const before = await note();
    const paragraphs = ["Draft", "From outside"];
    const written = (await helper.call("notes.update", {
      id: before.id,
      expectedUpdatedAt: before.updatedAt,
      rawContent: JSON.stringify({
        type: "doc",
        content: paragraphs.map((text) => ({ type: "paragraph", content: [{ type: "text", text }] })),
      }),
      markdown: paragraphs.join("\n\n"),
      text: paragraphs.join("\n\n"),
      title: "Draft",
    })) as { status: string };
    expect(written.status).toBe("ok");

    // The editor's save is refused as stale, merges the outside paragraph in, and saves both.
    await page.clock.runFor(400);
    await expect.poll(async () => (await note()).text).toBe("Draft mine\n\nFrom outside");
    await expect(page.locator(".note-editor")).toHaveText("Draft mineFrom outside");
  } finally {
    await helper.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a duplicate keeps its suffixed title in the first line through edits, and ⌘D copies it whole", async ({
  page,
}) => {
  const root = fs.mkdtempSync("/tmp/overnote-real-");
  const helper = new RealHelper(root);
  type Stored = { id: string; title: string; text: string; markdown: string; rawContent: string };
  const get = async (id: string) => (await helper.call("notes.get", { id })) as Stored;
  try {
    await helper.start();
    await bridgeTo(page, helper);
    await page.goto("http://127.0.0.1:5198/index.html");
    await expect(page.getByTestId("app")).toHaveAttribute("data-ready", "true");
    await expect(page.locator(".note-editor")).toBeFocused();
    await page.keyboard.type("# Groceries");
    await page.keyboard.press("Enter");
    await page.keyboard.type("milk");
    const original = (await page.getByTestId("app").getAttribute("data-note-id")) ?? "";
    await expect.poll(async () => (await get(original)).text).toBe("Groceries\n\nmilk");

    // Search Notes' Duplicate, as the extension sends it: content built by core, then the copy is current.
    const source = await get(original);
    const copy = (await helper.call("notes.duplicate", {
      id: original,
      ...duplicateContent(source, " (Copy)"),
    })) as Stored;
    await helper.call("notes.setCurrentNote", { noteId: copy.id });
    expect(copy).toMatchObject({
      title: "Groceries (Copy)",
      markdown: "# Groceries (Copy)\n\nmilk",
      text: "Groceries (Copy)\n\nmilk",
    });

    // The panel opens on the copy with the suffix in its first line, and an edit keeps the title.
    await page.reload();
    await expect(page.getByTestId("app")).toHaveAttribute("data-note-id", copy.id);
    await expect(page.getByTestId("title")).toHaveText("Groceries (Copy)");
    await expect(page.locator(".note-editor h1")).toHaveText("Groceries (Copy)");
    await page.locator(".note-editor p").last().click();
    await page.keyboard.press("End");
    await page.keyboard.type(" and eggs");
    await expect.poll(async () => (await get(copy.id)).text).toBe("Groceries (Copy)\n\nmilk and eggs");
    expect((await get(copy.id)).title).toBe("Groceries (Copy)");

    // ⌘D in the editor copies the note whole: no suffix, and title and first line still agree.
    await page.keyboard.press("Meta+d");
    await expect(page.getByTestId("notices")).toContainText("Note duplicated");
    await expect(page.getByTestId("app")).not.toHaveAttribute("data-note-id", copy.id);
    const second = (await page.getByTestId("app").getAttribute("data-note-id")) ?? "";
    const edited = await get(copy.id);
    expect(await get(second)).toMatchObject({
      title: edited.title,
      markdown: edited.markdown,
      text: edited.text,
      rawContent: edited.rawContent,
    });
    expect((await get(original)).title).toBe("Groceries");
  } finally {
    await helper.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
