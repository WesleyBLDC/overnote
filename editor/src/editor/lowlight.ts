/**
 * Syntax highlighting with lowlight's common grammar set.
 * The grammars load lazily after the editor opens, in their own chunk.
 */
import type { Editor } from "@tiptap/core";
import { createLowlight } from "lowlight";

export type NoteLowlight = ReturnType<typeof createLowlight>;

export function createNoteLowlight(): NoteLowlight {
  return createLowlight();
}

let loading: Promise<void> | null = null;

/** Registers the common grammars once, then re-highlights every code block in `editor`. */
export function loadGrammars(lowlight: NoteLowlight, editor: Editor): Promise<void> {
  loading ??= import("./grammars").then(({ common }) => {
    lowlight.register(common);
  });
  return loading.then(() => {
    if (editor.isDestroyed) return;
    const tr = editor.state.tr;
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === "codeBlock") tr.setNodeMarkup(pos, undefined, node.attrs);
      return node.isBlock && node.type.name !== "codeBlock";
    });
    if (tr.docChanged) editor.view.dispatch(tr.setMeta("addToHistory", false).setMeta("bnLoad", true));
  });
}

/** The language picker options, in order; null is "Auto". */
export const CODE_LANGUAGES: ReadonlyArray<{ id: string | null; label: string }> = [
  { id: null, label: "Auto" },
  { id: "bash", label: "Bash" },
  { id: "c", label: "C" },
  { id: "cpp", label: "C++" },
  { id: "csharp", label: "C#" },
  { id: "css", label: "CSS" },
  { id: "diff", label: "Diff" },
  { id: "go", label: "Go" },
  { id: "graphql", label: "GraphQL" },
  { id: "ini", label: "INI" },
  { id: "java", label: "Java" },
  { id: "javascript", label: "JavaScript" },
  { id: "json", label: "JSON" },
  { id: "kotlin", label: "Kotlin" },
  { id: "less", label: "Less" },
  { id: "lua", label: "Lua" },
  { id: "makefile", label: "Makefile" },
  { id: "markdown", label: "Markdown" },
  { id: "objectivec", label: "Objective-C" },
  { id: "perl", label: "Perl" },
  { id: "php", label: "PHP" },
  { id: "python", label: "Python" },
  { id: "r", label: "R" },
  { id: "ruby", label: "Ruby" },
  { id: "rust", label: "Rust" },
  { id: "scss", label: "SCSS" },
  { id: "shell", label: "Shell" },
  { id: "sql", label: "SQL" },
  { id: "swift", label: "Swift" },
  { id: "typescript", label: "TypeScript" },
  { id: "xml", label: "XML" },
  { id: "yaml", label: "YAML" },
];
