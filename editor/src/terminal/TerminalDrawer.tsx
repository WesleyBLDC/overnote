/** The terminal drawer under the note, and the hook that opens, closes, and remembers it. */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Api } from "../bridge/api";
import { Icon } from "../ui/icons";
import { Tooltip } from "../ui/Tooltip";
import { preloadTerminal, TerminalController, type TerminalInfo } from "./controller";

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
  /** The terminal fills the panel (SPEC §12); the note stays underneath, and the drawer is still open. */
  expanded: boolean;
  /** ⌘⇧↩ and the header's expand and collapse buttons: opens the drawer first when it is closed. */
  toggleExpanded: () => void;
  info: TerminalInfo;
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
  const info = useSyncExternalStore(controller.subscribe, controller.getInfo);
  const [expandedWish, setExpanded] = useState(false);
  // Closing the drawer ends the full-panel view, so the next open starts as a drawer.
  const expanded = expandedWish && open;
  if (expandedWish && !open) setExpanded(false);
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

  const toggleExpanded = useCallback(() => {
    if (!open) {
      focusNext.current = true;
      setOpen(true);
      setExpanded(true);
      return;
    }
    setExpanded((value) => !value);
    controller.focus();
  }, [open, setOpen, controller]);

  return { controller, open, visible, expanded, toggleExpanded, info, toggle, toggleFromKeys };
}

/** The header's name for the session: the folder in the program's title (OSC 0 or 2), else the backend. */
export function sessionName(info: TerminalInfo): string {
  // Shells usually title the window "user@host: ~/code/project" or just the path; keep its last folder.
  const path = info.title.replace(/^[^\s:]+@[^\s:]+:\s*/u, "").trim();
  const folder = path.split("/").filter(Boolean).pop() ?? "";
  return folder || (info.backend === "herdr" ? "Herdr" : "Terminal");
}

interface DrawerProps {
  terminal: TerminalDrawerState;
  /** The note's title, on the full-panel view's back pill. */
  noteTitle: string;
  /** The window's Close control, kept at the top left of the full-panel view. */
  onHide: () => void;
  setHost: (host: HTMLElement | null) => void;
}

const keep = (event: React.MouseEvent) => event.preventDefault();

/**
 * The drawer itself (board 06): a header with the session's status and name, expand, and close, over the terminal
 * that `setHost` hands to the controller. Expanded, the same element fills the panel and its header becomes the top
 * bar, so xterm.js never moves and the session keeps running.
 */
export function TerminalDrawer({ terminal, noteTitle, onHide, setHost }: DrawerProps) {
  const { info, expanded } = terminal;
  const name = sessionName(info);
  const backend = info.backend === "herdr" ? "herdr" : "shell";
  const status = info.status === "live" ? "live" : info.status === "starting" ? "starting" : "idle";
  return (
    <section
      className="terminal-drawer"
      data-testid="terminal-drawer"
      data-expanded={expanded || undefined}
      aria-label="Terminal"
      hidden={!terminal.visible}
      // A click in the drawer never reaches the note's own mouse handling.
      onMouseDown={(event) => event.stopPropagation()}
    >
      <header className="terminal-header" data-testid="terminal-header">
        {expanded ? (
          <div className="terminal-leading">
            <button
              type="button"
              className="close-button"
              aria-label="Close"
              onMouseDown={keep}
              onClick={onHide}
              tabIndex={-1}
            >
              <span className="close-dot">
                <Icon name="close" />
              </span>
            </button>
            <button
              type="button"
              className="terminal-back"
              data-testid="terminal-back"
              onMouseDown={keep}
              onClick={terminal.toggleExpanded}
              tabIndex={-1}
            >
              <Icon name="back" />
              <span className="terminal-back-title">{noteTitle}</span>
            </button>
          </div>
        ) : null}
        <span className="terminal-session" data-testid="terminal-session">
          <span className="terminal-status" data-status={status} aria-label={status} />
          <span className="terminal-name">{name}</span>
          <span className="terminal-backend">{backend}</span>
        </span>
        <span className="terminal-actions">
          <button
            type="button"
            className={`terminal-button has-tooltip${expanded ? "" : " is-outlined"}`}
            aria-label={expanded ? "Back to Note" : "Expand Terminal"}
            data-testid="terminal-expand"
            onMouseDown={keep}
            onClick={terminal.toggleExpanded}
            tabIndex={-1}
          >
            <Icon name={expanded ? "collapse" : "expandDiagonal"} />
            <Tooltip label={expanded ? "Back to Note" : "Expand Terminal"} shortcut="⇧⌘↩" />
          </button>
          {expanded ? null : (
            <button
              type="button"
              className="terminal-button has-tooltip"
              aria-label="Close Terminal"
              data-testid="terminal-close"
              onMouseDown={keep}
              onClick={terminal.toggle}
              tabIndex={-1}
            >
              <Icon name="close" />
              <Tooltip label="Close Terminal" shortcut="⌃`" />
            </button>
          )}
        </span>
      </header>
      <div className="terminal-host" ref={setHost} />
    </section>
  );
}
