/**
 * Where a dropdown goes: next to its anchor, always inside the panel. Pure geometry, so the rules
 * are unit tested (unit/placement.test.ts); useDropdownPlacement (ui/hooks.ts) applies them.
 */

export interface Box {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface PlacementOptions {
  /** The side to use when the dropdown fits there. */
  prefer: "below" | "above";
  /** Space between the anchor and the dropdown. */
  gap: number;
  /** Which anchor edge the dropdown lines up with, before it is kept inside the bounds. */
  align: "start" | "center";
}

export interface Placement {
  top: number;
  left: number;
  /** The room on the chosen side; the dropdown scrolls inside when its content is taller. */
  maxHeight: number;
  maxWidth: number;
  side: "below" | "above";
}

/**
 * Places a dropdown of natural `size` next to `anchor`, inside `bounds` (all in one coordinate space).
 * It goes on the preferred side when it fits there, else on the other side when it fits there, else
 * on the side with more room, capped to that room. Horizontally it lines up with the anchor and
 * slides to stay inside the bounds.
 */
export function placeDropdown(
  anchor: Box,
  size: { width: number; height: number },
  bounds: Box,
  options: PlacementOptions,
): Placement {
  const room = {
    below: Math.max(0, bounds.bottom - anchor.bottom - options.gap),
    above: Math.max(0, anchor.top - options.gap - bounds.top),
  };
  const other = options.prefer === "below" ? "above" : "below";
  let side: "below" | "above" = options.prefer;
  if (size.height > room[options.prefer]) {
    if (size.height <= room[other] || room[other] > room[options.prefer]) side = other;
  }
  const maxHeight = Math.floor(room[side]);
  const height = Math.min(size.height, maxHeight);
  const top = side === "below" ? anchor.bottom + options.gap : anchor.top - options.gap - height;

  const maxWidth = Math.max(0, Math.floor(bounds.right - bounds.left));
  const width = Math.min(size.width, maxWidth);
  const wanted = options.align === "center" ? (anchor.left + anchor.right - width) / 2 : anchor.left;
  const left = Math.max(bounds.left, Math.min(wanted, bounds.right - width));
  return { top: Math.round(top), left: Math.round(left), maxHeight, maxWidth, side };
}
