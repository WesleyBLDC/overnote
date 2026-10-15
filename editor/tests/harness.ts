/** Shared helpers for the end-to-end flows: open the harness, read the mock, read the editor. */
import { expect, type Page } from "@playwright/test";

export interface RecordedCall {
  method: string;
  params: Record<string, unknown>;
  at: number;
}

/** Opens the dev harness with the given notes (Markdown, newest last), or none. */
export async function openHarness(page: Page, notes: string[] = []): Promise<void> {
  const seed = notes.length ? encodeURIComponent(JSON.stringify(notes)) : "empty";
  await page.goto(`/?seed=${seed}`);
  await expect(page.getByTestId("app")).toHaveAttribute("data-ready", "true");
  await page.locator(".note-editor").focus();
}

export function editor(page: Page) {
  return page.locator(".note-editor");
}

export async function calls(page: Page, method?: string): Promise<RecordedCall[]> {
  return page.evaluate((name) => {
    const mock = (window as unknown as { __overnoteMock: { calls: RecordedCall[] } }).__overnoteMock;
    return mock.calls.filter((call) => !name || call.method === name);
  }, method);
}

export async function clearCalls(page: Page): Promise<void> {
  await page.evaluate(() =>
    (window as unknown as { __overnoteMock: { clearCalls(): void } }).__overnoteMock.clearCalls(),
  );
}

export async function emit(page: Page, event: string, payload: unknown): Promise<void> {
  await page.evaluate(
    ([name, data]) =>
      (window as unknown as { __overnoteMock: { emit(e: string, p: unknown): void } }).__overnoteMock.emit(
        name as string,
        data,
      ),
    [event, payload] as const,
  );
}

/** The editor document as JSON. */
export async function docJSON(page: Page): Promise<{ type: string; content?: Node[] }> {
  return page.evaluate(() =>
    (window as unknown as { __bnEditor: { getJSON(): { type: string } } }).__bnEditor.getJSON(),
  );
}

interface Node {
  type: string;
  attrs?: Record<string, unknown>;
  content?: Node[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
}

/** Top-level block types, with list kinds spelled out, for compact assertions. */
export async function blocks(page: Page): Promise<string[]> {
  const doc = await docJSON(page);
  return (doc.content ?? []).map((node) => (node.type === "list" ? `list:${String(node.attrs?.kind)}` : node.type));
}

/** Notes stored in the mock, newest update first. */
export async function storedNotes(
  page: Page,
): Promise<
  { id: string; title: string; text: string; markdown: string; pinned: number | null; deletedAt: number | null }[]
> {
  return page.evaluate(() => {
    const mock = (window as unknown as { __overnoteMock: { store: { notes: Map<string, { updatedAt: number }> } } })
      .__overnoteMock;
    return [...mock.store.notes.values()].sort((a, b) => b.updatedAt - a.updatedAt) as never;
  });
}

/** Waits for autosave and returns the last notes.update params. */
export async function lastSave(page: Page): Promise<Record<string, unknown>> {
  await expect
    .poll(async () => (await calls(page, "notes.update")).filter((c) => "rawContent" in c.params).length)
    .toBeGreaterThan(0);
  const saves = (await calls(page, "notes.update")).filter((c) => "rawContent" in c.params);
  return saves[saves.length - 1]?.params ?? {};
}

export const isMac = process.platform === "darwin";
