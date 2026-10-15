/** Small React hooks for notices, settings, and content-driven window height. */
import { DEFAULT_SETTINGS, type Settings } from "@better-notes/core";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { Api } from "../bridge/api";

export type NoticeKind = "info" | "error";

export interface Notice {
  id: number;
  message: string;
  kind: NoticeKind;
}

export const NOTICE_MS = 2200;

export function useNotices() {
  const [notices, setNotices] = useState<Notice[]>([]);
  const next = useRef(1);
  const notify = useCallback((message: string, kind: NoticeKind = "info") => {
    const id = next.current++;
    setNotices((list) => [...list.slice(-2), { id, message, kind }]);
    setTimeout(() => setNotices((list) => list.filter((notice) => notice.id !== id)), NOTICE_MS);
  }, []);
  return { notices, notify };
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
 * sent even with auto-sizing off, and a normal report follows when the overlay closes.
 */
export function useResizeReporter(ref: RefObject<HTMLElement | null>, api: Api, options: ResizeOptions) {
  const last = useRef<{ height: number; temporary: boolean } | null>(null);
  const { autoSize, overlayRem } = options;
  useEffect(() => {
    const app = ref.current;
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
  }, [ref, api, autoSize, overlayRem]);
}

/** Keeps a ref pointing at the latest value, for callbacks created once. */
export function useLatest<T>(value: T) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}
