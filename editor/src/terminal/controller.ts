/**
 * The terminal drawer's page side (docs/architecture.md, the terminal drawer): the xterm.js view, the session
 * with the helper (term.open, term.resize, term.close), output with acks, and the drawer's visibility.
 *
 * Opening asks the helper to grow the panel (window.setDrawer) and shows the drawer once the frame has landed;
 * closing hides it first and then shrinks the panel, so the note never squeezes. Closing keeps xterm.js and the
 * session alive; only after IDLE_CLOSE_MS closed does the drawer end its attach, so quick toggles are instant.
 */
import type { Api } from "../bridge/api";
import { binaryBytes, decodeBase64, encodeBase64, postTerm } from "./channel";
import { reachesOvernote } from "./keys";
import { terminalFont, terminalTheme } from "./theme";
import type { FitAddon, Terminal } from "./xterm";

/** The drawer's height in points, fixed at every zoom (--terminal-height in theme.css). */
export const DRAWER_HEIGHT = 260;
/** How long a closed drawer keeps its attach before it ends it. */
export const IDLE_CLOSE_MS = 5 * 60_000;
/** The terminal's font size at 100% zoom, in points. */
const FONT_SIZE = 12;

type Session = "none" | "starting" | "live" | "exited";

let xtermModule: Promise<typeof import("./xterm")> | null = null;
/** Loads the xterm.js chunk once; called on first open and when the editor is idle. */
export function preloadTerminal(): Promise<typeof import("./xterm")> {
  xtermModule ??= import("./xterm");
  return xtermModule;
}

export class TerminalController {
  private host: HTMLElement | null = null;
  private term: Terminal | null = null;
  private fit: FitAddon | null = null;
  private creating: Promise<void> | null = null;
  private session: Session = "none";
  private backend: "herdr" | "shell" | null = null;
  private queued: Uint8Array[] = [];
  private size = { cols: 80, rows: 15 };
  private idle: ReturnType<typeof setTimeout> | null = null;
  private wanted = false;
  private sentHeight = 0;
  private zoom = 1;
  private visible = false;
  private readonly listeners = new Set<() => void>();
  private readonly offs: (() => void)[] = [];
  private resizes: ResizeObserver | null = null;
  private colors: MediaQueryList | null = null;

  constructor(private readonly api: Api) {}

  // ---- the drawer's visibility, for React ----

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Whether the drawer is shown: true once the panel has grown for it. */
  getVisible = (): boolean => this.visible;

  private setVisible(visible: boolean): void {
    if (visible === this.visible) return;
    this.visible = visible;
    for (const listener of [...this.listeners]) listener();
  }

  setHost = (host: HTMLElement | null): void => {
    this.host = host;
  };

  // ---- opening and closing ----

  /** Opens or closes the drawer; `focus` moves the caret into the terminal once it is there. */
  async setOpen(open: boolean, focus: boolean): Promise<void> {
    this.wanted = open;
    if (open) {
      if (this.idle) clearTimeout(this.idle);
      this.idle = null;
      await this.sendHeight(DRAWER_HEIGHT);
      if (!this.wanted) return;
      this.setVisible(true);
      await this.ensureTerminal();
      if (!this.wanted) return;
      this.refit();
      this.ensureSession();
      if (focus) this.term?.focus();
      return;
    }
    this.term?.blur();
    this.setVisible(false);
    await this.sendHeight(0);
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => this.endSession(), IDLE_CLOSE_MS);
  }

  private async sendHeight(height: number): Promise<void> {
    if (height === this.sentHeight) return;
    this.sentHeight = height;
    await this.api.window.setDrawer(height).catch(() => undefined);
  }

  focus(): void {
    this.term?.focus();
  }

  setZoom(zoom: number): void {
    this.zoom = zoom;
    if (!this.term) return;
    this.term.options.fontSize = Math.round(FONT_SIZE * zoom);
    this.refit();
  }

  // ---- xterm.js ----

  private ensureTerminal(): Promise<void> {
    this.creating ??= this.createTerminal();
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
      lineHeight: 1.2,
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
    this.resizes = new ResizeObserver(() => this.refit());
    this.resizes.observe(host);
    this.colors = window.matchMedia("(prefers-color-scheme: dark)");
    this.colors.addEventListener("change", this.recolor);
  }

  private recolor = (): void => {
    if (this.term && this.host) this.term.options.theme = terminalTheme(this.host);
  };

  /** Fits the grid to the drawer and tells the helper when the size changed. */
  private refit(): void {
    if (!this.visible || !this.fit || !this.term) return;
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
    this.session = "starting";
    this.api.term.open({ ...this.size }).then(
      ({ backend }) => {
        if (this.session !== "starting") return;
        this.session = "live";
        if (backend === "shell" && this.backend !== "shell") {
          this.term?.write("\x1b[2mHerdr is not installed, so this shell ends when Overnote quits.\x1b[0m\r\n");
        }
        this.backend = backend;
        for (const bytes of this.queued.splice(0)) postTerm({ type: "write", data: encodeBase64(bytes) });
      },
      (error: unknown) => {
        this.session = "exited";
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
    this.session = "exited";
    const message =
      this.backend === "herdr"
        ? "Detached from the Herdr terminal. Press any key to attach again."
        : `The shell exited with code ${code}. Press any key to start a new one.`;
    this.term?.write(`\r\n\x1b[2m${message}\x1b[0m\r\n`);
  }

  /** Ends the attach after the drawer stayed closed; the next open attaches again with fresh history. */
  private endSession(): void {
    this.idle = null;
    if (this.wanted) return;
    if (this.session === "live" || this.session === "starting") void this.api.term.close().catch(() => undefined);
    this.session = "none";
    this.queued = [];
    this.term?.reset();
  }

  dispose(): void {
    if (this.idle) clearTimeout(this.idle);
    for (const off of this.offs.splice(0)) off();
    this.resizes?.disconnect();
    this.colors?.removeEventListener("change", this.recolor);
    this.term?.dispose();
    this.term = null;
    this.creating = null;
  }
}
