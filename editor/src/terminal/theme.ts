/**
 * The terminal's colors, read from the theme tokens (theme.css), so the drawer follows Graphite and the light or
 * dark appearance. xterm.js needs real color strings, so each token is resolved through a probe element.
 */
import type { ITheme } from "@xterm/xterm";

const TOKENS: Partial<Record<keyof ITheme, string>> = {
  background: "--terminal-bg",
  foreground: "--terminal-text",
  cursor: "--terminal-cursor",
  cursorAccent: "--terminal-bg",
  selectionBackground: "--terminal-selection",
  black: "--text-tertiary",
  red: "--danger",
  green: "--success",
  yellow: "--warning",
  // The design maps ANSI blue and magenta (and cyan with them) to the accent, so prompts and links stay neutral.
  blue: "--accent-strong",
  magenta: "--accent-strong",
  cyan: "--accent-strong",
  white: "--text-secondary",
  brightBlack: "--text-tertiary",
  brightRed: "--danger",
  brightGreen: "--success",
  brightYellow: "--warning",
  brightBlue: "--accent-strong",
  brightMagenta: "--accent-strong",
  brightCyan: "--accent-strong",
  brightWhite: "--text",
};

export function terminalTheme(within: HTMLElement): ITheme {
  const probe = document.createElement("span");
  probe.style.display = "none";
  within.appendChild(probe);
  const theme: Record<string, string> = {};
  for (const [key, token] of Object.entries(TOKENS)) {
    probe.style.color = `var(${token})`;
    theme[key] = getComputedStyle(probe).color;
  }
  probe.remove();
  return theme as ITheme;
}

export function terminalFont(): string {
  return getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim() || "monospace";
}
