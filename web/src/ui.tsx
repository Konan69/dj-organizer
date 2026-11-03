/**
 * Shared primitives. Every view builds from these so a key badge, a play
 * button or a menu looks and behaves the same on every screen.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { keyColor, keyLabel, parseKey } from "./keys";

/* ------------------------------------------------------------------ icons */

const PATHS = {
  play: <path d="M7 4.5v15l12-7.5z" fill="currentColor" stroke="none" />,
  pause: <><rect x="6" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none" /><rect x="14" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  x: <path d="M6 6l12 12M18 6 6 18" />,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.2-4.2" /></>,
  more: <><circle cx="5.5" cy="12" r="1.4" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" /><circle cx="18.5" cy="12" r="1.4" fill="currentColor" stroke="none" /></>,
  chevronDown: <path d="m6 9 6 6 6-6" />,
  chevronRight: <path d="m9 6 6 6-6 6" />,
  chevronLeft: <path d="m15 6-6 6 6 6" />,
  library: <><path d="M4 4v16M8.5 4v16" /><path d="m13 4.5 5.5 15" /></>,
  playlist: <><path d="M4 6h11M4 11h11M4 16h7" /><path d="M18 13v7" /><circle cx="16.5" cy="20" r="1.5" /></>,
  studio: <path d="M3 12h2M6.5 8v8M10 5v14M13.5 9v6M17 6.5v11M20.5 10.5v3" />,
  learn: <><rect x="3" y="5" width="18" height="13" rx="2.5" /><path d="m10.5 9 4 2.5-4 2.5z" fill="currentColor" /></>,
  list: <path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" />,
  rows: <><rect x="3.5" y="4.5" width="17" height="6" rx="1.5" /><rect x="3.5" y="13.5" width="17" height="6" rx="1.5" /></>,
  grid: <><rect x="4" y="4" width="7" height="7" rx="1.5" /><rect x="13" y="4" width="7" height="7" rx="1.5" /><rect x="4" y="13" width="7" height="7" rx="1.5" /><rect x="13" y="13" width="7" height="7" rx="1.5" /></>,
  star: <path d="m12 4 2.4 5 5.3.6-4 3.6 1.1 5.3L12 15.8l-4.8 2.7 1.1-5.3-4-3.6 5.3-.6z" />,
  starFill: <path d="m12 4 2.4 5 5.3.6-4 3.6 1.1 5.3L12 15.8l-4.8 2.7 1.1-5.3-4-3.6 5.3-.6z" fill="currentColor" />,
  trash: <><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12" /></>,
  undo: <><path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" /></>,
  redo: <><path d="m15 14 5-5-5-5" /><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" /></>,
  drag: <><circle cx="9" cy="6" r="1.3" fill="currentColor" stroke="none" /><circle cx="15" cy="6" r="1.3" fill="currentColor" stroke="none" /><circle cx="9" cy="12" r="1.3" fill="currentColor" stroke="none" /><circle cx="15" cy="12" r="1.3" fill="currentColor" stroke="none" /><circle cx="9" cy="18" r="1.3" fill="currentColor" stroke="none" /><circle cx="15" cy="18" r="1.3" fill="currentColor" stroke="none" /></>,
  sparkle: <path d="M12 3.5 13.8 9l5.7 1.8-5.7 1.8L12 18.5l-1.8-5.9L4.5 10.8 10.2 9z" />,
  transition: <><path d="M4 7h5l6 10h5" /><path d="M4 17h5l6-10h5" /></>,
  export: <><path d="M12 15V4M7.5 8.5 12 4l4.5 4.5" /><path d="M5 14v4.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V14" /></>,
  sync: <><path d="M19.5 12a7.5 7.5 0 0 1-13.2 4.9M4.5 12a7.5 7.5 0 0 1 13.2-4.9" /><path d="M18 3.5v4h-4M6 20.5v-4h4" /></>,
  folder: <path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />,
  edit: <><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="m13.5 6.5 4 4" /></>,
  link: <><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></>,
  zoomIn: <><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.2-4.2M8 11h6M11 8v6" /></>,
  zoomOut: <><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.2-4.2M8 11h6" /></>,
  skipBack: <><path d="M6 5v14" /><path d="M19 5v14L8.5 12z" fill="currentColor" /></>,
  skipFwd: <><path d="M18 5v14" /><path d="M5 5v14l10.5-7z" fill="currentColor" /></>,
  headphones: <><path d="M4 15v-3a8 8 0 0 1 16 0v3" /><rect x="3.5" y="14" width="4.5" height="6" rx="1.5" /><rect x="16" y="14" width="4.5" height="6" rx="1.5" /></>,
  volume: <><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" /><path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a7.5 7.5 0 0 1 0 11" /></>,
  notes: <><rect x="5" y="3.5" width="14" height="17" rx="2" /><path d="M8.5 8.5h7M8.5 12h7M8.5 15.5h4" /></>,
  wand: <><path d="m4 20 11-11" /><path d="m14 5 1-2 1 2 2 1-2 1-1 2-1-2-2-1zM19 11l.6-1.2L21 9l-1.4-.8L19 7l-.6 1.2L17 9l1.4.8z" /></>,
  warning: <><path d="M12 4 2.8 19.5h18.4z" /><path d="M12 10v4M12 17h.01" /></>,
  info: <><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5M12 8h.01" /></>,
  history: <><path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3L4.5 9" /><path d="M4.5 4.5V9H9M12 8v4.5l3 2" /></>,
  loop: <><path d="M17 3.5 20.5 7 17 10.5" /><path d="M3.5 12V10a3 3 0 0 1 3-3h14M7 20.5 3.5 17 7 13.5" /><path d="M20.5 12v2a3 3 0 0 1-3 3h-14" /></>,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size, stroke = 1.75, className }: { name: IconName; size?: number; stroke?: number; className?: string }) {
  return (
    <svg
      className={className} width={size ?? 18} height={size ?? 18} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
    >{PATHS[name]}</svg>
  );
}

