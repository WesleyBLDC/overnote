/** Small React hooks for notices, settings, and content-driven window height. */
import { DEFAULT_SETTINGS, type rpc, type Settings } from "@overnote/core";
import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import type { Api } from "../bridge/api";
import { exitFallbackMs, tokenMs } from "../lib/motion";
import { placeDropdown, type Box, type PlacementOptions } from "../lib/placement";
import type { NoticeAction, NoticeKind } from "../lib/notice";
import { noticesReducer } from "./noticeState";

/**
 * Notices: noticesReducer (noticeState.ts) holds the lifecycle, and this hook owns its timers. JS decides
 * when each notice leaves (NOTICE_MS for a polite notice, the dismiss button for an error), the stylesheet
 * decides how (the .notice[data-leaving] transition on --duration-slide). A notice is removed when its
 * exit transition ends, or by a fallback timer derived from the same token when no transition runs
 * (reduced motion). Each notice has at most one pending timer, cleared when it is replaced, when the
 * notice goes, and on unmount, so a second dismiss schedules nothing.
 */
export function useNotices() {
  const [notices, dispatch] = useReducer(noticesReducer, []);
  const next = useRef(1);
  const timers = useRef(new Map<number, { leaving: boolean; handle: ReturnType<typeof setTimeout> }>());
  const clear = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer.handle);
    timers.current.delete(id);
  }, []);
  const schedule = useCallback(
    (id: number, leaving: boolean, ms: number, run: () => void) => {
      clear(id);
      const handle = setTimeout(() => {
        timers.current.delete(id);
        run();
      }, ms);
      timers.current.set(id, { leaving, handle });
    },
    [clear],
  );
  const remove = useCallback(
    (id: number) => {
      clear(id);
      dispatch({ type: "remove", id });
    },
    [clear],
  );
  const dismiss = useCallback(
    (id: number) => {
      if (timers.current.get(id)?.leaving) return;
      dispatch({ type: "expire", id });
      schedule(id, true, exitFallbackMs("--duration-slide"), () => dispatch({ type: "remove", id }));
    },
    [schedule],
  );
  const notify = useCallback(
    (message: string, kind: NoticeKind = "info", action?: NoticeAction) => {
      const id = next.current++;
      dispatch({ type: "add", id, message, kind, action });
      // A toast stays --duration-toast (2.5 s), or --duration-toast-action (6 s) with an action; errors stay until dismissed.
      if (kind !== "error") {
        const ms = tokenMs(action ? "--duration-toast-action" : "--duration-toast");
        schedule(id, false, ms, () => dismiss(id));
      }
    },
    [schedule, dismiss],
  );
  /** Runs a toast's action, then lets the toast leave. */
  const act = useCallback(
    (id: number) => {
      const notice = notices.find((item) => item.id === id && !item.leaving);
      if (!notice?.action) return false;
      dismiss(id);
      notice.action.run();
      return true;
    },
    [notices, dismiss],
  );
  // A notice pushed out by a newer one drops its timer; unmounting drops them all.
  useEffect(() => {
    const live = new Set(notices.map((notice) => notice.id));
    for (const id of timers.current.keys()) if (!live.has(id)) clear(id);
  }, [notices, clear]);
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer.handle);
      pending.clear();
    };
  }, []);
  return { notices, notify, remove, dismiss, act };
}

