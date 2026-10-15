import { Icon } from "./icons";

interface ToolbarProps {
  title: string;
  /** No text yet: the title is the "Untitled" fallback and is drawn quieter. */
  untitled?: boolean;
  onClose: () => void;
  onActions: () => void;
  onBrowse: () => void;
  onNew: () => void;
}

/** Top bar: the live title in the middle and three buttons on the right. */
export function Toolbar({ title, untitled, onClose, onActions, onBrowse, onNew }: ToolbarProps) {
  const keep = (event: React.MouseEvent) => event.preventDefault();
  return (
    <header className="toolbar" data-testid="toolbar">
      <div className="toolbar-leading">
        <button type="button" className="close-button chrome" title="Close" aria-label="Close" data-testid="close" onMouseDown={keep} onClick={onClose} tabIndex={-1}>
          <Icon name="close" />
        </button>
      </div>
      <h1 className={`toolbar-title${untitled ? " is-untitled" : ""}`} data-testid="title" title={title}>
        {title}
      </h1>
      <div className="toolbar-actions chrome">
        <button type="button" className="icon-button" title="Actions (⌘K)" aria-label="Actions" onMouseDown={keep} onClick={onActions} tabIndex={-1}>
          <Icon name="command" />
        </button>
        <button type="button" className="icon-button" title="Browse Notes (⌘P)" aria-label="Browse Notes" onMouseDown={keep} onClick={onBrowse} tabIndex={-1}>
          <Icon name="browse" />
        </button>
        <button type="button" className="icon-button" title="Create Note (⌘N)" aria-label="Create Note" data-testid="new-note" onMouseDown={keep} onClick={onNew} tabIndex={-1}>
          <Icon name="plus" />
        </button>
      </div>
    </header>
  );
}
