/** Small line icons drawn for this app (no icon font: the app works offline). */
const paths: Record<string, string> = {
  court: "M3 5h18v14H3z M12 5v14 M3 9.5h4 M3 14.5h4 M17 9.5h4 M17 14.5h4",
  cube: "M12 3l8 4.5v9L12 21l-8-4.5v-9z M12 12l8-4.5 M12 12v9 M12 12L4 7.5",
  video: "M3 6h12v12H3z M15 10l6-3v10l-6-3z",
  players: "M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M16 11a3 3 0 1 0 0-6 M2 20c0-3.3 2.7-6 6-6s6 2.7 6 6 M15 14c3.3 0 6 2.7 6 6",
  season: "M4 20V10 M10 20V4 M16 20v-7 M22 20H2",
  settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
  back: "M15 5l-7 7 7 7",
  play: "M7 5l12 7-12 7z",
  pause: "M7 5h4v14H7z M13 5h4v14h-4z",
  plus: "M12 5v14 M5 12h14",
  trash: "M4 7h16 M9 7V4h6v3 M6 7l1 13h10l1-13",
  eye: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  undo: "M9 14L4 9l5-5 M4 9h10a6 6 0 0 1 0 12h-3",
  redo: "M15 14l5-5-5-5 M20 9H10a6 6 0 0 0 0 12h3",
  move: "M9 11V5a1.5 1.5 0 0 1 3 0v6 M12 10V4a1.5 1.5 0 0 1 3 0v6 M15 10V6a1.5 1.5 0 0 1 3 0v8a7 7 0 0 1-7 7h-1a7 7 0 0 1-5.6-2.8L3 14.5a1.5 1.5 0 0 1 2.4-1.8L9 15",
  pen: "M4 20l4-1 11-11-3-3L5 16z M14 7l3 3",
  zone: "M4 4h16v16H4z",
  download: "M12 4v12 M7 11l5 5 5-5 M4 20h16",
  upload: "M12 20V8 M7 13l5-5 5 5 M4 4h16",
  check: "M5 12l5 5 9-10",
  share: "M12 3v12 M8 7l4-4 4 4 M5 12v8h14v-8",
  tortoise: "M4 15c0-4 3.6-7 8-7s8 3 8 7z M2 15h20 M7 15v3 M17 15v3 M20 12l2-1",
  close: "M6 6l12 12 M18 6L6 18",
  timeout: "M12 7v5l3 2 M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z",
  swap: "M7 7h13l-4-4 M17 17H4l4 4",
  sub: "M8 20V5 M4 9l4-4 4 4 M16 4v15 M12 15l4 4 4-4",
  backspace: "M9 5h11v14H9l-6-7z M12 9l6 6 M18 9l-6 6",
  stack: "M12 3l9 5-9 5-9-5z M3 13l9 5 9-5 M3 17.5l9 5 9-5",
  eraser: "M8 20h12 M5.5 14.5l8-8a2 2 0 0 1 2.8 0l2.2 2.2a2 2 0 0 1 0 2.8L11 19H8z M9 11l5 5",
  chevronLeft: "M15 5l-7 7 7 7",
  chevronRight: "M9 5l7 7-7 7",
  target: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M12 2v3 M12 19v3 M2 12h3 M19 12h3",
  magnet: "M6 3v8a6 6 0 0 0 12 0V3 M6 7h4 M14 7h4",
  film: "M4 4h16v16H4z M8 4v16 M16 4v16 M4 8h4 M4 12h4 M4 16h4 M16 8h4 M16 12h4 M16 16h4",
  shirt: "M8 3l-5 3 2 5 3-1v11h8V10l3 1 2-5-5-3c-.5 1.7-2 3-4 3S8.5 4.7 8 3z",
  calendar: "M4 6h16v14H4z M4 10h16 M8 3v5 M16 3v5",
  palette: "M12 3a9 9 0 1 0 0 18c1.4 0 2-1 2-2 0-1.5-1.5-2-1.5-3.5S13.6 13 15 13h2a4 4 0 0 0 4-4c0-3.3-4-6-9-6z M7.5 11.5h.01 M9.5 7.5h.01 M14.5 7.5h.01",
  info: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 11v6 M12 7.5h.01",
  whistle: "M3 11a5 5 0 0 0 10 0 5 5 0 0 0-1.6-3.7L20 4v4l-6 2.5 M8 11h.01",
  trophy: "M7 4h10v5a5 5 0 0 1-10 0z M7 6H4a3 3 0 0 0 3 4 M17 6h3a3 3 0 0 1-3 4 M12 14v4 M8 21h8 M9 18h6",
};

export function Icon({ name, size = 20, className = "icon" }: { name: keyof typeof paths | string; size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={paths[name] ?? ""} />
    </svg>
  );
}
