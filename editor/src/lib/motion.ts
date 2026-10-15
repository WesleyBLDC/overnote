/** Motion helpers that respect the reduced motion preference. */

export function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Scrolls the selected row of `list` into view: smoothly for keyboard steps, at once on open or with reduced motion. */
export function revealSelected(list: HTMLElement | null, smooth: boolean): void {
  const row = list?.querySelector(".is-selected");
  if (!row) return;
  row.scrollIntoView({ block: "nearest", behavior: smooth && !prefersReducedMotion() ? "smooth" : "auto" });
}
