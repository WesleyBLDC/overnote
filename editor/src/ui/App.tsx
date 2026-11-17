/** The notes window: toolbar, editor, find bar, footer, and the popups around them. */
import {
  moveListItem,
  countCharacters,
  countWords,
  deriveTitle,
  displayTitle,
  docToHTML,
  docToMarkdown,
  docToPlainText,
  type JSONContent,
  type NoteId,
  type PanelPlacement,
  rpc,
} from "@overnote/core";
import { EditorContent, useEditor } from "@tiptap/react";
import type { AnyExtension, Editor } from "@tiptap/core";
import { EditorState, TextSelection, type Transaction } from "@tiptap/pm/state";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Api } from "../bridge/api";
import { activeListKind, BLOCK_LABELS, focusEditorNow, runFormat, type FormatId } from "../editor/commands";
import { findState, findTransaction } from "../editor/find";
import { undoDepth } from "@tiptap/pm/history";
import { createEditorExtensions, setSmartTypography } from "../editor/extensions";
import { createNoteLowlight, loadGrammars } from "../editor/lowlight";
import { chooseLinkTarget, type LinkTarget } from "../editor/linkRange";
import { filterSlashItems, slashQueryAt, type SlashItem } from "../editor/slash";
import { emojiQueryAt, recordEmojiUse } from "../editor/emoji";
import { EmojiPicker, type EmojiPickerHandle } from "./EmojiPicker";
import { noteDeeplink } from "../lib/deeplink";
import { exportFileName } from "../lib/fileName";
import { matches, pinSlot } from "../lib/keys";
import { stepZoom, zoomLabel } from "../lib/zoom";
import { NoteSession, type EditorPort } from "../session/session";
import { CommandPanel, type PanelAction, type PanelViewName } from "./CommandPanel";
import { SettingsPage } from "./SettingsPage";
import { ConfirmDialog, type ConfirmRequest } from "./ConfirmDialog";
import { FindBar, type FindBarHandle } from "./FindBar";
import { Footer } from "./Footer";
import { ExitGhost } from "./ExitGhost";
import {
  useDragRegions,
  useLatest,
  useMinimumSizeReporter,
  useNearBottom,
  useNotices,
  useResizeReporter,
  useScrollEdges,
  useSettings,
} from "./hooks";
import { LinkPopover } from "./LinkPopover";
import { Notices } from "./Notices";
import { SlashMenu, type SlashMenuHandle } from "./SlashMenu";
import { Toolbar } from "./Toolbar";
import { TerminalDrawer, useTerminalDrawer } from "../terminal/TerminalDrawer";
import { EXPAND_TERMINAL, inTerminal, reachesOvernote, TOGGLE_TERMINAL } from "../terminal/keys";

type ExportFormat = "md" | "html" | "txt";

/** How long the app may stay unready before it shows the loading status. */
const BOOT_STATUS_MS = 300;

/** A key per confirm request, so a replaced request unmounts its dialog, which cancels it. */
const confirmKeys = new WeakMap<ConfirmRequest, number>();
let nextConfirmKey = 0;
function confirmKey(request: ConfirmRequest): number {
  let key = confirmKeys.get(request);
  if (key === undefined) confirmKeys.set(request, (key = ++nextConfirmKey));
  return key;
}

/** Places the caret and scrolls it into view in the same transaction, so the first painted frame is already right. */
function clampCaret(editor: Editor, caret: number | null): void {
  const { doc } = editor.state;
  const size = doc.content.size;
  const wanted = typeof caret === "number" && Number.isFinite(caret) && caret > 0 ? Math.min(caret, size) : 0;
  const selection = wanted > 0 ? TextSelection.near(doc.resolve(wanted)) : TextSelection.atStart(doc);
  editor.view.dispatch(editor.state.tr.setSelection(selection).setMeta("addToHistory", false).scrollIntoView());
}

/** Replaces the document without an undo step and starts a fresh undo history. */
function loadIntoEditor(editor: Editor, doc: JSONContent, caret: number | null): void {
  // A fresh state resets every plugin; an open find keeps its term on the new content.
  const { term } = findState(editor.state);
  editor.commands.setContent(doc, { emitUpdate: false });
  const { state } = editor;
  editor.view.updateState(EditorState.create({ doc: state.doc, plugins: state.plugins }));
  if (term) editor.view.dispatch(findTransaction(editor.state, { term, active: 0 }));
  // Every note opens from the top, then the caret is revealed: never the previous note's offset.
  const scroller = editor.view.dom.closest(".content");
  if (scroller) scroller.scrollTop = 0;
  clampCaret(editor, caret);
}

/** Changes the document to `doc` with one replace over the range that differs, keeping caret and history. */
function replaceInEditor(editor: Editor, doc: JSONContent): void {
  const { state } = editor;
  const next = state.schema.nodeFromJSON(doc);
  const start = state.doc.content.findDiffStart(next.content);
  const end = state.doc.content.findDiffEnd(next.content);
  if (start === null || !end) return;
  // When the documents share text on both sides of the change, the ends can cross the start.
  const overlap = start - Math.min(end.a, end.b);
  const endA = overlap > 0 ? end.a + overlap : end.a;
  const endB = overlap > 0 ? end.b + overlap : end.b;
  const tr = state.tr.replace(start, endA, next.slice(start, endB));
  editor.view.dispatch(tr.setMeta("addToHistory", false).setMeta("bnLoad", true));
}

function sliceJSON(editor: Editor): JSONContent | null {
  const { selection } = editor.state;
  if (selection.empty) return null;
  const slice = selection.content();
  // Selected blocks become a document; a selection inside one block keeps its inline content.
  const content = slice.content.toJSON() as JSONContent[];
  if (slice.content.childCount === 1 && slice.content.firstChild?.isTextblock && slice.openStart > 0) {
    return { type: "doc", content: [{ type: "paragraph", content: (content[0]?.content ?? []) as JSONContent[] }] };
  }
  return { type: "doc", content };
}

