/**
 * Search's All actions layout (board 07, SPEC §7): the design's short list on the left, with submenus whose
 * actions fill the right pane. It is built from the app's flat action lists by id, so every command keeps one
 * definition; actions outside the layout stay reachable by typing their name.
 */
import type { PanelAction } from "../ui/CommandPanel";
import type { IconName } from "../ui/icons";

/** One left-hand row: an action, or a submenu of actions. */
export type MenuEntry =
  | { kind: "action"; action: PanelAction; divider?: boolean }
  | { kind: "submenu"; id: string; title: string; icon: IconName; children: PanelAction[]; divider?: boolean };

type Lists = { root: PanelAction[]; copyAs: PanelAction[]; export: PanelAction[] };

const SUBMENUS: { id: string; title: string; icon: IconName; ids: string[] }[] = [
  {
    id: "share",
    title: "Share",
    icon: "link",
    ids: ["deeplink", "quicklink", "copy-md", "copy-html", "copy-txt", "export-md", "export-html", "export-txt"],
  },
  { id: "go", title: "Go", icon: "back", ids: ["back", "forward"] },
  {
    id: "window",
    title: "Window",
    icon: "fillScreen",
    ids: ["fillLeft", "fillRight", "fillScreen", "centre", "autosize"],
  },
  { id: "zoom", title: "Zoom", icon: "expand", ids: ["zoomIn", "zoomOut", "actualSize"] },
];

/**
 * Share's copy and export rows, named for a flat list: "Copy As Markdown", or "Copy Selection As Markdown" while
 * text is selected (the verb follows the root Copy As action's own title).
 */
function shareActions(lists: Lists): PanelAction[] {
  const named = (list: PanelAction[], verb: string, icon: IconName) =>
    list.map((a) => ({ ...a, title: `${verb} ${a.title}`, icon }));
  const copyVerb = lists.root.find((a) => a.id === "copyAs")?.title.replace(/…$/, "") ?? "Copy As";
  return [...named(lists.copyAs, copyVerb, "copy"), ...named(lists.export, "Export As", "open")];
}

/** Every runnable action, for typed queries: the root list plus Share's copy and export rows. */
export function leafActions(lists: Lists): PanelAction[] {
  return [
    ...lists.root.filter((a) => !a.push || a.push === "settings" || a.push === "deleted"),
    ...shareActions(lists),
  ];
}

export function allActionsMenu(lists: Lists): MenuEntry[] {
  const byId = new Map(leafActions(lists).map((a) => [a.id, a]));
  const pick = (ids: string[]) => ids.map((id) => byId.get(id)).filter((a): a is PanelAction => a !== undefined);
  const action = (id: string, divider = false): MenuEntry[] => {
    const found = byId.get(id);
    return found ? [{ kind: "action", action: found, divider }] : [];
  };
  return [
    ...action("duplicate"),
    ...action("find"),
    ...SUBMENUS.map((s): MenuEntry => ({
      kind: "submenu",
      id: s.id,
      title: s.title,
      icon: s.icon,
      children: pick(s.ids),
    })),
    ...action("deleted"),
    ...action("delete", true),
  ];
}
