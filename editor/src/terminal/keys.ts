/**
 * Which keys leave the terminal drawer (docs/architecture.md, the terminal drawer).
 * Overnote's shortcuts listen before xterm.js, and some of them would wreck a shell session (⌃X deletes the
 * current note, yet it is the emacs prefix and nano's exit). So while the terminal has focus, only this short
 * allowlist reaches Overnote; every other key, Esc included, goes to the shell.
 */
import { matches, type Shortcut } from "../lib/keys";

/** ⌃` opens the drawer from the note and closes it from the terminal. */
export const TOGGLE_TERMINAL: Shortcut = { code: "Backquote", ctrl: true };

const ALLOWED: Shortcut[] = [
  TOGGLE_TERMINAL,
  { code: "KeyK", meta: true },
  { code: "KeyN", meta: true },
  { code: "KeyW", meta: true },
  { code: "KeyC", meta: true },
  { code: "KeyV", meta: true },
  { code: "KeyQ", meta: true },
  // The window placements: Fill Left, Fill Right, Fill Screen, and Centre.
  { code: ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"], ctrl: true, alt: true },
];

/** Whether a key pressed in the terminal goes to Overnote instead of the shell. */
export function reachesOvernote(event: KeyboardEvent): boolean {
  return ALLOWED.some((shortcut) => matches(event, shortcut));
}

/** Whether an event target sits inside the terminal drawer. */
export function inTerminal(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(".terminal-drawer") !== null;
}
