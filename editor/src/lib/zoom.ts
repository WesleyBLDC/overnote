import { ZOOM } from "@better-notes/core";

/** Rounds to the 5% grid and clamps to 75% to 200%. */
export function clampZoom(value: number): number {
  const stepped = Math.round(value / ZOOM.step) * ZOOM.step;
  return Math.min(ZOOM.max, Math.max(ZOOM.min, Number(stepped.toFixed(2))));
}

export function stepZoom(current: number, direction: 1 | -1): number {
  return clampZoom(current + direction * ZOOM.step);
}

export function zoomLabel(zoom: number): string {
  return `${Math.round(zoom * 100)}%`;
}