/** Settings from system.ready and settings.changed, with optimistic local updates. */
export function useSettings(api: Api) {
  const [settings, setSettings] = useState<Settings>({ ...DEFAULT_SETTINGS });
  useEffect(() => api.on("settings.changed", (next) => setSettings({ ...DEFAULT_SETTINGS, ...next })), [api]);
  const update = useCallback(
    (patch: Partial<Settings>) => {
      setSettings((current) => ({ ...current, ...patch }));
      // On failure, show what is really stored instead of the optimistic value.
      void api.settings.set(patch).catch(() =>
        api.settings
          .get()
          .then((stored) => setSettings({ ...DEFAULT_SETTINGS, ...stored }))
          .catch(() => undefined),
      );
    },
    [api],
  );
  /** Every setting back to its default; the helper also puts the window back to its first open frame. */
  const reset = useCallback(async () => {
    setSettings({ ...DEFAULT_SETTINGS, ...(await api.settings.reset()) });
  }, [api]);
  return { settings, setSettings, update, reset };
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

/** Room kept for the title when the panel is at its narrowest, in rem, so a few characters always show. */
const TITLE_MIN_REM = 6;

/** The width of a bar's contents: its children side by side, with their margins, the gaps, and its padding. */
function contentWidth(element: Element | null): number {
  if (!element) return 0;
  const style = getComputedStyle(element);
  const children = (Array.from(element.children) as HTMLElement[]).filter((child) => {
    const childStyle = getComputedStyle(child);
    return childStyle.display !== "none" && childStyle.position !== "absolute" && childStyle.position !== "fixed";
  });
  let total = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
  for (const child of children) {
    const childStyle = getComputedStyle(child);
    // A sideways scroller (the format bar at high zoom) shrinks to the panel, so count what it holds,
    // not its box: measuring the box would make the minimum follow the panel one point at a time.
    const scrolls = childStyle.overflowX === "auto" || childStyle.overflowX === "scroll";
    total +=
      (scrolls ? contentWidth(child) : child.getBoundingClientRect().width) +
      parseFloat(childStyle.marginLeft) +
      parseFloat(childStyle.marginRight);
  }
  return total + (parseFloat(style.columnGap) || 0) * Math.max(0, children.length - 1);
}

/**
 * The smallest panel that still shows the toolbar and one line of the note, in points (CSS px, which
 * already include zoom): the toolbar with its controls and some of the title, one line of note text with
 * the content's padding (the bottom padding is the room for the overlaid count pill and format island),
 * and, while it shows, the whole format island between its side margins.
 */
export function measureMinimumSize(app: HTMLElement): { width: number; height: number } | null {
  const toolbar = app.querySelector<HTMLElement>(".toolbar");
  const footer = app.querySelector<HTMLElement>(".footer");
  const content = app.querySelector<HTMLElement>(".content");
  const note = app.querySelector<HTMLElement>(".note-editor");
  if (!toolbar || !footer || !content || !note) return null;
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 14;
  const bar = getComputedStyle(toolbar);
  const sides = Math.max(
    contentWidth(toolbar.querySelector(".toolbar-leading")),
    contentWidth(toolbar.querySelector(".toolbar-actions")),
  );
  const toolbarWidth =
    parseFloat(bar.paddingLeft) +
    parseFloat(bar.paddingRight) +
    2 * sides +
    2 * (parseFloat(bar.columnGap) || 0) +
    TITLE_MIN_REM * rem;
  // The bottom row: the centred island with room for Aa on both sides (the count gives way first when narrow).
  const island = footer.querySelector<HTMLElement>(".format-bar");
  const aa = footer.querySelector<HTMLElement>(".corner-aa");
  const footerBox = footer.getBoundingClientRect();
  const side = aa
    ? footerBox.right -
      aa.getBoundingClientRect().left +
      parseFloat(getComputedStyle(footer.querySelector(".corner")!).columnGap || "0")
    : 0;
  const footerWidth = (island ? island.offsetWidth : 0) + 2 * side;
  const inner = getComputedStyle(content);
  const height =
    toolbar.getBoundingClientRect().height +
    parseFloat(inner.paddingTop) +
    parseFloat(inner.paddingBottom) +
    parseFloat(getComputedStyle(note).lineHeight);
  if (!Number.isFinite(height) || height <= 0) return null;
  return { width: Math.ceil(Math.max(toolbarWidth, footerWidth)), height: Math.ceil(height) };
}

/**
 * Tells the helper the smallest the panel may be (window.setMinimumSize): the bars plus one line at
 * the current zoom. It reports again whenever a bar changes size, for example on a zoom change or when
 * the format island shows; the helper keeps at least 405 x 197 and grows a smaller panel.
 */
export function useMinimumSizeReporter(app: HTMLElement | null, api: Api) {
  useEffect(() => {
    if (!app) return;
    let last = "";
    let scheduled = false;
    const report = () => {
      scheduled = false;
      const size = measureMinimumSize(app);
      if (!size) return;
      const key = `${size.width}x${size.height}`;
      if (key === last) return;
      last = key;
      void api.window.setMinimumSize(size.width, size.height).catch(() => undefined);
    };
    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(report);
    };
    const resizes = new ResizeObserver(schedule);
    const observeBars = () => {
      resizes.disconnect();
      for (const bar of Array.from(app.querySelectorAll(".toolbar, .toolbar-actions, .footer, .corner, .format-bar"))) {
        resizes.observe(bar);
      }
    };
    const mutations = new MutationObserver(() => {
      observeBars();
      schedule();
    });
    const footer = app.querySelector(".footer");
    if (footer) mutations.observe(footer, { childList: true, subtree: true });
    observeBars();
    schedule();
    return () => {
      resizes.disconnect();
      mutations.disconnect();
    };
  }, [app, api]);
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
/** The top bar that drags the window: the full-panel terminal's header while it shows (SPEC §12), else the toolbar. */
function dragBar(app: HTMLElement): HTMLElement | null {
  return (
    app.querySelector<HTMLElement>("[data-expanded] > .terminal-header") ??
    app.querySelector<HTMLElement>("[data-testid=toolbar]")
  );
}

export function computeDragRegions(app: HTMLElement): rpc.DragRect[] {
  const toolbar = dragBar(app);
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
export function useDragRegions(app: HTMLElement | null, api: Api, zoom: number, terminalExpanded = false) {
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
      const toolbar = dragBar(app);
      if (!toolbar) return;
      observer.observe(toolbar);
      for (const part of Array.from(
        toolbar.querySelectorAll(
          `${INTERACTIVE}, .toolbar-actions, .toolbar-leading, .terminal-leading, .terminal-actions`,
        ),
      ))
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
  }, [app, api, zoom, terminalExpanded]);
}

