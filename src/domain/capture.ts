export interface CaptureSources {
  /** `launchContext.text`, from a deeplink or another command. */
  contextText?: string | null;
  /** The command's `text` argument. */
  argument?: string | null;
  /** Raycast's `fallbackText`, set when the command runs as a fallback command. */
  fallbackText?: string | null;
  /** Reads the frontmost app's selection; it throws or rejects when nothing is selected. */
  getSelectedText?: () => Promise<string>;
}

export type CaptureSource = "context" | "argument" | "fallbackText" | "selection" | "empty";

/**
 * Picks the text for a new note: launch context text, then the argument, then fallbackText, then
 * the selected text, then empty (docs/architecture.md section 8).
 */
export async function resolveCaptureText(sources: CaptureSources): Promise<{ text: string; source: CaptureSource }> {
  if (hasText(sources.contextText)) return { text: sources.contextText, source: "context" };
  if (hasText(sources.argument)) return { text: sources.argument, source: "argument" };
  if (hasText(sources.fallbackText)) return { text: sources.fallbackText, source: "fallbackText" };
  if (sources.getSelectedText) {
    try {
      const selected = await sources.getSelectedText();
      if (hasText(selected)) return { text: selected, source: "selection" };
    } catch {
      // No selection, or no accessibility permission: fall through to an empty note.
    }
  }
  return { text: "", source: "empty" };
}

function hasText(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
