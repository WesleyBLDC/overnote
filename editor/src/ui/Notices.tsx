import type { Notice } from "./hooks";

export function Notices({ notices, onExited }: { notices: Notice[]; onExited: (id: number) => void }) {
  return (
    <div className="notices" aria-live="polite" data-testid="notices">
      {notices.map((notice) => (
        <div
          key={notice.id}
          className={`notice is-${notice.kind}`}
          role={notice.kind === "error" ? "alert" : "status"}
          data-leaving={notice.leaving ? "true" : undefined}
          onTransitionEnd={(event) => {
            if (notice.leaving && event.target === event.currentTarget) onExited(notice.id);
          }}
        >
          {notice.message}
        </div>
      ))}
    </div>
  );
}
