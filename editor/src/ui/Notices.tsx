import type { Notice } from "./hooks";

export function Notices({ notices }: { notices: Notice[] }) {
  return (
    <div className="notices" aria-live="polite" data-testid="notices">
      {notices.map((notice) => (
        <div key={notice.id} className={`notice is-${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"}>
          {notice.message}
        </div>
      ))}
    </div>
  );
}
