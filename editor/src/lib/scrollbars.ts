/**
 * Legacy scrollbars (always shown, as macOS draws them with a mouse and no trackpad, or with "Show
 * scroll bars: Always") take layout width and are drawn by AppKit. In the panel they look heavy, and
 * WebKit leaves stale copies of them behind when a scroller animates in or resizes. With them, the
 * stylesheet draws its own thin scrollbars instead (html[data-scrollbars="legacy"], app.css); overlay
 * scrollbars stay the system's.
 */

/** Whether the system draws legacy scrollbars: a scroller then loses width to its scrollbar. */
export function usesLegacyScrollbars(doc: Document): boolean {
  const probe = doc.createElement("div");
  // The probe keeps the system scrollbar: the stylesheet's own scrollbars skip it.
  probe.className = "scrollbar-probe";
  probe.style.cssText =
    "position:absolute;top:-200px;left:0;width:100px;height:100px;overflow:scroll;visibility:hidden";
  doc.body.append(probe);
  const legacy = probe.offsetWidth - probe.clientWidth > 0;
  probe.remove();
  return legacy;
}

/** Marks the document while legacy scrollbars are in use, and follows the system setting. */
export function watchScrollbarStyle(win: Window): void {
  const root = win.document.documentElement;
  const update = () => {
    const value = usesLegacyScrollbars(win.document) ? "legacy" : null;
    if ((root.getAttribute("data-scrollbars") ?? null) === value) return;
    if (value) root.setAttribute("data-scrollbars", value);
    else root.removeAttribute("data-scrollbars");
  };
  update();
  // The setting can change while the panel is open; it is read again whenever the panel comes back.
  // WebKit styles a scrollbar when it creates it, so a change reaches scrollers made after it.
  win.addEventListener("focus", update);
  win.addEventListener("resize", update);
}
