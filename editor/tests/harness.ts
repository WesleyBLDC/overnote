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
  // For 200 ms after a focus, ProseMirror takes a caret that lands on the document start for a
  // browser reset and puts it back, so a quick ⌘← in the first note would be undone. A person
  // never types that fast after the panel opens; let that window pass.
  await page.waitForFunction(() => {
    const view = (window as unknown as { __bnEditor?: { view: { input?: { lastFocus?: number } } } }).__bnEditor?.view;
    return Date.now() - (view?.input?.lastFocus ?? 0) > 250;
  });
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

/**
 * Freezes the fake clock (installed with `page.clock.install()` before `openHarness`), so timers
 * fire only through `page.clock.runFor`. CSS animations and transitions still run in real time, so
 * a test can tell an element removed by its animation end event from one removed by a timer.
 */
export async function pauseClock(page: Page): Promise<void> {
  // The clock keeps flowing until it is paused, so the target can be in the past by the time it
  // arrives; then try again from the new time.
  for (let attempt = 0; ; attempt++) {
    try {
      await page.clock.pauseAt(await page.evaluate(() => Date.now() + 20));
      return;
    } catch (error) {
      if (attempt >= 20 || !String(error).includes("to the past")) throw error;
    }
  }
}

/**
 * Waits until the page is quiet instead of for a fixed time: every finite animation and transition
 * has finished, the mock bridge has answered, ResizeObserver has delivered, and the recorded calls
 * stopped changing. For assertions that something did not happen.
 */
export async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const mock = (window as unknown as { __overnoteMock?: { calls: unknown[]; latency: number } }).__overnoteMock;
    const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const finite = () =>
      document.getAnimations().filter((animation) => {
        const iterations = animation.effect?.getComputedTiming().iterations;
        return animation.playState === "running" && iterations !== Infinity;
      });
    let previous = -1;
    for (let quiet = 0; quiet < 2;) {
      await Promise.all(finite().map((animation) => animation.finished.catch(() => undefined)));
      await frame();
      await frame();
      // Longer than the mock's reply latency, so a reply and the resize it causes are in.
      await new Promise((resolve) => setTimeout(resolve, (mock?.latency ?? 0) * 4));
      const count = mock?.calls.length ?? 0;
      quiet = count === previous ? quiet + 1 : 0;
      previous = count;
    }
  });
}