/* ------------------------------------------------------------ track bits */

export function KeyBadge({ value, size, solid, title }: { value: string | null | undefined; size?: "sm"; solid?: boolean; title?: string }) {
  const k = parseKey(value);
  return (
    <span
      className={`ui-key ${size ?? ""} ${solid ? "solid" : ""} ${k ? "" : "none"}`}
      style={{ "--k": keyColor(k) } as React.CSSProperties}
      title={title ?? (k ? `Key ${keyLabel(k)}${value && value !== keyLabel(k) ? ` (${value})` : ""}` : "Key unknown")}
    >{keyLabel(k)}</span>
  );
}

/** Cover art from the server's thumbnail cache; initial letter if none. */
export function Art({
  trackId, src, label, size = 48, playing, onPlay,
}: { trackId?: number; src?: string; label: string; size?: number; playing?: boolean; onPlay?: () => void }) {
  const [failed, setFailed] = useState(false);
  const url = src ?? (trackId != null ? `/api/art/${trackId}` : undefined);
  useEffect(() => setFailed(false), [url]);
  const body = !url || failed
    ? <span className="ph">{label.trim().slice(0, 1).toUpperCase() || "♪"}</span>
    : <img src={url} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setFailed(true)} />;
  const style = { width: size, height: size };
  if (!onPlay) return <span className={`ui-art ${playing ? "playing" : ""}`} style={style}>{body}</span>;
  return (
    <button
      type="button" className={`ui-art ${playing ? "playing" : ""}`} style={style}
      onClick={(e) => { e.stopPropagation(); onPlay(); }}
      aria-label={`${playing ? "Pause" : "Play"} ${label}`}
    >
      {body}
      <span className="hover-play"><Icon name={playing ? "pause" : "play"} /></span>
    </button>
  );
}

export function PlayButton({ playing, onClick, label, className }: { playing: boolean; onClick: () => void; label: string; className?: string }) {
  return (
    <button
      type="button" className={`ui-play ${playing ? "on" : ""} ${className ?? ""}`}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      aria-label={`${playing ? "Pause" : "Play"} ${label}`}
    ><Icon name={playing ? "pause" : "play"} /></button>
  );
}

export function AddButton({ added, onClick, label, disabled }: { added: boolean; onClick: () => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button" className={`ui-add ${added ? "done" : ""}`} disabled={added || disabled}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      aria-label={added ? `${label} is in the set` : `Add ${label} to the set`}
      title={added ? "In your set" : "Add to set"}
    ><Icon name={added ? "check" : "plus"} stroke={2.2} /></button>
  );
}

/* ------------------------------------------------------------- controls */

