// Stylelint rule overnote/editor-scope: note content styles stay in editor.css, scoped to the editor.
// - In editor/src/styles/editor.css, every selector includes .note-editor (the editor element's class,
//   the scoping Tiptap's styling guide recommends), so note styles never reach the panel chrome.
// - In every other stylesheet, no selector reaches into the editor (.note-editor, ProseMirror classes,
//   or prosemirror-flat-list markup), so chrome styles never reach note content.
import stylelint from "stylelint";

const ruleName = "overnote/editor-scope";
const messages = stylelint.utils.ruleMessages(ruleName, {
  unscoped: (selector) => `"${selector}" in editor.css must be scoped to .note-editor`,
  reaches: (selector) => `"${selector}" reaches into the editor; note content styles belong in editor.css`,
});
const EDITOR_INTERNALS = /\.note-editor|\.ProseMirror|\.prosemirror-flat-list|\.list-(?:content|marker)\b/;

/** Splits a selector list on top level commas, leaving those inside :is() and the like alone. */
function selectors(list) {
  const out = [];
  let depth = 0;
  let current = "";
  for (const char of list) {
    if (char === "(") depth++;
    if (char === ")") depth--;
    if (char === "," && depth === 0) {
      out.push(current.trim());
      current = "";
    } else current += char;
  }
  out.push(current.trim());
  return out;
}

/** @param {{ allow?: string[] }} options selectors editor.css may leave unscoped, each with a reason in the stylesheet */
const rule =
  (enabled, options = {}) =>
  (root, result) => {
    if (!enabled) return;
    const file = root.source?.input.file ?? "";
    const isEditorSheet = file.endsWith("/editor/src/styles/editor.css");
    const allow = new Set(options.allow ?? []);
    root.walkRules((node) => {
      if (node.parent?.type === "atrule" && /keyframes$/.test(node.parent.name)) return;
      for (const selector of selectors(node.selector)) {
        if (isEditorSheet && !selector.includes(".note-editor") && !allow.has(selector)) {
          stylelint.utils.report({ result, ruleName, node, message: messages.unscoped(selector) });
        } else if (!isEditorSheet && EDITOR_INTERNALS.test(selector)) {
          stylelint.utils.report({ result, ruleName, node, message: messages.reaches(selector) });
        }
      }
    });
  };

rule.ruleName = ruleName;
rule.messages = messages;
export default stylelint.createPlugin(ruleName, rule);
