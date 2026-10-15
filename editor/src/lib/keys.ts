/** Matching keyboard events by event.code, so ⌥ combinations work on every layout. */

export interface Shortcut {
  code: string | string[];
  meta?: boolean;
  shift?: boolean;
  alt?: boolean;
  ctrl?: boolean;
}

export function matches(event: KeyboardEvent, shortcut: Shortcut): boolean {
  const codes = Array.isArray(shortcut.code) ? shortcut.code : [shortcut.code];
  return (
    codes.includes(event.code) &&
    event.metaKey === Boolean(shortcut.meta) &&
    event.shiftKey === Boolean(shortcut.shift) &&
    event.altKey === Boolean(shortcut.alt) &&
    event.ctrlKey === Boolean(shortcut.ctrl)
  );
}

/** ⌘1 through ⌘9: the slot number, or null. */
export function pinSlot(event: KeyboardEvent): number | null {
  if (!event.metaKey || event.shiftKey || event.altKey || event.ctrlKey) return null;
  const match = /^Digit([1-9])$/.exec(event.code);
  return match ? Number(match[1]) : null;
}
