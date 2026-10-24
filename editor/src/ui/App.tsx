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
  loadDoc,
  type JSONContent,
  type NoteId,
  type PanelPlacement,
  type rpc,
} from "@overnote/core";
import { EditorContent, useEditor } from "@tiptap/react";
import type { AnyExtension, Editor } from "@tiptap/core";
import { EditorState, TextSelection, type Transaction } from "@tiptap/pm/state";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Api } from "../bridge/api";
import { runFormat, type FormatId } from "../editor/commands";
import { createEditorExtensions } from "../editor/extensions";
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
import { ConfirmDialog, type ConfirmRequest } from "./ConfirmDialog";
import { FindBar, type FindBarHandle } from "./FindBar";
import { Footer } from "./Footer";
import { ExitGhost } from "./ExitGhost";
import {
  useDragRegions,
  useLatest,
  useMinimumSizeReporter,
  useNotices,
  useResizeReporter,
  useScrollEdges,
  useSettings,
} from "./hooks";
import { LinkPopover } from "./LinkPopover";
import { Notices } from "./Notices";
import { SlashMenu, type SlashMenuHandle } from "./SlashMenu";
import { Toolbar } from "./Toolbar";

type ExportFormat = "md" | "html" | "txt";

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
  editor.commands.setContent(doc, { emitUpdate: false });
  const { state } = editor;
  editor.view.updateState(EditorState.create({ doc: state.doc, plugins: state.plugins }));
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
  const { notices, notify, remove: dismissNotice } = useNotices();
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
  const [panel, setPanel] = useState<PanelViewName | null>(null);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [find, setFind] = useState<{ term: string } | null>(null);
  const findRef = useRef<FindBarHandle>(null);
  const slashRef = useRef<SlashMenuHandle>(null);
  const emojiRef = useRef<EmojiPickerHandle>(null);
  const [emojiDismissed, setEmojiDismissed] = useState<number | null>(null);
  const [slashDismissed, setSlashDismissed] = useState<number | null>(null);
  // Bumped on every transaction: the editor state is read while rendering (shouldRerenderOnTransaction is off).
  const [, setTick] = useState(0);
  const [preview, setPreview] = useState<rpc.DeletedItem | null>(null);

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

  const editor = useEditor({
    extensions,
    content: { type: "doc", content: [{ type: "paragraph" }] },
    immediatelyRender: true,
    shouldRerenderOnTransaction: false,
    editorProps: {
      // The top margin keeps the caret below the scroll fade under the toolbar.
      scrollThreshold: { top: 24, bottom: 100, left: 0, right: 0 },
      scrollMargin: { top: 24, bottom: 100, left: 0, right: 0 },
      attributes: { class: "note-editor", "data-testid": "editor", spellcheck: "true" },
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
    };
    return new NoteSession({ api, editor: port, notice: (message, kind) => notify(message, kind) });
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

  // ---- read-only preview of a deleted note ----

  const startPreview = useCallback(
    async (note: rpc.DeletedItem) => {
      if (!(await session.pause())) return;
      setFind(null);
      setLinkTarget(null);
      editor.setEditable(false, false);
      loadIntoEditor(editor, loadDoc(note.rawContent || null, note.preview), 0);
      setPreview(note);
    },
    [editor, session],
  );

  const exitPreview = useCallback(() => {
    editor.setEditable(true, false);
    session.resume();
    setPreview(null);
    editor.view.focus();
  }, [editor, session]);

  const restorePreview = useCallback(
    async (note: rpc.DeletedItem) => {
      try {
        await api.notes.recover(note.id);
      } catch {
        notify("Could not restore the note", "error");
        return;
      }
      editor.setEditable(true, false);
      await session.open(note.id);
      notify("Note restored");
    },
    [api, editor, session, notify],
  );

  // Any switch, create, or delete reloads a note and unpauses the session, which ends the preview.
  if (preview && !state.paused) setPreview(null);
  useEffect(() => {
    if (!preview && !editor.isEditable) editor.setEditable(true, false);
  }, [editor, preview]);

  // ---- boot and native events ----

  useEffect(() => {
    let cancelled = false;
    void api.system
      .ready()
      .then(async (ready) => {
        if (cancelled) return;
        setSettings(ready.settings);
        await session.applyBoot(ready.windowData);
        editor.commands.focus();
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
        if (!editor.isDestroyed) editor.commands.focus(undefined, { scrollIntoView: true });
      }),
      api.on("window.didHide", () => session.saveInBackground()),
      api.on("window.didResignKey", () => session.saveInBackground()),
      // Development only: a new editor build is ready. Save first, so no keystroke is lost; the
      // reloaded page opens the same note at the saved caret.
      api.on("editor.willReload", () => void session.flush().finally(() => window.location.reload())),
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

  useEffect(() => {
    document.documentElement.style.setProperty("--zoom", String(settings.zoom));
  }, [settings.zoom]);

  // ---- derived UI state ----

  const doc = editor.getJSON();
  const text = docToPlainText(doc);
  const liveTitle = deriveTitle(doc);
  const counts = { characters: countCharacters(text), words: countWords(text) };
  const title = displayTitle({ title: liveTitle, text });
  const blank = text.trim() === "";
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
  useResizeReporter(app, api, { autoSize: settings.windowAutoSize, overlayRem });
  useDragRegions(app, api, settings.zoom);
  useScrollEdges(app);

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

  const deleteAll = useCallback(() => {
    setConfirm({
      title: "Delete All Notes?",
      message: "All notes will move to Recently Deleted, where they can be restored.",
      confirm: "Delete",
      destructive: true,
      onConfirm: () => void session.deleteAll(),
    });
  }, [session]);

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
      editor.commands.focus();
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
                enabled: !blank,
                run: () => void session.duplicate(),
              },
              {
                id: "pin",
                title: pinned ? "Unpin Note" : "Pin Note",
                shortcut: "⇧⌘P",
                section: "notes",
                run: () => void session.togglePin(),
              },
            ]),
        { id: "browse", title: "Browse Notes", shortcut: "⌘P", section: "notes", push: "browse" },
        {
          id: "back",
          title: "Go Back",
          shortcut: "⌘[",
          section: "notes",
          enabled: canGoBack,
          run: () => void session.back(),
        },
        {
          id: "forward",
          title: "Go Forward",
          shortcut: "⌘]",
          section: "notes",
          enabled: canGoForward,
          run: () => void session.forward(),
        },
        { id: "find", title: "Find in Note", shortcut: "⌘F", section: "copy", run: () => setFind({ term: "" }) },
        {
          id: "copyAs",
          title: hasSelection ? "Copy Selection As…" : "Copy Note As…",
          shortcut: "⇧⌘C",
          section: "copy",
          push: "copyAs",
        },
        {
          id: "deeplink",
          title: "Copy Deeplink",
          shortcut: "⇧⌘D",
          section: "copy",
          run: () =>
            currentNote &&
            void copyText(noteDeeplink(currentNote.id)).then(
              () => notify("Copied deeplink"),
              () => undefined,
            ),
        },
        { id: "quicklink", title: "Create Quicklink", shortcut: "⇧⌘L", section: "copy", run: createQuicklink },
        { id: "export", title: "Export…", shortcut: "⇧⌘E", section: "copy", push: "export" },
        {
          id: "moveUp",
          title: "Move List Item Up",
          shortcut: "⌃⌘↑",
          section: "edit",
          enabled: inList,
          run: () => moveItem("up"),
        },
        {
          id: "moveDown",
          title: "Move List Item Down",
          shortcut: "⌃⌘↓",
          section: "edit",
          enabled: inList,
          run: () => moveItem("down"),
        },
        { id: "format", title: "Format…", shortcut: "⇧⌘,", section: "edit", push: "format" },
        {
          id: "autosize",
          title: settings.windowAutoSize ? "Disable Window Auto-Sizing" : "Enable Window Auto-Sizing",
          shortcut: "⇧⌘/",
          section: "window",
          run: () => updateSettings({ windowAutoSize: !settings.windowAutoSize }),
        },
        {
          id: "fillLeft",
          title: "Fill Left",
          shortcut: "⌃⌥←",
          section: "window",
          keywords: ["snap", "tile", "half", "left", "move"],
          run: () => placeWindow("left"),
        },
        {
          id: "fillRight",
          title: "Fill Right",
          shortcut: "⌃⌥→",
          section: "window",
          keywords: ["snap", "tile", "half", "right", "move"],
          run: () => placeWindow("right"),
        },
        {
          id: "fillScreen",
          title: "Fill Screen",
          shortcut: "⌃⌥↑",
          section: "window",
          keywords: ["snap", "tile", "full", "maximize", "move"],
          run: () => placeWindow("fill"),
        },
        {
          id: "centre",
          title: "Centre",
          shortcut: "⌃⌥↓",
          section: "window",
          keywords: ["snap", "center", "middle", "move"],
          run: () => placeWindow("center"),
        },
        {
          id: "formatBar",
          title: "Toggle Format Bar",
          shortcut: "⌥⌘,",
          section: "window",
          run: () => updateSettings({ showFormatBar: !settings.showFormatBar }),
        },
        {
          id: "actualSize",
          title: "Actual Size",
          shortcut: "⌘0",
          section: "zoom",
          enabled: settings.zoom !== 1,
          run: () => setZoom(1, "Zoom reset"),
        },
        {
          id: "zoomIn",
          title: "Zoom In",
          shortcut: "⌘=",
          section: "zoom",
          enabled: settings.zoom < 2,
          run: () => setZoom(stepZoom(settings.zoom, 1), `Zoom ${zoomLabel(stepZoom(settings.zoom, 1))}`),
        },
        {
          id: "zoomOut",
          title: "Zoom Out",
          shortcut: "⌘-",
          section: "zoom",
          enabled: settings.zoom > 0.75,
          run: () => setZoom(stepZoom(settings.zoom, -1), `Zoom ${zoomLabel(stepZoom(settings.zoom, -1))}`),
        },
        {
          id: "settings",
          title: "Settings…",
          shortcut: "⌘,",
          section: "settings",
          keywords: ["preferences"],
          push: "settings",
        },
        { id: "deleted", title: "Show Recently Deleted Notes", section: "danger", push: "deleted" },
        {
          id: "delete",
          title: "Delete Note",
          shortcut: "⌃X",
          section: "danger",
          destructive: true,
          run: () => void session.deleteCurrent(),
        },
        {
          id: "deleteAll",
          title: "Delete All Notes",
          shortcut: "⌃⇧X",
          section: "danger",
          destructive: true,
          run: deleteAll,
        },
      ],
      format: [
        { id: "heading", title: "Heading…", section: "Inline", push: "heading" },
        { id: "bold", title: "Bold", shortcut: "⌘B", section: "Inline", run: () => format("bold") },
        { id: "italic", title: "Italic", shortcut: "⌘I", section: "Inline", run: () => format("italic") },
        { id: "strike", title: "Strikethrough", shortcut: "⇧⌘S", section: "Inline", run: () => format("strike") },
        { id: "underline", title: "Underline", shortcut: "⌘U", section: "Inline", run: () => format("underline") },
        { id: "code", title: "Code", shortcut: "⌘E", section: "Inline", run: () => format("code") },
        { id: "link", title: "Link", shortcut: "⌘L", section: "Inline", run: () => setTimeout(openLink, 0) },
        { id: "codeBlock", title: "Code Block", shortcut: "⌥⌘C", section: "Block", run: () => format("codeBlock") },
        { id: "blockquote", title: "Blockquote", shortcut: "⇧⌘B", section: "Block", run: () => format("blockquote") },
        { id: "ordered", title: "Ordered List", shortcut: "⇧⌘7", section: "List", run: () => format("ordered") },
        { id: "bullet", title: "Bullet List", shortcut: "⇧⌘8", section: "List", run: () => format("bullet") },
        {
          id: "task",
          title: "Task List",
          shortcut: "⇧⌘9",
          section: "List",
          keywords: ["todo", "check"],
          run: () => format("task"),
        },
      ],
      heading: [1, 2, 3].map((level) => ({
        id: `h${level}`,
        title: `Heading ${level}`,
        shortcut: `⌥⌘${level}`,
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
  ]);

  // ---- window level shortcuts ----

  const handlers = useLatest({
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
  });
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const h = handlers.current;
      if (h.confirm) return;
      const run = (fn: () => void) => {
        event.preventDefault();
        event.stopPropagation();
        fn();
      };
      if (matches(event, { code: "KeyK", meta: true })) return run(() => setPanel(h.panel ? null : "root"));
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
      if (matches(event, { code: "KeyX", ctrl: true })) return run(() => void h.session.deleteCurrent());
      if (matches(event, { code: "KeyX", ctrl: true, shift: true })) return run(h.deleteAll);
      if (matches(event, { code: "KeyP", meta: true, shift: true }))
        return run(() => !h.preview && void h.session.togglePin());
      if (matches(event, { code: "KeyD", meta: true })) return run(() => !h.preview && void h.session.duplicate());
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
            editor.commands.focus();
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

  const runSlash = (item: SlashItem) => {
    if (!slash) return;
    editor.chain().focus().deleteRange({ from: slash.from, to: slash.to }).run();
    runFormat(editor, item.id as FormatId, openLink);
  };

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
    >
      <Toolbar
        title={title}
        untitled={blank}
        onClose={() => {
          session.saveInBackground();
          void api.window.hide().catch(() => undefined);
        }}
        onActions={() => setPanel(panel ? null : "root")}
        onBrowse={() => setPanel("browse")}
        onNew={() => void session.newNote()}
      />
      {find ? <FindBar ref={findRef} editor={editor} initialTerm={find.term} onClose={() => setFind(null)} /> : null}
      {preview ? (
        <div className="preview-banner" data-testid="preview-banner" role="status">
          <span>This note is in Recently Deleted.</span>
          <button type="button" className="text-button is-primary" onClick={() => void restorePreview(preview)}>
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
              onConfirm: () => void restorePreview(preview),
            });
            return;
          }
          if (event.target === event.currentTarget) {
            event.preventDefault();
            editor.commands.focus("end");
          }
        }}
      >
        <div className="content-inner">
          <EditorContent editor={editor} />
        </div>
      </main>
      <Footer
        editor={editor}
        counts={counts}
        countMode={settings.countMode}
        showFormatBar={settings.showFormatBar && !preview}
        onToggleCount={() => updateSettings({ countMode: settings.countMode === "words" ? "characters" : "words" })}
        onToggleFormatBar={() => updateSettings({ showFormatBar: !settings.showFormatBar })}
        openLink={openLink}
      />
      {slash && slashItems.length ? (
        <SlashMenu
          ref={slashRef}
          editor={editor}
          items={slashItems}
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
            editor.chain().focus().insertContentAt({ from: emojiQuery.from, to: emojiQuery.to }, emoji).run();
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
      {panel ? (
        <CommandPanel
          key={panel}
          initial={panel}
          lists={lists}
          api={api}
          currentId={currentId}
          settings={settings}
          onSettings={updateSettings}
          onResetSettings={() =>
            attempt("reset the settings", async () => {
              await resetSettings();
              notify("Settings reset to defaults");
            })
          }
          onClose={closePanel}
          onOpenNote={(id: NoteId) => void session.open(id)}
          onTogglePin={(id, pin) =>
            attempt(pin ? "pin the note" : "unpin the note", async () => {
              if (pin) await api.notes.pin(id);
              else await api.notes.unpin(id);
              notify(pin ? "Note pinned" : "Note unpinned");
              await session.refresh();
            })
          }
          onDeleteNote={(id) =>
            attempt("delete the note", async () => {
              if (id === currentId) await session.deleteCurrent();
              else {
                await api.notes.delete(id);
                session.history.remove(id);
                notify("Note deleted");
                await session.refresh();
              }
            })
          }
          onRecover={(id) =>
            attempt("restore the note", async () => {
              await api.notes.recover(id);
              notify("Note restored");
              await session.refresh();
            })
          }
          onPreview={(note) => void startPreview(note)}
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
        token="--motion-fast"
      />
      {confirm ? <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} /> : null}
      <Notices notices={notices} onExited={dismissNotice} />
    </div>
  );
}
