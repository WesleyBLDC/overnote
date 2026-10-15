/** Export file names: the display title plus the extension, made safe for macOS. */
import { UNTITLED } from "@overnote/core";

export function exportFileName(text: string, extension: "md" | "html" | "txt"): string {
  const firstLine = (text.split("\n").find((line) => line.trim()) ?? "").trim();
  const safe = firstLine
    .replace(/[/:\\]/g, "-")
    .replace(/\p{Cc}/gu, "")
    .replace(/^\.+/, "")
    .trim();
  // Whole code points, so a surrogate pair is never split; the helper caps the bytes.
  const short = Array.from(safe).slice(0, 200).join("").trim();
  return `${short || UNTITLED}.${extension}`;
}
