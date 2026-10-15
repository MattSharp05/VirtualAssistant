// Line icons for windows and the launcher (24 × 24, stroked with currentColor). Feature metadata
// names one of these; unknown names get a dot.
const paths: Record<string, string> = {
  chat: "M4 5h16v11H9l-5 4z",
  sessions: "M12 3 3 8l9 5 9-5zM3 12l9 5 9-5M3 16l9 5 9-5",
  today:
    "M12 4v2M12 18v2M4 12h2M18 12h2M6.3 6.3l1.4 1.4M16.3 16.3l1.4 1.4M6.3 17.7l1.4-1.4M16.3 7.7l1.4-1.4M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z",
  todo: "M4 4h16v16H4zM8 12l3 3 5-6",
  notion: "M6 3h9l3 3v15H6zM9 9h6M9 13h6M9 17h4",
  system: "M3 12h4l2-6 4 12 2-6h6",
  settings: "M4 7h9M17 7h3M15 4.5v5M4 17h3M11 17h9M9 14.5v5",
  calendar: "M4 6h16v14H4zM4 10h16M8 3v4M16 3v4",
  spark: "M12 3l2 7 7 2-7 2-2 7-2-7-7-2 7-2z",
  orb: "M12 5a7 7 0 1 0 0 14 7 7 0 0 0 0-14z",
  refresh: "M20 11a8 8 0 1 0-2 5.3M20 4v7h-7",
  minimize: "M6 12h12",
  close: "M6 6l12 12M18 6 6 18",
  search: "M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM15.5 15.5 20 20",
  layout: "M4 5h16v14H4zM12 5v14M12 12h8",
};

export function Icon({ name, size = 18 }: { name: string; size?: number }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] ? <path d={paths[name]} /> : <circle cx="12" cy="12" r="3" />}
    </svg>
  );
}
