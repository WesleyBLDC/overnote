/** A small inline icon set (no network requests, no icon font). */
import type { ReactElement } from "react";

const paths: Record<string, ReactElement> = {
  plus: <path d="M8 3v10M3 8h10" />,
  minus: <path d="M3 8h10" />,
  command: (
    <path d="M6 6V4.5A1.5 1.5 0 1 0 4.5 6H6Zm0 0h4M6 6v4m4-4V4.5A1.5 1.5 0 1 1 11.5 6H10Zm0 0v4m0 0v1.5a1.5 1.5 0 1 0 1.5-1.5H10Zm0 0H6m0 0v1.5A1.5 1.5 0 1 1 4.5 10H6Z" />
  ),
  browse: <path d="M3 4h10M3 8h10M3 12h6" />,
  format: <path d="M4 12 7.5 3h1L12 12M5.3 9h5.4" />,
  heading: <path d="M4 3v10M12 3v10M4 8h8" />,
  link: <path d="M7 9a3 3 0 0 0 4.2 0l1.6-1.6a3 3 0 0 0-4.2-4.2L7.8 4M9 7a3 3 0 0 0-4.2 0L3.2 8.6a3 3 0 0 0 4.2 4.2l.8-.8" />,
  code: <path d="M6 4 2.5 8 6 12M10 4l3.5 4L10 12" />,
  codeBlock: <path d="M3 3h10v10H3zM6 6.5 4.8 8 6 9.5M10 6.5 11.2 8 10 9.5" />,
  quote: <path d="M4 5h3v3H5v3M9 5h3v3h-2v3" />,
  bullet: <path d="M6 4h7M6 8h7M6 12h7M3 4h.01M3 8h.01M3 12h.01" />,
  ordered: <path d="M7 4h6M7 8h6M7 12h6M3 3.5h1v2M2.8 7.5c.3-.4 1.4-.4 1.4.3 0 .6-1.4 1.2-1.4 1.7h1.4M2.8 11h1.4l-.7.8c.6 0 .8.4.6.8-.2.5-1 .5-1.3.2" />,
  task: <path d="M3 3h4v4H3zM3 9h4v4H3zM9 5h4M9 11h4M3.8 11l1 1 1.6-2" />,
  check: <path d="m3.5 8.5 3 3 6-7" />,
  trash: <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" />,
  pin: <path d="M6 2.5h4l-.5 4 2 2v1H4.5v-1l2-2-.5-4ZM8 9.5V14" />,
  restore: <path d="M3.5 8a4.5 4.5 0 1 0 1.3-3.2L3.5 6M3.5 3v3h3" />,
  copy: <path d="M5.5 5.5h7v7h-7zM3.5 10.5v-7h7" />,
  open: <path d="M9 3h4v4M13 3 7.5 8.5M11 9.5V13H3V5h3.5" />,
  edit: <path d="M3 13h3l7-7-3-3-7 7v3Z" />,
  chevron: <path d="m6 4 4 4-4 4" />,
  chevronDown: <path d="m4 6 4 4 4-4" />,
  up: <path d="m4 10 4-4 4 4" />,
  down: <path d="m4 6 4 4 4-4" />,
  close: <path d="m4 4 8 8M12 4l-8 8" />,
  search: <path d="M7 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10ZM13.5 13.5 10.6 10.6" />,
  sliders: <path d="M3 5h4m3 0h3M3 11h2m3 0h5M8.5 3.5v3M6.5 9.5v3" />,
};

export type IconName = keyof typeof paths;

export function Icon({ name, label }: { name: IconName; label?: string }) {
  return (
    <svg
      className="icon"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? "img" : undefined}
    >
      {paths[name]}
    </svg>
  );
}
