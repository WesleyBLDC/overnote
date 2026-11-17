/**
 * The tooltip pill (SPEC §4): a name and an optional shortcut, shown after a short hover over its control.
 * Place it inside a positioned control with the has-tooltip class; it opens below by default, or above for
 * controls on the bottom row, and lines up with the control's right edge.
 */
export function Tooltip({
  label,
  shortcut,
  placement = "below",
}: {
  label: string;
  shortcut?: string;
  placement?: "below" | "above";
}) {
  return (
    <span className="tooltip" role="tooltip" data-placement={placement}>
      {label}
      {shortcut ? (
        <>
          {" "}
          <kbd>{shortcut}</kbd>
        </>
      ) : null}
    </span>
  );
}
