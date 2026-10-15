/** Export file names: the display title plus the extension, made safe for macOS (spec/keymap.md 8.3). */
import { UNTITLED } from "@better-notes/core";

export function exportFileName(text: string, extension: "md" | "html" | "txt"): string {
  const firstLine = (text.split("\n").find((line) => line.trim()) ?? "").trim();
  const safe = firstLine
    .replace(/[/:\\]/g, "-")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 200)
    .trim();
  return `${safe || UNTITLED}.${extension}`;
}