/**
 * Marks the app with data-scroll="top" and or "bottom" while the note has content above or below
 * the visible area, for the scroll fades and the toolbar hairline, and with "title" once the note's
 * first line has scrolled out of view, so the toolbar fades the title in. It writes the attribute directly
 * (no React render) and only when the value changes.
 */
export function useScrollEdges(app: HTMLElement | null) {
  useEffect(() => {
    const content = app?.querySelector<HTMLElement>(".content");
    if (!app || !content) return;
    const update = () => {
      const top = content.scrollTop > 1;
      const bottom = content.scrollTop + content.clientHeight < content.scrollHeight - 1;
      const first = content.querySelector(".note-editor > :first-child");
      const title = top && !!first && first.getBoundingClientRect().bottom <= content.getBoundingClientRect().top + 1;
      const value = [top ? "top" : "", bottom ? "bottom" : "", title ? "title" : ""].filter(Boolean).join(" ");
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

/**
 * Keeps a dropdown (slash menu, emoji picker, link popover, format menu) inside the panel: next to
 * its anchor on the preferred side when it fits, else on the roomier side, capped to the room there
 * so it scrolls inside, and slid sideways to stay clear of the panel's edges. The panel never
 * resizes for a dropdown, so nothing it draws can ever cross the panel's edge or border.
 *
 * `anchor` returns the anchor's box in viewport coordinates, and `gapRem` is the space between the
 * two, in rem so it follows zoom. The dropdown must be absolutely
 * positioned in the app; the hook writes its top, left, and data-side, plus --room-y and --room-x,
 * which the stylesheet uses as its maximum height and width. It places again on every render,
 * when the dropdown or the panel changes size, and when anything scrolls.
 */
export function useDropdownPlacement(
  ref: React.RefObject<HTMLElement | null>,
  anchor: () => Box | null,
  options: DropdownOptions,
) {
  const place = useLatest(() => placeDropdownElement(ref.current, anchor(), options));

  useLayoutEffect(() => place.current());

  useEffect(() => {
    const element = ref.current;
    const container = element?.offsetParent;
    if (!element) return;
    const update = () => place.current();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    if (container) observer.observe(container);
    // The anchor moves when the note scrolls; the dropdown's own scrolling does not move it.
    const onScroll = (event: Event) => {
      if (!(event.target instanceof Node && element.contains(event.target))) update();
    };
    window.addEventListener("resize", update);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [ref, place]);
}

type DropdownOptions = Omit<PlacementOptions, "gap"> & { gapRem: number };

/** What each dropdown was last placed for, so a pass with nothing new leaves it alone. */
const placedFor = new WeakMap<HTMLElement, string>();

/**
 * One placement pass for useDropdownPlacement: measures, places, and writes the result to the
 * element. Measuring lifts the previous cap, which makes WebKit drop the scroll position, so a pass
 * only measures when the anchor, the panel, or the dropdown changed, and keeps the scroll positions.
 */
function placeDropdownElement(element: HTMLElement | null, target: Box | null, options: DropdownOptions) {
  const container = element?.offsetParent;
  if (!element || !(container instanceof HTMLElement) || !target) return;
  const style = getComputedStyle(document.documentElement);
  const rem = parseFloat(style.fontSize) || 14;
  const token = (name: string, fallback: number) => parseFloat(style.getPropertyValue(name)) || fallback;
  // Clear of the native drag strip on top, and of the 10 point resize zones elsewhere.
  const inset = Math.max(token("--edge-zone", 10), 0.5 * rem);
  const bounds = {
    top: token("--drag-strip", 12) + 0.25 * rem,
    bottom: container.clientHeight - inset,
    left: inset,
    right: container.clientWidth - inset,
  };
  const box = container.getBoundingClientRect();
  const anchor = {
    top: target.top - box.top,
    bottom: target.bottom - box.top,
    left: target.left - box.left,
    right: target.right - box.left,
  };
  const inputs = () =>
    [
      anchor.top,
      anchor.bottom,
      anchor.left,
      anchor.right,
      bounds.right,
      bounds.bottom,
      element.offsetWidth,
      element.offsetHeight,
      element.scrollHeight,
    ]
      .map(Math.round)
      .join(" ");
  if (placedFor.get(element) === inputs()) return;
  const scrolled = [element, ...Array.from(element.children)].map((node) => [node, node.scrollTop] as const);
  // The natural size, without the previous cap; layout sizes ignore the entrance transform.
  element.style.removeProperty("--room-y");
  element.style.removeProperty("--room-x");
  const size = { width: element.offsetWidth, height: element.offsetHeight };
  const { gapRem, ...rest } = options;
  const placement = placeDropdown(anchor, size, bounds, { ...rest, gap: gapRem * rem });
  element.style.setProperty("--room-y", `${placement.maxHeight}px`);
  element.style.setProperty("--room-x", `${placement.maxWidth}px`);
  element.style.top = `${placement.top}px`;
  element.style.left = `${placement.left}px`;
  element.dataset.side = placement.side;
  for (const [node, top] of scrolled) if (node.scrollTop !== top) node.scrollTop = top;
  placedFor.set(element, inputs());
}

/**
 * Marks the app with data-near-bottom while the pointer is over the bottom row, so the format island fades in
 * there (SPEC §5). It writes the attribute directly: a pointer move never re-renders React.
 */
export function useNearBottom(app: HTMLElement | null) {
  useEffect(() => {
    if (!app) return;
    const set = (near: boolean) => {
      if (near) app.dataset.nearBottom = "";
      else delete app.dataset.nearBottom;
    };
    const move = (event: PointerEvent) => {
      const footer = app.querySelector(".footer");
      if (!footer) return set(false);
      const box = footer.getBoundingClientRect();
      set(event.clientY >= box.top && event.clientY <= box.bottom);
    };
    const leave = () => set(false);
    app.addEventListener("pointermove", move);
    app.addEventListener("pointerleave", leave);
    return () => {
      app.removeEventListener("pointermove", move);
      app.removeEventListener("pointerleave", leave);
      set(false);
    };
  }, [app]);
}
