import { Icon, type IconName } from "./icons";

interface ToolbarProps {
  title: string;
  /** No text yet: the title is the "Untitled" fallback and is drawn quieter. */
  untitled?: boolean;
  onClose: () => void;
  onActions: () => void;
  onBrowse: () => void;
  onNew: () => void;
}

interface ToolbarButtonProps {
  icon: IconName;
  label: string;
  shortcut: string;
  onClick: () => void;
  anchor?: string;
  testId?: string;
}

const keep = (event: React.MouseEvent) => event.preventDefault();

/** An icon button with a tooltip pill that names it and its shortcut. */
function ToolbarButton({ icon, label, shortcut, onClick, anchor, testId }: ToolbarButtonProps) {
  return (
    <button
      type="button"
      className="icon-button toolbar-button"
      aria-label={label}
      data-anchor={anchor}
      data-testid={testId}
      onMouseDown={keep}
      onClick={onClick}
      tabIndex={-1}
    >
      <Icon name={icon} />
      <span className="tooltip" role="tooltip">
        {label} <kbd>{shortcut}</kbd>
      </span>
    </button>
  );
}

/**
 * Top bar: Close on the left, an empty middle that drags the window, and the icon buttons on the right.
 * The title fades into the middle only once the note's first line has scrolled away (useScrollEdges).
 */
export function Toolbar({ title, untitled, onClose, onActions, onBrowse, onNew }: ToolbarProps) {
  return (
    <header className="toolbar" data-testid="toolbar">
      <div className="toolbar-leading">
        <button
          type="button"
          className="close-button chrome"
          title="Close"
          aria-label="Close"
          data-testid="close"
          onMouseDown={keep}
          onClick={onClose}
          tabIndex={-1}
        >
          <span className="close-dot" data-testid="close-dot">
            <Icon name="close" />
          </span>
        </button>
      </div>
      <h1 className={`toolbar-title${untitled ? " is-untitled" : ""}`} data-testid="title" title={title}>
        {title}
      </h1>
      <div className="toolbar-actions chrome">
        {/* The terminal drawer is not built yet: the button is in place and does nothing for now. */}
        <ToolbarButton icon="terminal" label="Terminal" shortcut="⌃`" testId="terminal" onClick={() => undefined} />
        <ToolbarButton icon="notes" label="Notes" shortcut="⌘P" anchor="browse" onClick={onBrowse} />
        <ToolbarButton icon="actions" label="Actions" shortcut="⌘K" anchor="actions" onClick={onActions} />
        <ToolbarButton icon="newNote" label="New Note" shortcut="⌘N" testId="new-note" onClick={onNew} />
      </div>
    </header>
  );
}
