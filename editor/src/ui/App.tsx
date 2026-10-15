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
  type rpc,
} from "@better-notes/core";
import { EditorContent, useEditor } from "@tiptap/react";
import type { AnyExtension, Editor } from "@tiptap/core";
import { EditorState, TextSelection } from "@tiptap/pm/state";
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
import { useDragRegions, useLatest, useNotices, useResizeReporter, useSettings } from "./hooks";
import { LinkPopover } from "./LinkPopover";
import { Notices } from "./Notices";
import { SlashMenu, type SlashMenuHandle } from "./SlashMenu";
import { Toolbar } from "./Toolbar";

type ExportFormat = "md" | "html" | "txt";

function clampCaret(editor: Editor, caret: number | null): void {
  const { doc } = editor.state;
  const size = doc.content.size;
  const wanted = typeof caret === "number" && Number.isFinite(caret) && caret > 0 ? Math.min(caret, size) : 0;
  const selection = wanted > 0 ? TextSelection.near(doc.resolve(wanted)) : TextSelection.atStart(doc);
  editor.view.dispatch(editor.state.tr.setSelection(selection).setMeta("addToHistory", false));
}

/** Replaces the document without an undo step and starts a fresh undo history. */
function loadIntoEditor(editor: Editor, doc: JSONContent, caret: number | null): void {
  editor.commands.setContent(doc, { emitUpdate: false });
  const { state } = editor;
  editor.view.updateState(EditorState.create({ doc: state.doc, plugins: state.plugins }));
  clampCaret(editor, caret);
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
  const { notices, notify } = useNotices();
  const { settings, setSettings, update: updateSettings } = useSettings(api);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [linkTarget, setLinkTarget] = useState<LinkTarget | null>(null);
  const [panel, setPanel] = useState<PanelViewName | null>(null);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [find, setFind] = useState<{ term: string } | null>(null);
  const findRef = useRef<FindBarHandle>(null);
  const slashRef = useRef<SlashMenuHandle>(null);
  const emojiRef = useRef<EmojiPickerHandle>(null);
  const [emojiDismissed, setEmojiDismissed] = useState<number | null>(null);
  const [slashDismissed, setSlashDismissed] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  const [formatMenuOpen, setFormatMenuOpen] = useState(false);
  const [preview, setPreview] = useState<rpc.DeletedItem | null>(null);
  const sessionRef = useRef<NoteSession | null>(null);
  const editorRef = useRef<Editor | null>(null);
  const plainPasteFlag = useMemo(() => ({ next: false }), []);

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

  const openLinkRef = useRef<() => void>(() => undefined);
  const lowlight = useMemo(() => createNoteLowlight(), []);
  const extensions = useMemo<AnyExtension[]>(
    () =>
      createEditorExtensions({
        lowlight,
        onLinkShortcut: () => openLinkRef.current(),
        onOpenLink: (href) => openUrl(href),
        onLinkClick: (from, to) => {
          const editor = editorRef.current;
          if (!editor) return;
          const target = chooseLinkTarget(editor.state.apply(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from, to))));
          if (target) setLinkTarget({ ...target, from, to });
        },
        takePlainPaste: () => {
          const plain = plainPasteFlag.next;
          plainPasteFlag.next = false;
          return plain;
        },
        copy: (text) => copyText(text),
      }),
    [copyText, openUrl, plainPasteFlag, editorRef, lowlight],
  );

  const editor = useEditor({
    extensions,
    content: { type: "doc", content: [{ type: "paragraph" }] },
    immediatelyRender: true,
    shouldRerenderOnTransaction: false,
    editorProps: {
      scrollThreshold: { top: 16, bottom: 100, left: 0, right: 0 },
      scrollMargin: { top: 16, bottom: 100, left: 0, right: 0 },
      attributes: { class: "note-editor", "data-testid": "editor", spellcheck: "true" },
      handleKeyDown: (_view, event) => emojiRef.current?.onKeyDown(event) || slashRef.current?.onKeyDown(event) || false,
    },
    onUpdate: ({ transaction }) => {
      if (transaction.docChanged && !transaction.getMeta("bnLoad")) sessionRef.current?.contentChanged();
    },
    onSelectionUpdate: () => sessionRef.current?.selectionChanged(),
    onTransaction: () => setTick((t) => t + 1),
    onBlur: () => void sessionRef.current?.flush(),
  });
  editorRef.current = editor;
  if (import.meta.env.DEV) (window as unknown as { __bnEditor?: Editor | null }).__bnEditor = editor;

  const session = useMemo(() => {
    const port: EditorPort = {
      getDoc: () => editorRef.current?.getJSON() ?? { type: "doc", content: [{ type: "paragraph" }] },
      getCaret: () => editorRef.current?.state.selection.from ?? 0,
      getText: () => (editorRef.current ? docToPlainText(editorRef.current.getJSON()) : ""),
      isComposing: () => editorRef.current?.view.composing ?? false,
      load: (doc, caret) => {
        const current = editorRef.current;
        if (current) loadIntoEditor(current, doc, caret);
      },
    };
    return new NoteSession({ api, editor: port, notice: (message, kind) => notify(message, kind) });
  }, [api, notify, editorRef]);
  sessionRef.current = session;
  const state = useSyncExternalStore(session.subscribe, session.getState);

  // ---- read-only preview of a deleted note (spec/keymap.md 2.5) ----

  const startPreview = useCallback(
    async (note: rpc.DeletedItem) => {
      const current = editorRef.current;
      if (!current || !(await session.pause())) return;
      setFind(null);
      setLinkTarget(null);
      current.setEditable(false, false);
      loadIntoEditor(current, loadDoc(note.rawContent || null, note.preview), 0);
      setPreview(note);
    },
    [session],
  );

  const exitPreview = useCallback(() => {
    editorRef.current?.setEditable(true, false);
    session.resume();
    setPreview(null);
    editorRef.current?.view.focus();
  }, [session]);

  const restorePreview = useCallback(
    async (note: rpc.DeletedItem) => {
      try {
        await api.notes.recover(note.id);
      } catch {
        notify("Could not restore the note", "error");
        return;
      }
      editorRef.current?.setEditable(true, false);
      await session.open(note.id);
      notify("Note restored");
    },
    [api, session, notify],
  );

  // Any switch, create, or delete reloads a note, which ends the preview.
  useEffect(() => {
    if (preview && !session.isPaused) {
      editorRef.current?.setEditable(true, false);
      setPreview(null);
    }
  });

  // ---- boot and native events ----

  useEffect(() => {
    let cancelled = false;
    void api.system
      .ready()
      .then(async (ready) => {
        if (cancelled) return;
        setSettings(ready.settings);
        await session.applyBoot(ready.windowData);
        editorRef.current?.commands.focus();
      })
      .catch((error: unknown) => notify(`Could not load notes: ${String(error)}`, "error"));
    return () => {
      cancelled = true;
    };
  }, [api, session, setSettings, notify, editorRef]);

  useEffect(() => {
    const offs = [
      api.on("note.open", ({ id }) => void session.handleNoteOpen(id)),
      api.on("note.new", ({ note }) => void session.handleNoteNew(note)),
      api.on("notes.changed", ({ ids }) => void session.handleNotesChanged(ids)),
      api.on("window.didShow", () => {
        const current = editorRef.current;
        if (current && !current.isDestroyed) current.commands.focus(undefined, { scrollIntoView: true });
      }),
      api.on("window.didHide", () => void session.flush()),
      api.on("window.didResignKey", () => void session.flush()),
    ];
    const onHide = () => {
      if (document.visibilityState === "hidden") void session.flush();
    };
    const onUnload = () => void session.flush();
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
  }, [api, session, editorRef]);

  useEffect(() => {
    if (editor) void loadGrammars(lowlight, editor);
  }, [editor, lowlight]);

  // ---- zoom and resize ----

  useEffect(() => {
    document.documentElement.style.setProperty("--zoom", String(settings.zoom));
  }, [settings.zoom]);

  // ---- derived UI state ----

  const doc = editor?.getJSON();
  const text = doc ? docToPlainText(doc) : "";
  const liveTitle = doc ? deriveTitle(doc) : "";
  const counts = useMemo(() => ({ characters: countCharacters(text), words: countWords(text) }), [text]);
  const title = displayTitle({ title: liveTitle, text });
  const blank = text.trim() === "";
  const slash = editor && editor.isFocused ? slashQueryAt(editor.state) : null;
  const slashItems = slash && slash.from !== slashDismissed ? filterSlashItems(slash.query) : [];
  const emojiQuery = editor && editor.isFocused ? emojiQueryAt(editor.state) : null;
  const showEmoji = emojiQuery !== null && emojiQuery.from !== emojiDismissed;
  const overlayRem = panel || confirm ? 34 : slashItems.length || showEmoji || linkTarget || formatMenuOpen ? 16 : null;
  useResizeReporter(wrapperRef, api, { autoSize: settings.windowAutoSize, overlayRem });
  useDragRegions(wrapperRef, api, settings.zoom);

  // ---- actions ----

  const openLink = useCallback(() => {
    const current = editorRef.current;
    if (!current) return;
    const target = chooseLinkTarget(current.state);
    if (!target) {
      notify("Select text to add a link. Place the cursor inside a word or select text first.", "error");
      return;
    }
    setLinkTarget(target);
  }, [notify, editorRef]);
  openLinkRef.current = openLink;

  const setZoom = useCallback(
    (zoom: number, message: string) => {
      updateSettings({ zoom });
      notify(message);
    },
    [updateSettings, notify],
  );

  const exportAs = useCallback(
    async (format: ExportFormat) => {
      const current = editorRef.current;
      if (!current) return;
      const json = current.getJSON();
      const content = format === "md" ? docToMarkdown(json) : format === "html" ? docToHTML(json) : docToPlainText(json);
      try {
        const result = await api.file.saveAs({ suggestedName: exportFileName(docToPlainText(json), format), content });
        if (result.saved) notify(`Exported as ${format === "md" ? "Markdown" : format === "html" ? "HTML" : "Plain Text"}`);
      } catch {
        notify("Could not export the note", "error");
      }
    },
    [api, notify, editorRef],
  );

  const copyAs = useCallback(
    async (format: ExportFormat) => {
      const current = editorRef.current;
      if (!current) return;
      const json = sliceJSON(current) ?? current.getJSON();
      const content = format === "md" ? docToMarkdown(json) : format === "html" ? docToHTML(json) : docToPlainText(json);
      await copyText(content).then(
        () => notify(`Copied as ${format === "md" ? "Markdown" : format === "html" ? "HTML" : "Plain Text"}`),
        () => undefined,
      );
    },
    [copyText, notify, editorRef],
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
    void session.flush();
    if (settings.escapeLosesFocus) void api.window.resignFocus().catch(() => undefined);
    else void api.window.hide().catch(() => undefined);
  }, [api, session, settings.escapeLosesFocus]);

  const pinned = state.current?.pinned !== null && state.current?.pinned !== undefined;

  const moveItem = useCallback(
    (direction: "up" | "down") => {
      const current = editorRef.current;
      if (!current) return;
      moveListItem(direction)(current.state, current.view.dispatch, current.view);
      current.commands.focus();
    },
    [editorRef],
  );

  const format = useCallback((id: FormatId) => {
    const current = editorRef.current;
    if (current) runFormat(current, id, openLink);
  }, [openLink, editorRef]);

  const lists = useMemo((): Record<"root" | "format" | "heading" | "copyAs" | "export", PanelAction[]> => {
    const hasSelection = editor ? !editor.state.selection.empty : false;
    return {
      root: [
        { id: "new", title: "New Note", shortcut: "⌘N", section: "notes", enabled: !blank, run: () => void session.newNote() },
        ...(preview
          ? []
          : [
              { id: "duplicate", title: "Duplicate Note", shortcut: "⌘D", section: "notes", enabled: !blank, run: () => void session.duplicate() },
              { id: "pin", title: pinned ? "Unpin Note" : "Pin Note", shortcut: "⇧⌘P", section: "notes", run: () => void session.togglePin() },
            ]),
        { id: "browse", title: "Browse Notes", shortcut: "⌘P", section: "notes", push: "browse" },
        { id: "back", title: "Go Back", shortcut: "⌘[", section: "notes", enabled: state.canGoBack, run: () => void session.back() },
        { id: "forward", title: "Go Forward", shortcut: "⌘]", section: "notes", enabled: state.canGoForward, run: () => void session.forward() },
        { id: "find", title: "Find in Note", shortcut: "⌘F", section: "copy", run: () => setFind({ term: "" }) },
        { id: "copyAs", title: hasSelection ? "Copy Selection As…" : "Copy Note As…", shortcut: "⇧⌘C", section: "copy", push: "copyAs" },
        {
          id: "deeplink",
          title: "Copy Deeplink",
          shortcut: "⇧⌘D",
          section: "copy",
          run: () => state.current && void copyText(noteDeeplink(state.current.id)).then(() => notify("Copied deeplink"), () => undefined),
        },
        { id: "export", title: "Export…", shortcut: "⇧⌘E", section: "copy", push: "export" },
        { id: "moveUp", title: "Move List Item Up", shortcut: "⌃⌘↑", section: "edit", enabled: editor?.isActive("list") ?? false, run: () => moveItem("up") },
        { id: "moveDown", title: "Move List Item Down", shortcut: "⌃⌘↓", section: "edit", enabled: editor?.isActive("list") ?? false, run: () => moveItem("down") },
        { id: "format", title: "Format…", shortcut: "⇧⌘,", section: "edit", push: "format" },
        {
          id: "autosize",
          title: settings.windowAutoSize ? "Disable Window Auto-Sizing" : "Enable Window Auto-Sizing",
          shortcut: "⇧⌘/",
          section: "window",
          run: () => updateSettings({ windowAutoSize: !settings.windowAutoSize }),
        },
        { id: "formatBar", title: "Toggle Format Bar", shortcut: "⌥⌘,", section: "window", run: () => updateSettings({ showFormatBar: !settings.showFormatBar }) },
        { id: "actualSize", title: "Actual Size", shortcut: "⌘0", section: "zoom", enabled: settings.zoom !== 1, run: () => setZoom(1, "Zoom reset") },
        { id: "zoomIn", title: "Zoom In", shortcut: "⌘=", section: "zoom", enabled: settings.zoom < 2, run: () => setZoom(stepZoom(settings.zoom, 1), `Zoom ${zoomLabel(stepZoom(settings.zoom, 1))}`) },
        { id: "zoomOut", title: "Zoom Out", shortcut: "⌘-", section: "zoom", enabled: settings.zoom > 0.75, run: () => setZoom(stepZoom(settings.zoom, -1), `Zoom ${zoomLabel(stepZoom(settings.zoom, -1))}`) },
        { id: "deleted", title: "Show Recently Deleted Notes", section: "danger", push: "deleted" },
        { id: "delete", title: "Delete Note", shortcut: "⌃X", section: "danger", destructive: true, run: () => void session.deleteCurrent() },
        { id: "deleteAll", title: "Delete All Notes", shortcut: "⌃⇧X", section: "danger", destructive: true, run: deleteAll },
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
        { id: "task", title: "Task List", shortcut: "⇧⌘9", section: "List", keywords: ["todo", "check"], run: () => format("task") },
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
  }, [editor, blank, pinned, state, settings, session, copyText, notify, updateSettings, setZoom, deleteAll, format, openLink, copyAs, exportAs, moveItem, preview, tick]);

  // ---- window level shortcuts ----

  const handlers = useLatest({ lists, session, state, settings, panel, find, linkTarget, confirm, slashItems, showEmoji, hide, deleteAll, setZoom, openLink, preview, exitPreview });
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const h = handlers.current;
      if (h.confirm) return;
      if (matches(event, { code: "KeyV", meta: true, shift: true })) {
        // ⇧⌘V: the paste that follows is inserted as plain text.
        plainPasteFlag.next = true;
        setTimeout(() => {
          plainPasteFlag.next = false;
        }, 1000);
        return;
      }
      const run = (fn: () => void) => {
        event.preventDefault();
        event.stopPropagation();
        fn();
      };
      if (matches(event, { code: "KeyK", meta: true })) return run(() => setPanel(h.panel ? null : "root"));
      if (matches(event, { code: "KeyP", meta: true })) return run(() => setPanel(h.panel === "browse" ? null : "browse"));
      if (matches(event, { code: "Comma", meta: true, shift: true })) return run(() => setPanel("format"));
      if (matches(event, { code: "KeyC", meta: true, shift: true })) return run(() => setPanel("copyAs"));
      if (matches(event, { code: "KeyE", meta: true, shift: true })) return run(() => setPanel("export"));
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
      if (matches(event, { code: "KeyP", meta: true, shift: true })) return run(() => !h.preview && void h.session.togglePin());
      if (matches(event, { code: "KeyD", meta: true })) return run(() => !h.preview && void h.session.duplicate());
      if (matches(event, { code: "KeyD", meta: true, shift: true })) {
        return run(() => h.lists.root.find((a) => a.id === "deeplink")?.run?.());
      }
      if (matches(event, { code: "BracketLeft", meta: true }) || matches(event, { code: "ArrowDown", meta: true, alt: true })) {
        if (h.find && event.code === "ArrowDown") return;
        return run(() => void h.session.back());
      }
      if (matches(event, { code: "BracketRight", meta: true }) || matches(event, { code: "ArrowUp", meta: true, alt: true })) {
        return run(() => void h.session.forward());
      }
      if (matches(event, { code: "KeyF", meta: true })) {
        return run(() => {
          const current = editorRef.current;
          const selected = current ? current.state.doc.textBetween(current.state.selection.from, current.state.selection.to, " ") : "";
          if (!h.find) setFind({ term: selected });
          else if (!findRef.current?.focusOrClose(selected)) {
            setFind(null);
            current?.commands.focus();
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
        if (document.activeElement?.closest(".note-editor") || document.activeElement === document.body) return run(h.hide);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [handlers, updateSettings, editorRef, plainPasteFlag]);

  // Notes switching closes the find bar and popups.
  const currentId = state.current?.id ?? null;
  useEffect(() => {
    setFind(null);
    setLinkTarget(null);
  }, [currentId]);

  const runSlash = (item: SlashItem) => {
    if (!editor || !slash) return;
    editor.chain().focus().deleteRange({ from: slash.from, to: slash.to }).run();
    runFormat(editor, item.id as FormatId, openLink);
  };

  const closePanel = () => {
    setPanel(null);
    // view.focus is synchronous; Tiptap's focus command waits a frame and could steal focus from a panel opened right after.
    if (!find) editorRef.current?.view.focus();
  };

  return (
    <div className="app" ref={wrapperRef} data-testid="app" data-ready={state.ready ? "true" : "false"} data-note-id={currentId ?? ""}>
      <Toolbar title={title} onClose={() => {
        void session.flush();
        void api.window.hide().catch(() => undefined);
      }} onActions={() => setPanel(panel ? null : "root")} onBrowse={() => setPanel("browse")} onNew={() => void session.newNote()} />
      {find && editor ? <FindBar ref={findRef} editor={editor} initialTerm={find.term} onClose={() => setFind(null)} /> : null}
      {preview ? (
        <div className="preview-banner" data-testid="preview-banner" role="status">
          <span>This note is in Recently Deleted.</span>
          <button type="button" className="text-button is-primary" onClick={() => void restorePreview(preview)}>
            Restore
          </button>
        </div>
      ) : null}
      <main className="content" onMouseDown={(event) => {
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
          editor?.commands.focus("end");
        }
      }}>
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
        onMenuChange={setFormatMenuOpen}
      />
      {editor && slash && slashItems.length ? (
        <SlashMenu
          ref={slashRef}
          editor={editor}
          items={slashItems}
          from={slash.from}
          container={wrapperRef.current}
          onRun={runSlash}
          onDismiss={() => setSlashDismissed(slash.from)}
        />
      ) : null}
      {editor && emojiQuery && showEmoji ? (
        <EmojiPicker
          ref={emojiRef}
          editor={editor}
          from={emojiQuery.from}
          query={emojiQuery.query}
          container={wrapperRef.current}
          onPick={(emoji) => {
            editor.chain().focus().insertContentAt({ from: emojiQuery.from, to: emojiQuery.to }, emoji).run();
            recordEmojiUse(emoji);
          }}
          onDismiss={() => setEmojiDismissed(emojiQuery.from)}
        />
      ) : null}
      {editor && linkTarget ? (
        <LinkPopover
          editor={editor}
          target={linkTarget}
          container={wrapperRef.current}
          onClose={() => setLinkTarget(null)}
          notify={notify}
          openUrl={openUrl}
          copy={(value) => copyText(value)}
        />
      ) : null}
      {panel ? (
        <CommandPanel
          initial={panel}
          lists={lists}
          api={api}
          currentId={currentId}
          onClose={closePanel}
          onOpenNote={(id: NoteId) => void session.open(id)}
          onTogglePin={async (id, pin) => {
            if (pin) await api.notes.pin(id);
            else await api.notes.unpin(id);
            notify(pin ? "Note pinned" : "Note unpinned");
            await session.refresh();
          }}
          onDeleteNote={async (id) => {
            if (id === currentId) await session.deleteCurrent();
            else {
              await api.notes.delete(id);
              session.history.remove(id);
              notify("Note deleted");
              await session.refresh();
            }
          }}
          onRecover={async (id) => {
            await api.notes.recover(id);
            notify("Note restored");
            await session.refresh();
          }}
          onPreview={(note) => void startPreview(note)}
          onPermanentlyDelete={(id) =>
            setConfirm({
              title: "Permanently Delete Note?",
              message: "This note will be deleted forever. This cannot be undone.",
              confirm: "Delete",
              destructive: true,
              onConfirm: () => void api.notes.permanentlyDelete(id).then(() => notify("Note permanently deleted")),
            })
          }
        />
      ) : null}
      {confirm ? <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} /> : null}
      <Notices notices={notices} />
    </div>
  );
}
