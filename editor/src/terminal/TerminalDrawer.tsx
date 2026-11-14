/** The terminal drawer under the note, and the hook that opens, closes, and remembers it. */
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { Api } from "../bridge/api";
import { preloadTerminal, TerminalController } from "./controller";

/** How long after boot the xterm.js chunk loads in the background, so the first open is quick. */
const PRELOAD_MS = 1500;

interface TerminalOptions {
  api: Api;
  /** The stored `terminal.open` setting. */
  open: boolean;
  setOpen: (open: boolean) => void;
  zoom: number;
  /** Puts the caret back in the note. */
  focusNote: () => void;
}

export interface TerminalDrawerState {
  controller: TerminalController;
  /** The drawer is open (the stored setting). */
  open: boolean;
  /** The drawer is on screen: the panel has grown for it. */
  visible: boolean;
  /**
   * Opens the drawer and focuses the terminal, or closes it and focuses the note. This is the one entry point
   * for the toolbar's Terminal button, ⌘K's Open or Close Terminal, and ⌃`.
   */
  toggle: () => void;
  /** ⌃`: from the note it opens (or focuses) the terminal; from the terminal it closes the drawer. */
  toggleFromKeys: (fromTerminal: boolean) => void;
}

export function useTerminalDrawer({ api, open, setOpen, zoom, focusNote }: TerminalOptions): TerminalDrawerState {
  const controller = useMemo(() => new TerminalController(api), [api]);
  useEffect(() => () => controller.dispose(), [controller]);
  const visible = useSyncExternalStore(controller.subscribe, controller.getVisible);
  /** Set by a person's toggle, so the terminal takes focus; a drawer restored at boot leaves focus in the note. */
  const focusNext = useRef(false);

  useEffect(() => {
    const focus = focusNext.current;
    focusNext.current = false;
    void controller.setOpen(open, focus);
  }, [controller, open]);

  useEffect(() => controller.setZoom(zoom), [controller, zoom]);

  useEffect(() => {
    const timer = setTimeout(() => void preloadTerminal().catch(() => undefined), PRELOAD_MS);
    return () => clearTimeout(timer);
  }, []);

  const toggle = useCallback(() => {
    if (open) {
      setOpen(false);
      focusNote();
    } else {
      focusNext.current = true;
      setOpen(true);
    }
  }, [open, setOpen, focusNote]);

  const toggleFromKeys = useCallback(
    (fromTerminal: boolean) => {
      if (open && !fromTerminal) controller.focus();
      else toggle();
    },
    [open, controller, toggle],
  );

  return { controller, open, visible, toggle, toggleFromKeys };
}

/** The drawer itself; `setHost` hands its element to the controller, which draws xterm.js into it. */
export function TerminalDrawer({
  visible,
  setHost,
}: {
  visible: boolean;
  setHost: (host: HTMLElement | null) => void;
}) {
  return (
    <section
      className="terminal-drawer"
      data-testid="terminal-drawer"
      aria-label="Terminal"
      hidden={!visible}
      // A click in the drawer never reaches the note's own mouse handling.
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div className="terminal-host" ref={setHost} />
    </section>
  );
}
