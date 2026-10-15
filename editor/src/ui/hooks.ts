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

/**
 * Reports the wrapper's height to the helper, throttled to one call per animation frame and only
 * when it changed. Heights are CSS pixels, which already include zoom because zoom scales the root
 * font size, so they equal points in the panel.
 */
export function useResizeReporter(ref: RefObject<HTMLElement | null>, api: Api, enabled: boolean) {
  useEffect(() => {
    const element = ref.current;
    if (!element || !enabled) return;
    let frame = 0;
    let last = -1;
    const report = () => {
      frame = 0;
      const height = Math.ceil(element.getBoundingClientRect().height);
      if (height === last || height <= 0) return;
      last = height;
      void api.window.resize(height).catch(() => undefined);
    };
    const observer = new ResizeObserver(() => {
      if (!frame) frame = requestAnimationFrame(report);
    });
    observer.observe(element);
    frame = requestAnimationFrame(report);
    return () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [ref, api, enabled]);
}

/** Keeps a ref pointing at the latest value, for callbacks created once. */
export function useLatest<T>(value: T) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}
