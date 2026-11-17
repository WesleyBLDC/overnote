import type { NoticeKind } from "../lib/notice";
import type { Notice } from "./noticeState";
import { Icon, type IconName } from "./icons";

/** The round status icon (SPEC §11): the tone's colour carries the meaning; a plain notice has none. */
const STATUS: Partial<Record<NoticeKind, IconName>> = { success: "check", warning: "alert", error: "close" };

/**
 * Two live regions that always exist, so screen readers notice what is added to them: one polite
 * (role status) for confirmations and one assertive (role alert) for errors. The notices inside
 * are plain elements; a live region nested in another would be announced twice.
 */
export function Notices({
  notices,
  onExited,
  onDismiss,
  onAction,
}: {
  notices: Notice[];
  onExited: (id: number) => void;
  onDismiss: (id: number) => void;
  onAction: (id: number) => void;
}) {
  const render = (notice: Notice) => (
    <div
      key={notice.id}
      className={`notice is-${notice.kind}`}
      data-leaving={notice.leaving ? "true" : undefined}
      onTransitionEnd={(event) => {
        if (notice.leaving && event.target === event.currentTarget) onExited(notice.id);
      }}
    >
      {STATUS[notice.kind] ? (
        <span className="notice-status" aria-hidden="true">
          <Icon name={STATUS[notice.kind]!} />
        </span>
      ) : null}
      <span className="notice-message">{notice.message}</span>
      {notice.action ? (
        <button
          type="button"
          className="notice-action"
          data-testid="notice-action"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onAction(notice.id)}
        >
          {notice.action.label}
          {notice.action.shortcut ? <span className="notice-shortcut">{notice.action.shortcut}</span> : null}
        </button>
      ) : null}
      {notice.kind === "error" ? (
        <button
          type="button"
          className="notice-dismiss"
          aria-label="Dismiss"
          data-testid="notice-dismiss"
          onClick={() => onDismiss(notice.id)}
        >
          <Icon name="close" />
        </button>
      ) : null}
    </div>
  );
  return (
    <div className="notices" data-testid="notices">
      <div className="notice-region" role="status">
        {notices.filter((notice) => notice.kind !== "error").map(render)}
      </div>
      <div className="notice-region" role="alert">
        {notices.filter((notice) => notice.kind === "error").map(render)}
      </div>
    </div>
  );
}
