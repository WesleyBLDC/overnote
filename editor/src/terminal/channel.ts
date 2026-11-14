/**
 * The terminal fast lane (docs/architecture.md section 3): keystrokes and acks go to
 * window.webkit.messageHandlers.overnoteTerm, fire and forget, so they never wait behind a note save on the
 * main bridge. Bytes travel as base64 both ways.
 */
import { rpc } from "@overnote/core";

interface FastPort {
  postMessage(message: rpc.TermFastMessage): void;
}

interface FastWindow {
  webkit?: { messageHandlers?: Record<string, FastPort | undefined> };
}

export function postTerm(message: rpc.TermFastMessage): void {
  const port = (window as unknown as FastWindow).webkit?.messageHandlers?.[rpc.TERMINAL_HANDLER];
  try {
    port?.postMessage(message);
  } catch {
    // The helper is gone; the drawer shows the exit when it comes back.
  }
}

export function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function decodeBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** xterm.js reports binary input (some mouse modes) as a string of one byte per character. */
export function binaryBytes(data: string): Uint8Array {
  const bytes = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) bytes[i] = data.charCodeAt(i) & 0xff;
  return bytes;
}