export function App({ api }: { api: Api }) {
  const { notices, notify, remove: dismissNotice, dismiss, act } = useNotices();
  /** Runs a panel action; a failure shows an error notice, and the promise always settles. */
  const attempt = useCallback(
    async (what: string, work: () => Promise<void>) => {
      try {
        await work();
      } catch (error) {
        console.error(`[app] ${what} failed`, error);
        notify(`Could not ${what}. Try again.`, "error");
      }
    },
    [notify],
  );
  const { settings, setSettings, update: updateSettings, reset: resetSettings } = useSettings(api);
  // The app element as state, so popups and hooks get it as a value instead of reading a ref while rendering.
  const [app, setApp] = useState<HTMLDivElement | null>(null);
  const [linkTarget, setLinkTarget] = useState<LinkTarget | null>(null);
  // Search's views, or the Settings page (⌘,), which covers the note instead of floating over it.
  const [panel, setPanel] = useState<PanelViewName | "settings" | null>(null);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  // Overnote.app or the extension's helper (system.ready); only the app offers Quit.
  const [host, setHost] = useState<"app" | "extension">("extension");
  const [find, setFind] = useState<{ term: string } | null>(null);
  const findRef = useRef<FindBarHandle>(null);
  const slashRef = useRef<SlashMenuHandle>(null);
  const emojiRef = useRef<EmojiPickerHandle>(null);
  const [emojiDismissed, setEmojiDismissed] = useState<number | null>(null);
  const [slashDismissed, setSlashDismissed] = useState<number | null>(null);
  // Bumped on every transaction: the editor state is read while rendering (shouldRerenderOnTransaction is off).
  const [, setTick] = useState(0);

  const copyText = useCallback(
    (text: string, html?: string) =>
      api.clipboard.copy(html ? { text, html } : { text }).then(
        () => undefined,
        (error: unknown) => {
          notify("Failed to copy to clipboard", "error");
          throw error;
        },
      ),
    [api, notify],
  );
  const openUrl = useCallback(
    (href: string) => {
      api.app.openURL(href).catch(() => notify("Failed to open link", "error"));
    },
    [api, notify],
  );

  /** ⌘L, the Link action, and the format bar: the popover for the selection or the word at the caret. */
  const openLinkIn = useCallback(
    (current: Editor) => {
      const target = chooseLinkTarget(current.state);
      if (!target) {
        notify("Select text to add a link. Place the cursor inside a word or select text first.", "error");
        return;
      }
      setLinkTarget(target);
    },
    [notify],
  );

  const lowlight = useMemo(() => createNoteLowlight(), []);
  const extensions = useMemo<AnyExtension[]>(
    () =>
      createEditorExtensions({
        lowlight,
        onLinkShortcut: openLinkIn,
        onOpenLink: (href) => openUrl(href),
        onLinkClick: (from, to, state) => {
          const target = chooseLinkTarget(
            state.apply(state.tr.setSelection(TextSelection.create(state.doc, from, to))),
          );
          if (target) setLinkTarget({ ...target, from, to });
        },
        copy: (text) => copyText(text),
      }),
    [copyText, openUrl, openLinkIn, lowlight],
  );

  const spellcheckRef = useRef(true);
  const editor = useEditor({
    extensions,
    content: { type: "doc", content: [{ type: "paragraph" }] },
    immediatelyRender: true,
    shouldRerenderOnTransaction: false,
    editorProps: {
      // The top margin keeps the caret below the scroll fade under the toolbar.
      scrollThreshold: { top: 24, bottom: 100, left: 0, right: 0 },
      scrollMargin: { top: 24, bottom: 100, left: 0, right: 0 },
      // A function, so the Spellcheck setting applies on the next view update (see the effect below).
      attributes: () => ({
        class: "note-editor",
        "data-testid": "editor",
        spellcheck: String(spellcheckRef.current),
      }),
      handleKeyDown: (_view, event) =>
        emojiRef.current?.onKeyDown(event) || slashRef.current?.onKeyDown(event) || false,
    },
    onTransaction: () => setTick((t) => t + 1),
  });

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const host = window as unknown as { __bnEditor?: Editor | null };
    host.__bnEditor = editor;
    return () => {
      if (host.__bnEditor === editor) host.__bnEditor = null;
    };
  }, [editor]);

  // The editor instance lives as long as the window, and so does its session.
  const session = useMemo(() => {
    const port: EditorPort = {
      getDoc: () => editor.getJSON(),
      getCaret: () => editor.state.selection.from,
      getText: () => docToPlainText(editor.getJSON()),
      isComposing: () => editor.view.composing,
      load: (doc, caret) => loadIntoEditor(editor, doc, caret),
      replace: (doc) => replaceInEditor(editor, doc),
      setEditable: (editable) => editor.setEditable(editable, false),
    };
    return new NoteSession({ api, editor: port, notice: notify });
  }, [api, notify, editor]);
  const state = useSyncExternalStore(session.subscribe, session.getState);

  // Edits, caret moves, and blur reach the session.
  useEffect(() => {
    const onUpdate = ({ transaction }: { transaction: Transaction }) => {
      if (transaction.docChanged && !transaction.getMeta("bnLoad")) session.contentChanged();
    };
    const onSelectionUpdate = () => session.selectionChanged();
    const onBlur = () => session.saveInBackground();
    editor.on("update", onUpdate);
    editor.on("selectionUpdate", onSelectionUpdate);
    editor.on("blur", onBlur);
    return () => {
      editor.off("update", onUpdate);
      editor.off("selectionUpdate", onSelectionUpdate);
      editor.off("blur", onBlur);
    };
  }, [editor, session]);

  // ---- read-only preview of a deleted note: the session owns the mode; the UI follows it ----

  const preview = state.mode.kind === "preview" ? state.mode.item : null;
  const startPreview = useCallback(
    (note: rpc.DeletedItem) => {
      setFind(null);
      setLinkTarget(null);
      void session.startPreview(note);
    },
    [session],
  );
  const exitPreview = useCallback(() => {
    session.exitPreview();
    editor.view.focus();
  }, [editor, session]);
  const restorePreview = useCallback(() => void session.restorePreview(), [session]);

  // ---- boot and native events ----

  useEffect(() => {
    let cancelled = false;
    void api.system
      .ready()
      .then(async (ready) => {
        if (cancelled) return;
        setSettings(ready.settings);
        setHost(ready.host);
        await session.applyBoot(ready.windowData);
        focusEditorNow(editor);
      })
      .catch((error: unknown) => notify(`Could not load notes: ${String(error)}`, "error"));
    return () => {
      cancelled = true;
    };
  }, [api, editor, session, setSettings, notify]);

  useEffect(() => {
    const offs = [
      api.on("note.open", ({ id }) => void session.handleNoteOpen(id)),
      api.on("note.new", ({ note }) => void session.handleNoteNew(note)),
      api.on("notes.changed", ({ ids }) => void session.handleNotesChanged(ids)),
      api.on("window.didShow", () => {
        if (editor.isDestroyed) return;
        focusEditorNow(editor);
        editor.commands.scrollIntoView();
      }),
      api.on("window.didHide", () => session.saveInBackground()),
      api.on("window.didResignKey", () => session.saveInBackground()),
      // Development only: a new editor build is ready. Save first, so no keystroke is lost; the
      // reloaded page opens the same note at the saved caret.
      api.on("editor.willReload", () => void session.flush().finally(() => window.location.reload())),
      // The helper awaits this before it shuts down, so the last keystrokes are saved.
      api.onFlush(() => session.flush()),
    ];
    const onHide = () => {
      if (document.visibilityState === "hidden") session.saveInBackground();
    };
    const onUnload = () => session.saveInBackground();
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onUnload);
    window.addEventListener("beforeunload", onUnload);
    window.addEventListener("blur", onUnload);
    return () => {
      for (const off of offs) off();
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onUnload);
      window.removeEventListener("beforeunload", onUnload);
      window.removeEventListener("blur", onUnload);
    };
  }, [api, editor, session]);

  useEffect(() => {
    void loadGrammars(lowlight, editor);
  }, [editor, lowlight]);

  // ---- zoom and resize ----

  // Settings' Display and Editor groups that the page applies itself (v3.8); the helper applies appearance.
  useEffect(() => {
    document.documentElement.dataset.font = settings.font;
  }, [settings.font]);
  useEffect(() => {
    spellcheckRef.current = settings.spellcheck;
    editor.view.setProps({});
  }, [editor, settings.spellcheck]);
  useEffect(() => setSmartTypography(editor, settings.smartTypography), [editor, settings.smartTypography]);

  useEffect(() => {
    document.documentElement.style.setProperty("--zoom", String(settings.zoom));
    // High zoom switches the chrome to its scrolling and wrapping layout (app.css).
    document.documentElement.dataset.highZoom = String(settings.zoom >= 1.75);
  }, [settings.zoom]);

  // ---- derived UI state ----

  const doc = editor.getJSON();
  const text = docToPlainText(doc);
  const liveTitle = deriveTitle(doc);
  const counts = { characters: countCharacters(text), words: countWords(text) };
  const { from, to, empty } = editor.state.selection;
  const selectedText = empty ? "" : editor.state.doc.textBetween(from, to, "\n", "\n");
  const selected = empty ? null : { characters: countCharacters(selectedText), words: countWords(selectedText) };
  const title = displayTitle({ title: liveTitle, text });
  const blank = text.trim() === "";
  // Entirely empty: no preview and one empty paragraph. The hints overlay it and are never content.
  const entirelyEmpty =
    !preview &&
    doc.content?.length === 1 &&
    doc.content[0]?.type === "paragraph" &&
    !(doc.content[0].content?.length ?? 0);
  const slash = editor.isFocused ? slashQueryAt(editor.state) : null;
  const slashItems = slash && slash.from !== slashDismissed ? filterSlashItems(slash.query) : [];
  const emojiQuery = editor.isFocused ? emojiQueryAt(editor.state) : null;
  const showEmoji = emojiQuery !== null && emojiQuery.from !== emojiDismissed;
  // Only a dialog grows a short panel; panels and dropdowns stay inside it and scroll (useDropdownPlacement).
  const overlayRem = confirm ? 34 : null;
  const hasSelection = !editor.state.selection.empty;
  const inList = editor.isActive("list");
  // Before the height reports, so a cold start knows the minimum when it first sizes the panel.
  useMinimumSizeReporter(app, api);
  useNearBottom(app);
  useResizeReporter(app, api, { autoSize: settings.windowAutoSize, overlayRem });
  useScrollEdges(app);

  // ---- the terminal drawer ----

  const setTerminalOpen = useCallback((open: boolean) => updateSettings({ terminal: { open } }), [updateSettings]);
  const focusNote = useCallback(() => editor.view.focus(), [editor]);
  const terminal = useTerminalDrawer({
    api,
    open: settings.terminal?.open ?? false,
    setOpen: setTerminalOpen,
    zoom: settings.zoom,
    focusNote,
  });
  useDragRegions(app, api, settings.zoom, terminal.expanded);

  // ---- actions ----

  const openLink = useCallback(() => openLinkIn(editor), [editor, openLinkIn]);

  const setZoom = useCallback(
    (zoom: number, message: string) => {
      updateSettings({ zoom });
      notify(message);
    },
    [updateSettings, notify],
  );

  const exportAs = useCallback(
    async (format: ExportFormat) => {
      const json = editor.getJSON();
      const content =
        format === "md" ? docToMarkdown(json) : format === "html" ? docToHTML(json) : docToPlainText(json);
      try {
        const result = await api.file.saveAs({ suggestedName: exportFileName(docToPlainText(json), format), content });
        if (result.saved)
          notify(`Exported as ${format === "md" ? "Markdown" : format === "html" ? "HTML" : "Plain Text"}`);
      } catch {
        notify("Could not export the note", "error");
      }
    },
    [api, editor, notify],
  );

  const copyAs = useCallback(
    async (format: ExportFormat) => {
      const json = sliceJSON(editor) ?? editor.getJSON();
      const content =
        format === "md" ? docToMarkdown(json) : format === "html" ? docToHTML(json) : docToPlainText(json);
      await copyText(content).then(
        () => notify(`Copied as ${format === "md" ? "Markdown" : format === "html" ? "HTML" : "Plain Text"}`),
        () => undefined,
      );
    },
    [copyText, editor, notify],
  );

  /** Delete All asks first, naming how many notes, and works only once DELETE is typed (SPEC §11). */
  const deleteAll = useCallback(() => {
    void api.notes
      .count()
      .catch(() => null)
      .then((result) => {
        const count = result?.count;
        setConfirm({
          title: count === undefined ? "Delete all notes?" : `Delete all ${count} ${count === 1 ? "note" : "notes"}?`,
          message: `They move to Recently Deleted for ${rpc.TRASH_RETENTION_DAYS} days. Type DELETE to confirm.`,
          confirm: "Delete all",
          destructive: true,
          typeToConfirm: "DELETE",
          onConfirm: () => void session.deleteAll(),
        });
      });
  }, [api, session]);

  /** Quit Overnote (⌘Q in the native menu, or All actions): the helper saves pending edits, then exits. */
  const quitApp = useCallback(() => {
    session.saveInBackground();
    void api.app.quit().catch(() => notify("Could not quit Overnote. Try again.", "error"));
  }, [api, session, notify]);

  /** The red dot and ⌘M: always hide, whatever Escape is set to do (with no Dock icon, minimize means hide). */
  const closeWindow = useCallback(() => {
    session.saveInBackground();
    void api.window.hide().catch(() => undefined);
  }, [api, session]);

  const hide = useCallback(() => {
    session.saveInBackground();
    if (settings.escapeLosesFocus) void api.window.resignFocus().catch(() => undefined);
    else void api.window.hide().catch(() => undefined);
  }, [api, session, settings.escapeLosesFocus]);

  /** `window.place`: a failure shows one error notice. */
  const placeWindow = useCallback(
    (placement: PanelPlacement) => {
      void api.window.place(placement).catch(() => notify("Could not place the window. Try again.", "error"));
    },
    [api, notify],
  );

  /*
   * Raycast documents no deeplink that opens Create Quicklink prefilled (manual.raycast.com/quicklinks,
   * developers.raycast.com deeplinks), so the note's deeplink goes to the clipboard, where the
   * Create Quicklink form can autofill it from.
   */
  const createQuicklink = useCallback(() => {
    const id = session.getState().current?.id;
    if (!id) return;
    void copyText(noteDeeplink(id)).then(
      () => notify("Deeplink copied. Open Create Quicklink in Raycast and paste it as the link."),
      () => undefined,
    );
  }, [copyText, notify, session]);

  const pinned = state.current?.pinned !== null && state.current?.pinned !== undefined;

  const moveItem = useCallback(
    (direction: "up" | "down") => {
      moveListItem(direction)(editor.state, editor.view.dispatch, editor.view);
      focusEditorNow(editor);
    },
    [editor],
  );

  const format = useCallback(
    (id: FormatId) => {
      runFormat(editor, id, openLink);
    },
    [editor, openLink],
  );

  const { current: currentNote, canGoBack, canGoForward } = state;
  const lists = useMemo((): Record<"root" | "format" | "heading" | "copyAs" | "export", PanelAction[]> => {
    return {
      root: [
        {
          id: "new",
          title: "New Note",
          shortcut: "⌘N",
          section: "notes",
          icon: "plus",
          enabled: !blank,
          run: () => void session.newNote(),
        },
        ...(preview
          ? []
          : [
              {
                id: "duplicate",
                title: "Duplicate Note",
                shortcut: "⌘D",
                section: "notes",
                icon: "copy",
                enabled: !blank,
                run: () => void session.duplicate(),
              },
              {
                id: "pin",
                title: pinned ? "Unpin Note" : "Pin Note",
                shortcut: "⇧⌘P",
                section: "notes",
                icon: "pin",
                run: () => void session.togglePin(),
              },
            ]),
        { id: "browse", title: "Browse Notes", shortcut: "⌘P", section: "notes", icon: "browse", push: "browse" },
        {
          id: "back",
          title: "Go Back",
          shortcut: "⌘[",
          section: "notes",
          icon: "back",
          enabled: canGoBack,
          run: () => void session.back(),
        },
        {
          id: "forward",
          title: "Go Forward",
          shortcut: "⌘]",
          section: "notes",
          icon: "forward",
          enabled: canGoForward,
          run: () => void session.forward(),
        },
        {
          id: "find",
          title: "Find in Note",
          shortcut: "⌘F",
          section: "copy",
          icon: "search",
          run: () => setFind({ term: "" }),
        },
        {
          id: "copyAs",
          title: hasSelection ? "Copy Selection As…" : "Copy Note As…",
          shortcut: "⇧⌘C",
          section: "copy",
          icon: "copy",
          push: "copyAs",
        },
        {
          id: "deeplink",
          title: "Copy Deeplink",
          shortcut: "⇧⌘D",
          section: "copy",
          icon: "link",
          run: () =>
            currentNote &&
            void copyText(noteDeeplink(currentNote.id)).then(
              () => notify("Copied deeplink", "success"),
              () => undefined,
            ),
        },
        {
          id: "quicklink",
          title: "Create Quicklink",
          shortcut: "⇧⌘L",
          section: "copy",
          icon: "open",
          run: createQuicklink,
        },
        { id: "export", title: "Export…", shortcut: "⇧⌘E", section: "copy", icon: "open", push: "export" },
        {
          id: "moveUp",
          title: "Move List Item Up",
          shortcut: "⌃⌘↑",
          section: "edit",
          icon: "up",
          enabled: inList,
          run: () => moveItem("up"),
        },
        {
          id: "moveDown",
          title: "Move List Item Down",
          shortcut: "⌃⌘↓",
          section: "edit",
          icon: "down",
          enabled: inList,
          run: () => moveItem("down"),
        },
        { id: "format", title: "Format…", shortcut: "⇧⌘,", section: "edit", icon: "format", push: "format" },
        {
          id: "autosize",
          title: settings.windowAutoSize ? "Disable Window Auto-Sizing" : "Enable Window Auto-Sizing",
          shortcut: "⇧⌘/",
          section: "window",
          icon: "expand",
          run: () => updateSettings({ windowAutoSize: !settings.windowAutoSize }),
        },
        {
          id: "fillLeft",
          title: "Fill Left",
          shortcut: "⌃⌥←",
          section: "window",
          icon: "fillLeft",
          keywords: ["snap", "tile", "half", "left", "move"],
          run: () => placeWindow("left"),
        },
        {
          id: "fillRight",
          title: "Fill Right",
          shortcut: "⌃⌥→",
          section: "window",
          icon: "fillRight",
          keywords: ["snap", "tile", "half", "right", "move"],
          run: () => placeWindow("right"),
        },
        {
          id: "fillScreen",
          title: "Fill Screen",
          shortcut: "⌃⌥↑",
          section: "window",
          icon: "fillScreen",
          keywords: ["snap", "tile", "full", "maximize", "move"],
          run: () => placeWindow("fill"),
        },
        {
          id: "centre",
          title: "Centre",
          shortcut: "⌃⌥↓",
          section: "window",
          icon: "centre",
          keywords: ["snap", "center", "middle", "move"],
          run: () => placeWindow("center"),
        },
        {
          id: "terminal",
          title: terminal.open ? "Close Terminal" : "Open Terminal",
          shortcut: "⌃`",
          section: "window",
          icon: "terminal",
          keywords: ["shell", "console", "herdr", "drawer"],
          run: terminal.toggle,
        },
        {
          id: "formatBar",
          title: "Toggle Format Bar",
          shortcut: "⌥⌘,",
          section: "window",
          icon: "format",
          run: () => updateSettings({ showFormatBar: !settings.showFormatBar }),
        },
        {
          id: "actualSize",
          title: "Actual Size",
          shortcut: "⌘0",
          section: "zoom",
          icon: "expand",
          enabled: settings.zoom !== 1,
          run: () => setZoom(1, "Zoom reset"),
        },
        {
          id: "zoomIn",
          title: "Zoom In",
          shortcut: "⌘=",
          section: "zoom",
          icon: "plus",
          enabled: settings.zoom < 2,
          run: () => setZoom(stepZoom(settings.zoom, 1), `Zoom ${zoomLabel(stepZoom(settings.zoom, 1))}`),
        },
        {
          id: "zoomOut",
          title: "Zoom Out",
          shortcut: "⌘-",
          section: "zoom",
          icon: "minus",
          enabled: settings.zoom > 0.75,
          run: () => setZoom(stepZoom(settings.zoom, -1), `Zoom ${zoomLabel(stepZoom(settings.zoom, -1))}`),
        },
        {
          id: "settings",
          title: "Settings…",
          shortcut: "⌘,",
          section: "settings",
          icon: "sliders",
          keywords: ["preferences"],
          run: () => setPanel("settings"),
        },
        {
          id: "deleted",
          title: "Recently Deleted",
          section: "danger",
          icon: "restore",
          keywords: ["show", "trash", "deleted notes", "recover"],
          push: "deleted",
        },
        {
          id: "delete",
          title: "Delete Note",
          shortcut: "⌃X",
          section: "danger",
          icon: "trash",
          destructive: true,
          // The note on screen during a preview is not the current note; restore it first.
          enabled: !preview,
          run: () => void session.deleteCurrent(),
        },
        {
          id: "deleteAll",
          title: "Delete All Notes",
          shortcut: "⌃⇧X",
          section: "danger",
          icon: "trash",
          destructive: true,
          run: deleteAll,
        },
        // Only Overnote.app quits: the Raycast extension owns its helper and starts it on demand.
        ...(host === "app"
          ? [
              {
                id: "quit",
                title: "Quit Overnote",
                shortcut: "⌘Q",
                section: "danger",
                icon: "power",
                destructive: true,
                keywords: ["exit", "close app"],
                run: quitApp,
              } satisfies PanelAction,
            ]
          : []),
      ],
      format: [
        { id: "heading", title: "Heading…", section: "Inline", push: "heading" },
        { id: "bold", title: "Bold", shortcut: "⌘B", section: "Inline", run: () => format("bold") },
        { id: "italic", title: "Italic", shortcut: "⌘I", section: "Inline", run: () => format("italic") },
        { id: "strike", title: "Strikethrough", shortcut: "⇧⌘S", section: "Inline", run: () => format("strike") },
        { id: "underline", title: "Underline", shortcut: "⌘U", section: "Inline", run: () => format("underline") },
        { id: "code", title: "Code", shortcut: "⌘E", section: "Inline", run: () => format("code") },
        { id: "link", title: "Link", shortcut: "⌘L", section: "Inline", run: () => setTimeout(openLink, 0) },
        // The design's block names (BLOCK_LABELS) in title case; the old names stay findable as keywords.
        {
          id: "codeBlock",
          title: "Code Block",
          shortcut: "⌥⌘C",
          section: "Block",
          keywords: ["pre", "snippet"],
          run: () => format("codeBlock"),
        },
        {
          id: "blockquote",
          title: "Quote",
          shortcut: "⇧⌘B",
          section: "Block",
          keywords: ["blockquote"],
          run: () => format("blockquote"),
        },
        { id: "divider", title: "Divider", section: "Block", keywords: ["rule", "line"], run: () => format("divider") },
        {
          id: "bullet",
          title: "Bulleted List",
          shortcut: "⇧⌘8",
          section: "List",
          keywords: ["bullet list", "unordered"],
          run: () => format("bullet"),
        },
        {
          id: "ordered",
          title: "Numbered List",
          shortcut: "⇧⌘7",
          section: "List",
          keywords: ["ordered list"],
          run: () => format("ordered"),
        },
        {
          id: "task",
          title: "Checklist",
          shortcut: "⇧⌘9",
          section: "List",
          keywords: ["task list", "todo", "check"],
          run: () => format("task"),
        },
      ],
      heading: [1, 2, 3].map((level) => ({
        id: `h${level}`,
        title: BLOCK_LABELS[`h${level}` as "h1" | "h2" | "h3"],
        shortcut: `⌥⌘${level}`,
        keywords: [`heading ${level}`],
        section: "Heading",
        run: () => format(`h${level}` as FormatId),
      })),
      copyAs: (["md", "html", "txt"] as const).map((f) => ({
        id: `copy-${f}`,
        title: f === "md" ? "Markdown" : f === "html" ? "HTML" : "Plain Text",
        section: "Copy",
        run: () => void copyAs(f),
      })),
      export: (["md", "html", "txt"] as const).map((f) => ({
        id: `export-${f}`,
        title: f === "md" ? "Markdown" : f === "html" ? "HTML" : "Plain Text",
        section: "Export",
        run: () => void exportAs(f),
      })),
    };
  }, [
    host,
    quitApp,
    hasSelection,
    inList,
    blank,
    pinned,
    currentNote,
    canGoBack,
    canGoForward,
    settings,
    session,
    copyText,
    notify,
    updateSettings,
    setZoom,
    deleteAll,
    format,
    openLink,
    copyAs,
    exportAs,
    moveItem,
    createQuicklink,
    placeWindow,
    preview,
    terminal.open,
    terminal.toggle,
  ]);

  // ---- window level shortcuts ----

  const handlers = useLatest({
    closeWindow,
    createQuicklink,
    lists,
    session,
    state,
    settings,
    panel,
    find,
    linkTarget,
    confirm,
    slashItems,
    showEmoji,
    hide,
    deleteAll,
    setZoom,
    openLink,
    placeWindow,
    preview,
    exitPreview,
    terminal,
    notices,
    act,
  });
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const h = handlers.current;
      // While the terminal has focus, every key goes to the shell except a short allowlist (terminal/keys.ts).
      const fromTerminal = inTerminal(event.target);
      if (fromTerminal && !reachesOvernote(event)) return;
      if (h.confirm) return;
      const run = (fn: () => void) => {
        event.preventDefault();
        event.stopPropagation();
        fn();
      };
      if (matches(event, TOGGLE_TERMINAL)) return run(() => h.terminal.toggleFromKeys(fromTerminal));
      // ⇧⌘↩ is contextual like ⌘↩: on a task in the note it checks the task with its subtasks (the list keymap);
      // anywhere else, from the terminal, or in the full-panel view, it expands or collapses the terminal.
      if (matches(event, EXPAND_TERMINAL)) {
        const onTask = !fromTerminal && !h.terminal.expanded && editor.isFocused && activeListKind(editor) === "task";
        if (!onTask) return run(h.terminal.toggleExpanded);
      }
      // ⌘Z undoes a delete while its toast shows, but only when the note itself has nothing to undo: a note opened
      // by the delete starts with an empty history, so text undo is never taken away.
      if (matches(event, { code: "KeyZ", meta: true }) && !fromTerminal && !h.panel && undoDepth(editor.state) === 0) {
        const undo = h.notices.find((notice) => !notice.leaving && notice.action?.shortcut === "⌘Z");
        if (undo) return run(() => h.act(undo.id));
      }
      if (matches(event, { code: "KeyK", meta: true }))
        return run(() => setPanel(h.panel && h.panel !== "settings" ? null : "root"));
      if (matches(event, { code: "KeyP", meta: true }))
        return run(() => setPanel(h.panel === "browse" ? null : "browse"));
      if (matches(event, { code: "Comma", meta: true, shift: true })) return run(() => setPanel("format"));
      if (matches(event, { code: "KeyC", meta: true, shift: true })) return run(() => setPanel("copyAs"));
      if (matches(event, { code: "KeyE", meta: true, shift: true })) return run(() => setPanel("export"));
      if (matches(event, { code: "Comma", meta: true }))
        return run(() => setPanel(h.panel === "settings" ? null : "settings"));
      const placements: [string, PanelPlacement][] = [
        ["ArrowLeft", "left"],
        ["ArrowRight", "right"],
        ["ArrowUp", "fill"],
        ["ArrowDown", "center"],
      ];
      for (const [code, placement] of placements) {
        if (matches(event, { code, ctrl: true, alt: true }))
          return run(() => {
            setPanel(null);
            h.placeWindow(placement);
          });
      }
      if (h.panel) return; // the panel handles the rest of its keys
      const slot = pinSlot(event);
      if (slot !== null) {
        const opening = h.session.openPinSlot(slot);
        if (opening) run(() => undefined);
        return;
      }
      if (matches(event, { code: "KeyN", meta: true })) return run(() => void h.session.newNote());
      if (matches(event, { code: "KeyM", meta: true })) return run(h.closeWindow);
      if (matches(event, { code: "KeyX", ctrl: true })) return run(() => void h.session.deleteCurrent());
      if (matches(event, { code: "KeyX", ctrl: true, shift: true })) return run(h.deleteAll);
      if (matches(event, { code: "KeyP", meta: true, shift: true })) return run(() => void h.session.togglePin());
      if (matches(event, { code: "KeyD", meta: true })) return run(() => void h.session.duplicate());
      if (matches(event, { code: "KeyD", meta: true, shift: true })) {
        return run(() => h.lists.root.find((a) => a.id === "deeplink")?.run?.());
      }
      if (matches(event, { code: "KeyL", meta: true, shift: true })) return run(h.createQuicklink);
      if (
        matches(event, { code: "BracketLeft", meta: true }) ||
        matches(event, { code: "ArrowDown", meta: true, alt: true })
      ) {
        if (h.find && event.code === "ArrowDown") return;
        return run(() => void h.session.back());
      }
      if (
        matches(event, { code: "BracketRight", meta: true }) ||
        matches(event, { code: "ArrowUp", meta: true, alt: true })
      ) {
        return run(() => void h.session.forward());
      }
      if (matches(event, { code: "KeyF", meta: true })) {
        return run(() => {
          const { doc, selection } = editor.state;
          const selected = doc.textBetween(selection.from, selection.to, " ");
          if (!h.find) setFind({ term: selected });
          else if (!findRef.current?.focusOrClose(selected)) {
            setFind(null);
            focusEditorNow(editor);
          }
        });
      }
      if (matches(event, { code: "Comma", meta: true, alt: true })) {
        return run(() => updateSettings({ showFormatBar: !h.settings.showFormatBar }));
      }
      if (matches(event, { code: "Slash", meta: true, shift: true })) {
        return run(() => updateSettings({ windowAutoSize: !h.settings.windowAutoSize }));
      }
      if (matches(event, { code: "Equal", meta: true }) || matches(event, { code: "Equal", meta: true, shift: true })) {
        if (h.settings.zoom >= 2) return run(() => undefined);
        return run(() => h.setZoom(stepZoom(h.settings.zoom, 1), `Zoom ${zoomLabel(stepZoom(h.settings.zoom, 1))}`));
      }
      if (matches(event, { code: "Minus", meta: true })) {
        if (h.settings.zoom <= 0.75) return run(() => undefined);
        return run(() => h.setZoom(stepZoom(h.settings.zoom, -1), `Zoom ${zoomLabel(stepZoom(h.settings.zoom, -1))}`));
      }
      if (matches(event, { code: "Digit0", meta: true })) {
        return run(() => {
          if (h.settings.zoom !== 1) h.setZoom(1, "Zoom reset");
        });
      }
      if (event.key === "Escape" && !event.defaultPrevented) {
        if (h.preview) return run(h.exitPreview);
        if (h.linkTarget || h.find || h.slashItems.length || h.showEmoji) return;
        if (document.activeElement?.closest(".note-editor") || document.activeElement === document.body)
          return run(h.hide);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [editor, handlers, updateSettings]);

  // Switching notes closes the find bar and the link popover, in the same render as the switch.
  const currentId = state.current?.id ?? null;
  const [shownId, setShownId] = useState(currentId);
  if (shownId !== currentId) {
    setShownId(currentId);
    setFind(null);
    setLinkTarget(null);
  }

  // The empty note hints (SPEC §9) show on a note that opens entirely empty, fade on its first keystroke, and stay
  // gone for that note even if it is emptied again. One small state per shown note, set during render with the switch.
  const [hints, setHints] = useState<{ id: NoteId | null; phase: "none" | "shown" | "faded" }>({
    id: null,
    phase: "none",
  });
  if (state.ready && !preview) {
    if (hints.id !== currentId) setHints({ id: currentId, phase: entirelyEmpty ? "shown" : "none" });
    else if (hints.phase === "shown" && !entirelyEmpty) setHints({ id: currentId, phase: "faded" });
  }
  const hintsPhase = state.ready && !preview && hints.id === currentId ? hints.phase : "none";

  const runSlash = (item: SlashItem) => {
    if (!slash) return;
    focusEditorNow(editor);
    editor.chain().deleteRange({ from: slash.from, to: slash.to }).run();
    runFormat(editor, item.id as FormatId, openLink);
  };

  // A boot that stays unready for 300 ms says so quietly; a fast boot shows nothing.
  const [bootWaited, setBootWaited] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setBootWaited(true), BOOT_STATUS_MS);
    return () => clearTimeout(timer);
  }, []);
  const slowBoot = bootWaited && !state.ready;

  const closePanel = () => {
    setPanel(null);
    // view.focus is synchronous; Tiptap's focus command waits a frame and could steal focus from a panel opened right after.
    if (!find) editor.view.focus();
  };

  return (
    <div
      className="app"
      ref={setApp}
      data-testid="app"
      data-ready={state.ready ? "true" : "false"}
      data-note-id={currentId ?? ""}
      data-terminal={terminal.visible ? "open" : undefined}
    >
      <Toolbar
        title={title}
        onClose={closeWindow}
        onActions={() => setPanel(panel ? null : "root")}
        onBrowse={() => setPanel("browse")}
        onNew={() => void session.newNote()}
        terminalOpen={terminal.open}
        onTerminal={terminal.toggle}
      />
      {slowBoot ? (
        <div className="boot-status" data-testid="boot-status" role="status">
          Loading your notes
        </div>
      ) : null}
      {find ? <FindBar ref={findRef} editor={editor} initialTerm={find.term} onClose={() => setFind(null)} /> : null}
      {preview ? (
        <div className="preview-banner" data-testid="preview-banner" role="status">
          <span>This note is in Recently Deleted.</span>
          <button type="button" className="text-button is-primary" onClick={restorePreview}>
            Restore
          </button>
        </div>
      ) : null}
      <main
        className="content"
        onMouseDown={(event) => {
          if (preview) {
            event.preventDefault();
            setConfirm({
              title: "Restore Note?",
              message: "This note is in Recently Deleted. Restore it to edit it.",
              confirm: "Restore",
              onConfirm: restorePreview,
            });
            return;
          }
          if (event.target === event.currentTarget) {
            event.preventDefault();
            focusEditorNow(editor, "end");
          }
        }}
      >
        <div className="content-inner">
          <EditorContent editor={editor} />
          {hintsPhase !== "none" ? (
            <p className="empty-hint" data-testid="empty-hint" data-faded={hintsPhase === "faded" || undefined}>
              Start with a title, or just write.
            </p>
          ) : null}
        </div>
      </main>
      <Footer
        editor={editor}
        counts={counts}
        selected={selected}
        countMode={settings.countMode}
        showFormatBar={settings.showFormatBar && !preview}
        onToggleCount={() => updateSettings({ countMode: settings.countMode === "words" ? "characters" : "words" })}
        onToggleFormatBar={() => updateSettings({ showFormatBar: !settings.showFormatBar })}
        openLink={openLink}
        hints={hintsPhase === "none" ? null : hintsPhase}
      />
      {slash && slashItems.length ? (
        <SlashMenu
          ref={slashRef}
          editor={editor}
          items={slashItems}
          query={slash.query}
          from={slash.from}
          onRun={runSlash}
          onDismiss={() => setSlashDismissed(slash.from)}
        />
      ) : null}
      {emojiQuery && showEmoji ? (
        <EmojiPicker
          ref={emojiRef}
          editor={editor}
          from={emojiQuery.from}
          query={emojiQuery.query}
          onPick={(emoji) => {
            focusEditorNow(editor);
            editor.chain().insertContentAt({ from: emojiQuery.from, to: emojiQuery.to }, emoji).run();
            recordEmojiUse(emoji);
          }}
          onDismiss={() => setEmojiDismissed(emojiQuery.from)}
        />
      ) : null}
      {linkTarget ? (
        <LinkPopover
          editor={editor}
          target={linkTarget}
          onClose={() => setLinkTarget(null)}
          notify={notify}
          openUrl={openUrl}
          copy={(value) => copyText(value)}
        />
      ) : null}
      {panel === "settings" ? (
        <SettingsPage
          api={api}
          settings={settings}
          notify={notify}
          onChange={updateSettings}
          onReset={() =>
            attempt("reset the settings", async () => {
              await resetSettings();
              notify("Settings reset to defaults", "success");
            })
          }
          onDeleteAll={deleteAll}
          onBack={closePanel}
          onHide={closeWindow}
        />
      ) : panel ? (
        <CommandPanel
          key={panel}
          initial={panel}
          lists={lists}
          api={api}
          currentId={currentId}
          settings={settings}
          onSettings={updateSettings}
          onClose={closePanel}
          onOpenNote={(id: NoteId) => void session.open(id)}
          onCreateNote={(title) => void session.newNote(title)}
          onTogglePin={(id, pin) =>
            attempt(pin ? "pin the note" : "unpin the note", async () => {
              if (pin) await api.notes.pin(id);
              else await api.notes.unpin(id);
              notify(pin ? "Note pinned" : "Note unpinned", "info", {
                label: pin ? "Unpin" : "Pin",
                run: () => void (pin ? api.notes.unpin(id) : api.notes.pin(id)).then(() => session.refresh()),
              });
              await session.refresh();
            })
          }
          onDeleteNote={(id) =>
            attempt("delete the note", async () => {
              if (id === currentId) await session.deleteCurrent();
              else {
                await api.notes.delete(id);
                session.history.remove(id);
                notify("Note deleted", "info", session.undoDelete(id));
                await session.refresh();
              }
            })
          }
          onRecover={(id) =>
            attempt("restore the note", async () => {
              await api.notes.recover(id);
              notify("Note restored", "success");
              await session.refresh();
            })
          }
          onPreview={startPreview}
          onPermanentlyDelete={(id) =>
            new Promise<void>((settle) =>
              setConfirm({
                title: "Permanently Delete Note?",
                message: "This note will be deleted forever. This cannot be undone.",
                confirm: "Delete",
                destructive: true,
                onConfirm: () =>
                  void attempt("delete the note", async () => {
                    await api.notes.permanentlyDelete(id);
                    notify("Note permanently deleted");
                  }).then(settle),
                onCancel: settle,
              }),
            )
          }
        />
      ) : null}
      <ExitGhost
        open={panel !== null}
        root={app}
        selector=".panel-backdrop"
        className="panel-ghost"
        token="--duration-pop"
      />
      {confirm ? <ConfirmDialog key={confirmKey(confirm)} request={confirm} onClose={() => setConfirm(null)} /> : null}
      <Notices notices={notices} onExited={dismissNotice} onDismiss={dismiss} onAction={act} />
      <TerminalDrawer terminal={terminal} noteTitle={title} onHide={hide} setHost={terminal.controller.setHost} />
    </div>
  );
}
