/** Small React hooks for notices, settings, and content-driven window height. */
import { DEFAULT_SETTINGS, type rpc, type Settings } from "@overnote/core";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Api } from "../bridge/api";
import { exitFallbackMs } from "../lib/motion";

export type NoticeKind = "info" | "error";

export interface Notice {
  id: number;
  message: string;
  kind: NoticeKind;
  /** Set when the notice's time is up: the stylesheet fades it out, then it is removed. */
  leaving: boolean;
}

/** How long a notice stays before it starts to leave. */
export const NOTICE_MS = 2000;

/**
 * Notices: JS decides when each one leaves (NOTICE_MS), the stylesheet decides how (the
 * .notice[data-leaving] transition on --motion-slow). A notice is removed when its exit transition
 * ends, or by a fallback timer derived from the same token when no transition runs (reduced motion).
 */
export function useNotices() {
  const [notices, setNotices] = useState<Notice[]>([]);
  const next = useRef(1);
  const remove = useCallback((id: number) => setNotices((list) => list.filter((notice) => notice.id !== id)), []);
  const notify = useCallback(
    (message: string, kind: NoticeKind = "info") => {
      const id = next.current++;
      setNotices((list) => [...list.slice(-2), { id, message, kind, leaving: false }]);
      setTimeout(() => {
        setNotices((list) => list.map((notice) => (notice.id === id ? { ...notice, leaving: true } : notice)));
        setTimeout(() => remove(id), exitFallbackMs("--motion-slow"));
      }, NOTICE_MS);
    },
    [remove],
  );
  return { notices, notify, remove };
}

/** Settings from system.ready and settings.changed, with optimistic local updates. */
export function useSettings(api: Api) {
  const [settings, setSettings] = useState<Settings>({ ...DEFAULT_SETTINGS });
  useEffect(() => api.on("settings.changed", (next) => setSettings({ ...DEFAULT_SETTINGS, ...next })), [api]);
  const update = useCallback(
    (patch: Partial<Settings>) => {
      setSettings((current) => ({ ...current, ...patch }));
      void api.settings.set(patch).catch(() => undefined);
    },
    [api],
  );
  return { settings, setSettings, update };
}

export interface ResizeOptions {
  autoSize: boolean;
  /** Room an open panel, dialog, or popup needs, in rem; null when none is open. */
  overlayRem: number | null;
}

/** The content height of the window: every bar plus the editor's natural height, ignoring the stretch. */
export function measureContentHeight(app: HTMLElement): number {
  let total = 0;
  for (const child of Array.from(app.children) as HTMLElement[]) {
    const style = getComputedStyle(child);
    if (style.position === "absolute" || style.position === "fixed" || style.display === "none") continue;
    const margins = parseFloat(style.marginTop) + parseFloat(style.marginBottom);
    if (child.classList.contains("content")) {
      const inner = child.firstElementChild as HTMLElement | null;
      total += (inner?.offsetHeight ?? 0) + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + margins;
    } else {
      total += child.offsetHeight + margins;
    }
  }
  return Math.ceil(total);
}

/**
 * Reports the content height to the helper. Heights are CSS pixels, which already include zoom
 * because zoom scales the root font size, so they equal points in the panel.
 * Measuring happens right in the ResizeObserver callback (not in requestAnimationFrame, which hidden
 * WebKit windows pause), coalesced to one report per microtask.
 * While an overlay is open the report is temporary and at least as tall as the overlay needs; it is
 * sent even with auto-sizing off, and a normal report follows when the overlay closes. When the panel
 * is already tall enough for the overlay, nothing is sent: the overlay opens and scrolls inside the
 * current window, so a roomy panel never resizes for ⌘K or browse.
 */
export function useResizeReporter(app: HTMLElement | null, api: Api, options: ResizeOptions) {
  const last = useRef<{ height: number; temporary: boolean } | null>(null);
  const { autoSize, overlayRem } = options;
  useEffect(() => {
    if (!app) return;
    let scheduled = false;
    const report = () => {
      scheduled = false;
      const natural = measureContentHeight(app);
      const temporary = overlayRem !== null;
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 14;
      const height = temporary ? Math.max(natural, Math.ceil(overlayRem * rem)) : natural;
      const previous = last.current;
      if (height <= 0) return;
      if (previous && previous.height === height && previous.temporary === temporary) return;
      if (temporary && !previous?.temporary && app.getBoundingClientRect().height >= height) return;
      if (!temporary && !autoSize && !previous?.temporary) return;
      last.current = { height, temporary };
      void api.window.resize(height, temporary).catch(() => undefined);
    };
    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(report);
    };
    const observer = new ResizeObserver(schedule);
    const observeAll = () => {
      observer.disconnect();
      observer.observe(app);
      for (const child of Array.from(app.children)) {
        observer.observe(child);
        if (child.classList.contains("content") && child.firstElementChild) observer.observe(child.firstElementChild);
      }
    };
    observeAll();
    const mutations = new MutationObserver(() => {
      observeAll();
      schedule();
    });
    mutations.observe(app, { childList: true });
    schedule();
    return () => {
      observer.disconnect();
      mutations.disconnect();
    };
  }, [app, api, autoSize, overlayRem]);
}

const INTERACTIVE = "button, a[href], input, select, textarea, [role=button], [contenteditable=true]";

