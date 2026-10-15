/** Mark customizations. */
import { Code } from "@tiptap/extension-code";
import { Link } from "@tiptap/extension-link";
import { normalizeLinkHref, looksLikeUrl } from "../link";

interface AttributeSource {
  getAttribute(name: string): string | null;
}

/** Inline code combines with every other mark. */
export const NoteCode = Code.extend({
  excludes: "",
});

/** Link with only `href` and `title`, never inclusive, rendered with target blank and noopener. */
export const NoteLink = Link.extend({
  inclusive: () => false,
  addAttributes() {
    return {
      href: {
        default: null,
        parseHTML: (element: AttributeSource) => element.getAttribute("href"),
      },
      title: {
        default: null,
        parseHTML: (element: AttributeSource) => element.getAttribute("title"),
      },
    };
  },
  renderHTML({ HTMLAttributes }) {
    return ["a", { ...HTMLAttributes, target: "_blank", rel: "noopener noreferrer nofollow" }, 0];
  },
}).configure({
  openOnClick: false,
  linkOnPaste: false,
  autolink: true,
  defaultProtocol: "https",
  isAllowedUri: (url) => normalizeLinkHref(url) !== null,
  shouldAutoLink: (url) => looksLikeUrl(url),
});
