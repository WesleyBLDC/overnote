/** Code block chrome: a language picker and a copy button above the code. */
import type { NodeViewRendererProps } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { NodeView } from "@tiptap/pm/view";
import { CODE_LANGUAGES } from "./lowlight";

export interface CodeBlockViewOptions {
  copy: (text: string) => Promise<void>;
}

export function createCodeBlockView(options: CodeBlockViewOptions) {
  return ({ node: initial, editor, getPos }: NodeViewRendererProps): NodeView => {
    let node: PMNode = initial;
    const dom = document.createElement("div");
    dom.className = "code-block";
    const toolbar = document.createElement("div");
    toolbar.className = "code-block-toolbar";
    toolbar.contentEditable = "false";

    const select = document.createElement("select");
    select.className = "code-block-language";
    select.tabIndex = -1;
    select.setAttribute("aria-label", "Code language");
    for (const language of CODE_LANGUAGES) {
      const option = document.createElement("option");
      option.value = language.id ?? "";
      option.textContent = language.label;
      select.append(option);
    }
    const label = document.createElement("span");
    label.className = "code-block-label";

    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "code-block-copy";
    copy.tabIndex = -1;
    copy.title = "Copy code";
    copy.textContent = "Copy";

    const pre = document.createElement("pre");
    const code = document.createElement("code");
    pre.append(code);
    toolbar.append(select, label, copy);
    dom.append(toolbar, pre);

    const sync = () => {
      const language = (node.attrs.language as string | null) ?? null;
      const known = CODE_LANGUAGES.some((entry) => entry.id === language);
      select.value = known && language ? language : "";
      label.textContent = CODE_LANGUAGES.find((entry) => entry.id === language)?.label ?? "Auto";
      dom.classList.toggle("is-readonly", !editor.isEditable);
      code.className = language ? `language-${language}` : "";
    };
    sync();

    select.addEventListener("mousedown", (event) => event.stopPropagation());
    select.addEventListener("change", () => {
      const pos = typeof getPos === "function" ? getPos() : undefined;
      if (pos === undefined) return;
      editor.view.dispatch(editor.state.tr.setNodeAttribute(pos, "language", select.value || null));
      editor.commands.focus();
    });
    copy.addEventListener("mousedown", (event) => event.preventDefault());
    copy.addEventListener("click", () => {
      void options.copy(node.textContent).then(
        () => {
          copy.classList.add("is-done");
          copy.textContent = "Copied";
          setTimeout(() => {
            copy.classList.remove("is-done");
            copy.textContent = "Copy";
          }, 1000);
        },
        () => undefined,
      );
    });

    return {
      dom,
      contentDOM: code,
      update(updated) {
        if (updated.type !== node.type) return false;
        node = updated;
        sync();
        return true;
      },
      stopEvent: (event) => toolbar.contains(event.target as globalThis.Node),
      ignoreMutation: (mutation) => toolbar.contains(mutation.target),
    };
  };
}
