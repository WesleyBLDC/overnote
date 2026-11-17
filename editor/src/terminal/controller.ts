/**
 * The terminal drawer's page side (docs/architecture.md, the terminal drawer): the xterm.js view, the session
 * with the helper (term.open, term.resize, term.close), output with acks, and the drawer's visibility.
 *
 * Opening asks the helper to grow the panel (window.setDrawer) and shows the drawer once the frame has landed;
 * closing hides it first and then shrinks the panel, so the note never squeezes (the machine is in drawer.ts).
 * Closing keeps xterm.js and the session alive; only after IDLE_CLOSE_MS closed does the drawer end its attach, so
 * quick toggles are instant. Each async step checks that its open call or attach is still the current one.
 */
import type { Api } from "../bridge/api";
import { drawerReducer, initialDrawer, type DrawerEvent } from "./drawer";
import { binaryBytes, decodeBase64, encodeBase64, postTerm } from "./channel";
import { reachesOvernote } from "./keys";
import { terminalFont, terminalTheme } from "./theme";
import type { FitAddon, Terminal } from "./xterm";

/**
 * The drawer is sized in rows, not points: 24 rows (a standard terminal's height) at every zoom, so a full screen
 * program such as an agent's prompt keeps its header in view. The height follows the measured row height.
 */
export const DRAWER_ROWS = 24;
/** The most of the screen's height the drawer may take; fewer rows show on a short screen. */
const MAX_SCREEN_SHARE = 0.5;
/** The fewest rows the drawer shows, even on a short screen. */
const MIN_ROWS = 8;
/** xterm.js's line height, a multiple of the font size. */
const LINE_HEIGHT = 1.2;
/** How long a closed drawer keeps its attach before it ends it. */
export const IDLE_CLOSE_MS = 5 * 60_000;
/** The terminal's font size at 100% zoom, in points. */
const FONT_SIZE = 12;

export type Session = "none" | "starting" | "live" | "exited";

let xtermModule: Promise<typeof import("./xterm")> | null = null;
/** Loads the xterm.js chunk once; called on first open and when the editor is idle. */
export function preloadTerminal(): Promise<typeof import("./xterm")> {
  xtermModule ??= import("./xterm");
  return xtermModule;
}

/** The space the note gives up for the drawer (terminal.css). */
function setDrawerVar(height: number): void {
  document.documentElement.style.setProperty("--terminal-height", `${height}px`);
}

/** What the drawer header shows: the session's state, the title the program set (OSC 0 or 2), and the backend. */
export interface TerminalInfo {
  status: Session;
  title: string;
  backend: "herdr" | "shell" | null;
}

export class TerminalController {
  private host: HTMLElement | null = null;
  private term: Terminal | null = null;
  private fit: FitAddon | null = null;
  private creating: Promise<void> | null = null;
  private session: Session = "none";
  /** Bumped by every term.open and by ending the attach, so a stale open's answer is ignored. */
  private attachSeq = 0;
  private backend: "herdr" | "shell" | null = null;
  private queued: Uint8Array[] = [];
  private size = { cols: 80, rows: 15 };
  private idle: ReturnType<typeof setTimeout> | null = null;
  private drawer = initialDrawer;
  private zoom = 1;
  private readonly listeners = new Set<() => void>();
  /** Replaced, never mutated, on each change, so React reads it as a snapshot (useSyncExternalStore). */
  private info: TerminalInfo = { status: "none", title: "", backend: null };
  private readonly offs: (() => void)[] = [];
  private resizes: ResizeObserver | null = null;
  private heightCheck: number | null = null;
  private colors: MediaQueryList | null = null;

  constructor(private readonly api: Api) {}

  // ---- the drawer's visibility, for React ----

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Whether the drawer is shown: true once the panel has grown for it. */
  getVisible = (): boolean => this.drawer.phase === "shown";

