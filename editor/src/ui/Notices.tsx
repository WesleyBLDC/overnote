import type { Notice } from "./hooks";

/**
 * Two live regions that always exist, so screen readers notice what is added to them: one polite
 * (role status) for confirmations and one assertive (role alert) for errors. The notices inside
 * are plain elements; a live region nested in another would be announced twice.
 */
export function Notices({ notices, onExited }: { notices: Notice[]; onExited: (id: number) => void }) {
  const render = (notice: Notice) => (
    <div
      key={notice.id}
      className={`notice is-${notice.kind}`}
      data-leaving={notice.leaving ? "true" : undefined}
      onTransitionEnd={(event) => {
        if (notice.leaving && event.target === event.currentTarget) onExited(notice.id);
      }}
    >
      {notice.message}
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
