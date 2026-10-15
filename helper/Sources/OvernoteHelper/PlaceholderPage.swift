/// A tiny stand in editor served when `--editor-dir` has no `index.html`. The window end to end
/// checks run on it on purpose, because it reports its height once and then stays quiet. It
/// implements the bridge protocol: `system.ready`, autosave through `notes.update`, `window.resize`, and Esc.
enum PlaceholderPage {
    static let html = #"""
        <!doctype html>
        <html>
        <head>
        <meta charset="utf-8">
        <title>Overnote</title>
        <style>
          :root { color-scheme: light dark; }
          html, body { margin: 0; background: transparent; font: 14px -apple-system, system-ui, sans-serif; }
          #wrap { padding: 18px 18px 12px; }
          textarea { width: 100%; box-sizing: border-box; min-height: 60px; border: 0; outline: none; resize: none;
                     background: transparent; color: inherit; font: inherit; line-height: 1.5; overflow: hidden; }
          #status { font-size: 11px; opacity: 0.5; margin-top: 6px; }
        </style>
        </head>
        <body>
        <div id="wrap">
          <textarea id="editor" placeholder="Start writing... (placeholder editor: build the real one into assets/editor)"></textarea>
          <div id="status">Placeholder editor</div>
        </div>
        <script>
        (function () {
          const pending = new Map();
          let nextId = 1;
          window.overnoteBridge = {
            resolve(id, result) { const p = pending.get(id); if (p) { pending.delete(id); p.resolve(result); } },
            reject(id, error) { const p = pending.get(id); if (p) { pending.delete(id); p.reject(error); } },
            emit(event, payload) { onEvent(event, payload); }
          };
          function call(method, params) {
            return new Promise((resolve, reject) => {
              const id = nextId++;
              pending.set(id, { resolve, reject });
              window.webkit.messageHandlers.overnote.postMessage({ id, method, params: params || {} });
            });
          }
          const editor = document.getElementById("editor");
          const status = document.getElementById("status");
          let current = null;
          let saveTimer = null;

          function contentFor(text) {
            const lines = text.split("\n");
            const doc = { type: "doc", content: lines.map(line => line
              ? { type: "paragraph", content: [{ type: "text", text: line }] }
              : { type: "paragraph" }) };
            return { rawContent: JSON.stringify(doc), markdown: text, text, title: (lines[0] || "").trim() };
          }
          function resize() {
            editor.style.height = "auto";
            editor.style.height = editor.scrollHeight + "px";
            // Measure the content, not the document: the document is never shorter than the viewport.
            call("window.resize", { contentHeight: Math.ceil(document.getElementById("wrap").getBoundingClientRect().height) });
          }
          function load(note) {
            current = note;
            editor.value = note ? note.text : "";
            status.textContent = note ? "Placeholder editor, note " + note.id : "Placeholder editor";
            resize();
          }
          // Only the first load creates a note when there is none; later reloads just show
          // whatever is current (or nothing), so external deletes never spawn notes.
          async function loadCurrent(noteId, createIfEmpty) {
            const data = await call("notes.windowData", noteId ? { noteId } : {});
            if (data.current) { load(data.current); }
            else if (createIfEmpty) { load(await call("notes.create", contentFor(""))); }
            else { load(null); return; }
            await call("notes.setCurrentNote", { noteId: current.id });
          }
          async function save() {
            if (!current) return;
            const result = await call("notes.update", Object.assign({ id: current.id }, contentFor(editor.value)));
            current = result.note;
          }
          function onEvent(event, payload) {
            if (event === "note.open") loadCurrent(payload.id);
            else if (event === "note.new") { load(payload.note); }
            else if (event === "notes.changed" && current && payload.ids.includes(current.id)) loadCurrent(current.id);
            else if (event === "window.didShow") editor.focus();
          }
          editor.addEventListener("input", () => { resize(); clearTimeout(saveTimer); saveTimer = setTimeout(save, 300); });
          document.addEventListener("keydown", (e) => {
            if (e.key === "Escape") { e.preventDefault(); clearTimeout(saveTimer); save().finally(() => call("window.hide")); }
          });
          call("system.ready").then(r => load(r.windowData.current)).then(() => { if (!current) loadCurrent(null, true); });
        })();
        </script>
        </body>
        </html>
        """#
}