export function Segmented<T extends string>({
  value, options, onChange, size, tone, label,
}: {
  value: T; onChange: (v: T) => void; label: string;
  options: { value: T; label: string; icon?: IconName; title?: string }[];
  size?: "lg"; tone?: "accent";
}) {
  // Radio-group keyboard model: one tab stop, arrows move and select.
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1
      : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    const edge = e.key === "Home" ? 0 : e.key === "End" ? options.length - 1 : -1;
    if (!step && edge < 0) return;
    e.preventDefault();
    const at = options.findIndex((o) => o.value === value);
    const next = edge >= 0 ? edge : (at + step + options.length) % options.length;
    onChange(options[next]!.value);
    (e.currentTarget.children[next] as HTMLElement | undefined)?.focus();
  };
  return (
    <div className={`ui-seg ${size ?? ""} ${tone ?? ""}`} role="radiogroup" aria-label={label} onKeyDown={onKeyDown}>
      {options.map((o) => (
        <button
          key={o.value} type="button" role="radio" aria-checked={o.value === value}
          tabIndex={o.value === value ? 0 : -1}
          className={o.value === value ? "on" : ""} title={o.title} onClick={() => onChange(o.value)}
        >{o.icon ? <Icon name={o.icon} /> : null}{o.label}</button>
      ))}
    </div>
  );
}

/**
 * A menu pinned to the viewport next to its trigger, so scrolling lists and
 * overflow:hidden panels can never clip it. Closes on scrim click or Escape.
 */
export function Popover({
  anchor, onClose, children, width, align = "start",
}: { anchor: DOMRect; onClose: () => void; children: ReactNode; width?: number; align?: "start" | "end" }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; origin: string }>({ left: anchor.left, top: anchor.bottom + 6, origin: "top left" });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth, h = el.offsetHeight;
    let left = align === "end" ? anchor.right - w : anchor.left;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    const below = anchor.bottom + 6;
    const flip = below + h > window.innerHeight - 8 && anchor.top - h - 6 > 8;
    const top = flip ? anchor.top - h - 6 : Math.min(below, window.innerHeight - h - 8);
    setPos({ left, top, origin: `${flip ? "bottom" : "top"} ${align === "end" ? "right" : "left"}` });
  }, [anchor, align]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <>
      <div className="ui-scrim" onMouseDown={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <div
        ref={ref} className="ui-pop" role="menu"
        style={{ left: pos.left, top: pos.top, width, "--origin": pos.origin } as React.CSSProperties}
      >{children}</div>
    </>
  );
}

export function MenuItem({
  icon, children, onClick, hint, danger, disabled, active,
}: { icon?: IconName; children: ReactNode; onClick: () => void; hint?: ReactNode; danger?: boolean; disabled?: boolean; active?: boolean }) {
  return (
    <button type="button" role="menuitem" className={`item ${danger ? "danger" : ""} ${active ? "active" : ""}`} disabled={disabled} onClick={onClick}>
      {icon ? <Icon name={icon} /> : null}<span>{children}</span>{hint ? <span className="hint">{hint}</span> : null}
    </button>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="ui-empty">
      <div className="title">{title}</div>
      {children ? <p>{children}</p> : null}
      {action}
    </div>
  );
}

/**
 * The visible toast. Screen readers hear the message from ToastRegion, which
 * stays mounted so every update is announced. Errors carry a dismiss button
 * because they do not time out.
 */
export function Toast({ msg, kind, onDismiss }: { msg: string; kind: "" | "ok" | "err"; onDismiss?: () => void }) {
  return (
    <div className={`ui-toast ${kind}`}>
      <span className="ui-dot" aria-hidden="true" /><span>{msg}</span>
      {kind === "err" && onDismiss ? (
        <button type="button" className="ui-icon-btn sm" aria-label="Dismiss" title="Dismiss" onClick={onDismiss}>
          <Icon name="x" />
        </button>
      ) : null}
    </div>
  );
}

export function ToastRegion({ msg }: { msg: string | undefined }) {
  return <div className="sr-only" role="status">{msg ?? ""}</div>;
}

export const fmtLength = (s: number | null | undefined) =>
  s ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}` : "—";

export const fmtTotal = (seconds: number) => {
  const h = Math.floor(seconds / 3600), m = Math.round((seconds % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m} min`;
};