  getInfo = (): TerminalInfo => this.info;

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }

  /** Moves the drawer's machine, and tells React only when the drawer showed or hid. */
  private dispatch(event: DrawerEvent): void {
    const wasVisible = this.getVisible();
    this.drawer = drawerReducer(this.drawer, event);
    if (this.getVisible() !== wasVisible) this.notify();
  }

  /** Changes what the header shows, and tells React only when something did change. */
  private setInfo(patch: Partial<TerminalInfo>): void {
    const next = { ...this.info, ...patch };
    if (next.status === this.info.status && next.title === this.info.title && next.backend === this.info.backend)
      return;
    this.info = next;
    this.notify();
  }

  private setSession(session: Session): void {
    this.session = session;
    this.setInfo({ status: session });
  }

  setHost = (host: HTMLElement | null): void => {
    this.host = host;
    // An open that found no host drew nothing: finish it now that there is one.
    if (host && !this.term && !this.creating && this.drawer.phase !== "closed") void this.setOpen(true, false);
  };

  // ---- opening and closing ----

  /** Opens or closes the drawer; `focus` moves the caret into the terminal once it is there. */
  async setOpen(open: boolean, focus: boolean): Promise<void> {
    this.dispatch({ type: open ? "open" : "close" });
    const seq = this.drawer.seq;
    const current = () => this.drawer.seq === seq;
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    if (open) {
      await this.sendHeight(this.drawerHeight());
      if (!current()) return;
      this.dispatch({ type: "grown", seq });
      await this.ensureTerminal();
      if (!current()) return;
      // The first open sized the drawer from an estimated row height; now the real one is known.
      await this.sendHeight(this.drawerHeight());
      if (!current()) return;
      this.refit();
      this.ensureSession();
      if (focus) this.term?.focus();
      return;
    }
    this.term?.blur();
    await this.sendHeight(0);
    if (!current()) return;
    this.idle = setTimeout(() => this.endSession(), IDLE_CLOSE_MS);
  }

  /**
   * Sends the drawer's height and sets --terminal-height, the space the note gives up. Growing waits for the panel
   * before the note gives up the space, and shrinking hands it back first, so the note never squeezes.
   */
  private async sendHeight(height: number): Promise<void> {
    const from = this.drawer.height;
    if (height === from) return;
    this.dispatch({ type: "height", height });
    if (height < from && height > 0) setDrawerVar(height);
    await this.api.window.setDrawer(height).catch(() => undefined);
    if (height > from && this.drawer.height === height) setDrawerVar(height);
  }

  /** The height of DRAWER_ROWS rows plus the drawer's padding and divider, at most MAX_SCREEN_SHARE of the screen. */
  private drawerHeight(): number {
    const cell = this.cellHeight();
    const host = this.host;
    const style = host ? getComputedStyle(host) : null;
    const drawer = host?.parentElement ?? null;
    const header = drawer?.querySelector(".terminal-header");
    const chrome =
      (style ? parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) : 0) +
      (drawer ? parseFloat(getComputedStyle(drawer).borderTopWidth) || 0 : 0) +
      (header ? parseFloat(getComputedStyle(header).height) || 0 : 0);
    const fit = Math.floor((window.screen.availHeight * MAX_SCREEN_SHARE - chrome) / cell);
    const rows = Math.max(MIN_ROWS, Math.min(DRAWER_ROWS, fit));
    return Math.ceil(rows * cell + chrome);
  }

  /** One row's height in CSS pixels: measured from xterm.js once it has drawn, else estimated from the font. */
  private cellHeight(): number {
    const screen = this.host?.querySelector<HTMLElement>(".xterm-screen");
    const measured =
      screen && this.term && this.term.rows > 0 ? screen.getBoundingClientRect().height / this.term.rows : 0;
    return measured > 0 ? measured : Math.ceil(Math.round(FONT_SIZE * this.zoom) * LINE_HEIGHT);
  }

  focus(): void {
    this.term?.focus();
  }

  setZoom(zoom: number): void {
    this.zoom = zoom;
    if (!this.term) return;
    this.term.options.fontSize = Math.round(FONT_SIZE * zoom);
    // The rows grew or shrank with the font: resize the drawer so it still shows DRAWER_ROWS of them.
    if (this.getVisible()) void this.sendHeight(this.drawerHeight()).then(() => this.refit());
    else this.refit();
  }

  // ---- xterm.js ----

  /** Creates xterm.js once; an attempt that drew nothing (no host yet, or the chunk failed) is tried again. */
  private ensureTerminal(): Promise<void> {
    this.creating ??= this.createTerminal().finally(() => {
      if (!this.term) this.creating = null;
    });
    return this.creating;
  }

  private async createTerminal(): Promise<void> {
    const { Terminal, FitAddon } = await preloadTerminal();
    const host = this.host;
    if (!host) return;
    const font = terminalFont();
    // Measure the cell only once the mono face is ready, or the grid would be sized for the fallback.
    await document.fonts?.load(`${FONT_SIZE}px ${font}`).catch(() => undefined);
    const term = new Terminal({
      fontFamily: font,
      fontSize: Math.round(FONT_SIZE * this.zoom),
      lineHeight: LINE_HEIGHT,
      cursorBlink: true,
      scrollback: 5000,
      // ⌥ keeps typing characters such as @ and €, as in Terminal.app by default.
      macOptionIsMeta: false,
      theme: terminalTheme(host),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    // Allowlisted keys belong to Overnote: xterm.js leaves them alone, and the app's handler runs them.
    term.attachCustomKeyEventHandler((event) => !reachesOvernote(event));
    term.onData((data) => this.input(new TextEncoder().encode(data)));
    term.onBinary((data) => this.input(binaryBytes(data)));
    term.onTitleChange((title) => this.setInfo({ title }));
    // Listen before the first term.open, so no early output is dropped.
    this.offs.push(
      this.api.on("term.data", ({ data }) => {
        const bytes = decodeBase64(data);
        term.write(bytes, () => postTerm({ type: "ack", bytes: bytes.length }));
      }),
      this.api.on("term.exit", ({ code }) => this.exited(code)),
    );
    term.open(host);
    this.term = term;
    this.fit = fit;
    this.resizes = new ResizeObserver(() => {
      this.refit();
      this.checkHeightNextFrame();
    });
    this.resizes.observe(host);
    this.colors = window.matchMedia("(prefers-color-scheme: dark)");
    this.colors.addEventListener("change", this.recolor);
  }

  private recolor = (): void => {
    if (this.term && this.host) this.term.options.theme = terminalTheme(this.host);
  };

  /**
   * The drawer's chrome (header, padding) can change size after its height was sent, as when zoom applies after
   * boot: send the height again so it still holds DRAWER_ROWS. The height depends on the rows, never on the host's
   * size, so this settles at once and an unchanged height sends nothing. It waits a frame, so it never resizes the
   * drawer from inside the ResizeObserver callback that noticed the change.
   */
  private checkHeightNextFrame(): void {
    if (this.heightCheck !== null) return;
    this.heightCheck = requestAnimationFrame(() => {
      this.heightCheck = null;
      if (this.getVisible()) void this.sendHeight(this.drawerHeight());
    });
  }

  /** Fits the grid to the drawer and tells the helper when the size changed. */
  private refit(): void {
    if (!this.getVisible() || !this.fit || !this.term) return;
    const proposed = this.fit.proposeDimensions();
    if (!proposed || !Number.isFinite(proposed.cols) || !Number.isFinite(proposed.rows)) return;
    const cols = Math.max(2, proposed.cols);
    const rows = Math.max(1, proposed.rows);
    if (cols === this.size.cols && rows === this.size.rows && this.term.cols === cols && this.term.rows === rows)
      return;
    this.size = { cols, rows };
    this.term.resize(cols, rows);
    if (this.session === "live") void this.api.term.resize({ cols, rows }).catch(() => undefined);
  }

  // ---- the session ----

  private ensureSession(): void {
    if (this.session === "live" || this.session === "starting" || !this.term) return;
    if (this.session === "exited") this.term.reset();
    this.setSession("starting");
    const attach = ++this.attachSeq;
    this.api.term.open({ ...this.size }).then(
      ({ backend }) => {
        if (attach !== this.attachSeq) return;
        this.setSession("live");
        if (backend === "shell" && this.backend !== "shell") {
          this.term?.write("\x1b[2mHerdr is not installed, so this shell ends when Overnote quits.\x1b[0m\r\n");
        }
        this.backend = backend;
        this.setInfo({ backend });
        for (const bytes of this.queued.splice(0)) postTerm({ type: "write", data: encodeBase64(bytes) });
      },
      (error: unknown) => {
        if (attach !== this.attachSeq) return;
        this.setSession("exited");
        this.queued = [];
        this.term?.write(
          `\r\n\x1b[2mCould not start the terminal: ${String(error)}. Press any key to try again.\x1b[0m\r\n`,
        );
      },
    );
  }

  private input(bytes: Uint8Array): void {
    if (this.session === "live") {
      postTerm({ type: "write", data: encodeBase64(bytes) });
      return;
    }
    if (this.session === "exited" || this.session === "none") {
      // A key after an exit starts again; the key itself is not sent to the new program.
      this.ensureSession();
      return;
    }
    this.queued.push(bytes);
  }

  private exited(code: number): void {
    if (this.session !== "live") return;
    this.setSession("exited");
    const message =
      this.backend === "herdr"
        ? "Detached from the Herdr terminal. Press any key to attach again."
        : `The shell exited with code ${code}. Press any key to start a new one.`;
    this.term?.write(`\r\n\x1b[2m${message}\x1b[0m\r\n`);
  }

  /** Ends the attach after the drawer stayed closed; the next open attaches again with fresh history. */
  private endSession(): void {
    this.idle = null;
    if (this.drawer.phase !== "closed") return;
    if (this.session === "live" || this.session === "starting") void this.api.term.close().catch(() => undefined);
    this.attachSeq++;
    this.setSession("none");
    this.queued = [];
    this.term?.reset();
  }

  dispose(): void {
    if (this.idle) clearTimeout(this.idle);
    for (const off of this.offs.splice(0)) off();
    this.resizes?.disconnect();
    if (this.heightCheck !== null) cancelAnimationFrame(this.heightCheck);
    this.colors?.removeEventListener("change", this.recolor);
    this.term?.dispose();
    this.term = null;
    this.creating = null;
  }
}