/** The parts of `rect` not covered by `hole`: up to four rectangles (above, below, left, right). */
function subtract(rect: rpc.DragRect, hole: rpc.DragRect): rpc.DragRect[] {
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;
  const holeRight = hole.x + hole.width;
  const holeBottom = hole.y + hole.height;
  if (hole.x >= right || holeRight <= rect.x || hole.y >= bottom || holeBottom <= rect.y) return [rect];
  const top = Math.max(rect.y, hole.y);
  const low = Math.min(bottom, holeBottom);
  const pieces: rpc.DragRect[] = [
    { x: rect.x, y: rect.y, width: rect.width, height: top - rect.y },
    { x: rect.x, y: low, width: rect.width, height: bottom - low },
    { x: rect.x, y: top, width: Math.max(rect.x, hole.x) - rect.x, height: low - top },
    { x: Math.min(right, holeRight), y: top, width: right - Math.min(right, holeRight), height: low - top },
  ];
  return pieces.filter((piece) => piece.width > 0 && piece.height > 0);
}

/**
 * The toolbar area that should drag the window: the toolbar's bounds minus every control in it,
 * in points (CSS px, which already include zoom) with a top-left origin at the panel's corner.
 * Edges are rounded outward for controls so a click on a control's edge never starts a drag.
 */
export function computeDragRegions(app: HTMLElement): rpc.DragRect[] {
  const toolbar = app.querySelector<HTMLElement>("[data-testid=toolbar]");
  if (!toolbar) return [];
  const origin = app.getBoundingClientRect();
  const box = toolbar.getBoundingClientRect();
  let rects: rpc.DragRect[] = [
    {
      x: Math.round(box.left - origin.left),
      y: Math.round(box.top - origin.top),
      width: Math.round(box.width),
      height: Math.round(box.height),
    },
  ];
  for (const control of Array.from(toolbar.querySelectorAll<HTMLElement>(INTERACTIVE))) {
    const r = control.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const x = Math.floor(r.left - origin.left);
    const y = Math.floor(r.top - origin.top);
    const hole = { x, y, width: Math.ceil(r.right - origin.left) - x, height: Math.ceil(r.bottom - origin.top) - y };
    rects = rects.flatMap((rect) => subtract(rect, hole));
  }
  return rects;
}

/**
 * Sends the toolbar's drag regions to the helper (window.setDragRegions): on load, when the panel or
 * any toolbar part resizes, when zoom changes, and when the hover chrome shows or hides. Identical
 * regions are sent once.
 */
export function useDragRegions(app: HTMLElement | null, api: Api, zoom: number) {
  const last = useRef<string | null>(null);
  useEffect(() => {
    if (!app) return;
    let scheduled = false;
    const report = () => {
      scheduled = false;
      const rects = computeDragRegions(app);
      const key = JSON.stringify(rects);
      if (key === last.current) return;
      last.current = key;
      void api.window.setDragRegions(rects).catch(() => {
        last.current = null;
      });
    };
    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(report);
    };
    const observer = new ResizeObserver(schedule);
    const observeToolbar = () => {
      observer.disconnect();
      observer.observe(app);
      const toolbar = app.querySelector("[data-testid=toolbar]");
      if (!toolbar) return;
      observer.observe(toolbar);
      for (const part of Array.from(toolbar.querySelectorAll(`${INTERACTIVE}, .toolbar-actions, .toolbar-leading`)))
        observer.observe(part);
    };
    observeToolbar();
    const mutations = new MutationObserver(() => {
      observeToolbar();
      schedule();
    });
    mutations.observe(app, { childList: true, subtree: false });
    const toolbar = app.querySelector("[data-testid=toolbar]");
    if (toolbar)
      mutations.observe(toolbar, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["class", "hidden", "disabled"],
      });
    // The hover chrome fades in and out; its transition end is when the controls settle.
    app.addEventListener("mouseenter", schedule);
    app.addEventListener("mouseleave", schedule);
    app.addEventListener("transitionend", schedule);
    window.addEventListener("resize", schedule);
    schedule();
    return () => {
      observer.disconnect();
      mutations.disconnect();
      app.removeEventListener("mouseenter", schedule);
      app.removeEventListener("mouseleave", schedule);
      app.removeEventListener("transitionend", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [app, api, zoom]);
}

/**
 * Marks the app with data-scroll="top" and or "bottom" while the note has content above or below
 * the visible area, for the scroll fades and the toolbar hairline. It writes the attribute directly
 * (no React render) and only when the value changes.
 */
export function useScrollEdges(app: HTMLElement | null) {
  useEffect(() => {
    const content = app?.querySelector<HTMLElement>(".content");
    if (!app || !content) return;
    const update = () => {
      const top = content.scrollTop > 1;
      const bottom = content.scrollTop + content.clientHeight < content.scrollHeight - 1;
      const value = [top ? "top" : "", bottom ? "bottom" : ""].filter(Boolean).join(" ");
      if ((app.getAttribute("data-scroll") ?? "") === value) return;
      if (value) app.setAttribute("data-scroll", value);
      else app.removeAttribute("data-scroll");
    };
    const observer = new ResizeObserver(update);
    observer.observe(content);
    if (content.firstElementChild) observer.observe(content.firstElementChild);
    content.addEventListener("scroll", update, { passive: true });
    update();
    return () => {
      observer.disconnect();
      content.removeEventListener("scroll", update);
    };
  }, [app]);
}

/** Keeps a ref pointing at the latest value, for callbacks created once. */
export function useLatest<T>(value: T) {
  const ref = useRef(value);
  // Updated after each commit, before the browser paints or dispatches the next event.
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}
