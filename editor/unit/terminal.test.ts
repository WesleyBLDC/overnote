/**
 * The terminal drawer's sequencing: the drawer machine, and the controller's handling of term.open answers that
 * arrive late or with no host. Drawing, typing, and the panel growing end to end are in tests/terminal.spec.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Api } from "../src/bridge/api";
import { IDLE_CLOSE_MS, TerminalController } from "../src/terminal/controller";
import { drawerReducer, initialDrawer, type DrawerEvent, type DrawerState } from "../src/terminal/drawer";

const run = (state: DrawerState, ...events: DrawerEvent[]) => events.reduce(drawerReducer, state);

describe("drawerReducer", () => {
  it("shows the drawer only when the current open call's grow lands", () => {
    const opened = run(initialDrawer, { type: "open" });
    expect(opened.phase).toBe("growing");
    expect(run(opened, { type: "grown", seq: opened.seq }).phase).toBe("shown");
    // Open, close, open: the first open's grow lands late and changes nothing; the second one's shows.
    const reopened = run(opened, { type: "close" }, { type: "open" });
    expect(run(reopened, { type: "grown", seq: opened.seq })).toEqual(reopened);
    expect(run(reopened, { type: "grown", seq: reopened.seq }).phase).toBe("shown");
  });

  it("opening a shown drawer keeps it shown, and closing hides it at once", () => {
    const shown = run(initialDrawer, { type: "open" }, { type: "grown", seq: 1 }, { type: "height", height: 300 });
    expect(run(shown, { type: "open" }).phase).toBe("shown");
    expect(run(shown, { type: "close" })).toMatchObject({ phase: "closed", height: 300 });
  });
});

// ---- the controller, with a fake Api, a fake xterm.js, and fake timers ----

class FakeTerminal {
  static last: FakeTerminal | null = null;
  rows = 24;
  cols = 80;
  options: Record<string, unknown> = {};
  written: string[] = [];
  private onDataHandler: (data: string) => void = () => undefined;
  constructor() {
    FakeTerminal.last = this;
  }
  loadAddon() {}
  attachCustomKeyEventHandler() {}
  onData(handler: (data: string) => void) {
    this.onDataHandler = handler;
  }
  onBinary() {}
  open() {}
  write(data: string | Uint8Array) {
    if (typeof data === "string") this.written.push(data);
  }
  resize(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
  }
  type(data: string) {
    this.onDataHandler(data);
  }
  reset() {}
  focus() {}
  blur() {}
  dispose() {}
}

vi.mock("../src/terminal/xterm", () => ({
  Terminal: FakeTerminal,
  FitAddon: class {
    proposeDimensions = () => ({ cols: 80, rows: 24 });
  },
}));
vi.mock("../src/terminal/theme", () => ({ terminalFont: () => "monospace", terminalTheme: () => ({}) }));

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets every pending promise continuation run. */
const settle = () => vi.advanceTimersByTimeAsync(0);

let opens: Deferred<{ backend: "herdr" | "shell" }>[];
let closes: number;
let posted: unknown[];
const host = { querySelector: () => null, parentElement: null } as unknown as HTMLElement;

function fakeApi(): Api {
  return {
    window: { setDrawer: () => Promise.resolve({}) },
    term: {
      open: () => {
        const answer = deferred<{ backend: "herdr" | "shell" }>();
        opens.push(answer);
        return answer.promise;
      },
      resize: () => Promise.resolve({}),
      close: () => {
        closes++;
        return Promise.resolve({});
      },
    },
    on: () => () => undefined,
  } as unknown as Api;
}

describe("TerminalController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    opens = [];
    closes = 0;
    posted = [];
    FakeTerminal.last = null;
    vi.stubGlobal("window", {
      screen: { availHeight: 1000 },
      matchMedia: () => ({ addEventListener() {}, removeEventListener() {} }),
      webkit: { messageHandlers: { overnoteTerm: { postMessage: (message: unknown) => posted.push(message) } } },
    });
    vi.stubGlobal("document", { documentElement: { style: { setProperty() {} } } });
    vi.stubGlobal("getComputedStyle", () => ({ paddingTop: "0", paddingBottom: "0" }));
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** Closes the drawer and waits out the idle timer, so the attach ends with term.close. */
  async function closeUntilDetached(controller: TerminalController): Promise<void> {
    await controller.setOpen(false, false);
    await vi.advanceTimersByTimeAsync(IDLE_CLOSE_MS);
  }

  it("ignores a stale term.open answer, success or failure, and keeps the current attach's queued keys", async () => {
    const controller = new TerminalController(fakeApi());
    controller.setHost(host);
    await controller.setOpen(true, false);
    await closeUntilDetached(controller);
    await controller.setOpen(true, false);
    await closeUntilDetached(controller);
    await controller.setOpen(true, false);
    expect([opens.length, closes]).toEqual([3, 2]);

    const term = FakeTerminal.last!;
    term.type("x");
    opens[0]!.resolve({ backend: "herdr" });
    opens[1]!.reject(new Error("closed"));
    await settle();
    // Neither stale answer made the attach live (the key would be sent) or failed it (the key would be dropped).
    expect(posted).toEqual([]);
    expect(term.written.join("")).not.toContain("Could not start");

    opens[2]!.resolve({ backend: "herdr" });
    await settle();
    expect(posted).toEqual([{ type: "write", data: btoa("x") }]);
  });

  it("draws the terminal and attaches once the host appears after an open", async () => {
    const controller = new TerminalController(fakeApi());
    await controller.setOpen(true, false);
    expect([FakeTerminal.last, opens.length]).toEqual([null, 0]);
    controller.setHost(host);
    await settle();
    expect(FakeTerminal.last).not.toBeNull();
    expect(opens).toHaveLength(1);
    expect(controller.getVisible()).toBe(true);
  });
});
