/** Motion helpers that respect the reduced motion preference and read durations from the CSS tokens. */

export type MotionToken = "--motion-fast" | "--motion" | "--motion-slow";

export function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * The current value of a motion token (theme.css) in milliseconds: 0 with reduced motion, where the
 * stylesheet sets every token to 0ms, or when the token is missing.
 */
export function motionMs(token: MotionToken): number {
  if (typeof getComputedStyle !== "function") return 0;
  const value = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  const amount = parseFloat(value);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return value.endsWith("ms") ? amount : value.endsWith("s") ? amount * 1000 : amount;
}

/**
 * How long to wait for an exit animation or transition of `token` before removing the element
 * anyway: its duration plus a little slack, so the animationend or transitionend event normally wins.
 * A zero duration fires no transition events, so the fallback is what removes the element then.
 */
export function exitFallbackMs(token: MotionToken): number {
  const ms = motionMs(token);
  return ms > 0 ? ms + 100 : 0;
}

/** Scrolls the selected row of `list` into view: smoothly for keyboard steps, at once on open or with reduced motion. */
export function revealSelected(list: HTMLElement | null, smooth: boolean): void {
  const row = list?.querySelector(".is-selected");
  if (!row) return;
  row.scrollIntoView({ block: "nearest", behavior: smooth && !prefersReducedMotion() ? "smooth" : "auto" });
}
