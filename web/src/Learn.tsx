import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { EmptyState, Icon, MenuItem, Popover, Segmented } from "./ui";
import "./learn.css";

export type LearnKind = "tutorial" | "set";
export type LearnStatus = "queued" | "watching" | "done" | "skipped";
export type Chapter = { start: number; title: string };

export type LearnVideo = {
  videoId: string; title: string; channel: string | null; duration: number | null;
  kind: LearnKind; topic: string | null; status: LearnStatus; notes: string;
  chapters: Chapter[]; position: number; sort: number;
  addedAt: number | null; watchedAt: number | null;
};

type Counts = {
  total: number; open: number; watching: number; queued: number;
  done: number; skipped: number;
  tutorials: { done: number; open: number };
  sets: { done: number; open: number };
};

export type LearnProps = { onChanged?: () => void; notify?: (msg: string, kind?: "ok" | "err") => void };

const STATUSES: { value: LearnStatus; label: string }[] = [
  { value: "queued", label: "To watch" }, { value: "watching", label: "Watching" },
  { value: "done", label: "Done" }, { value: "skipped", label: "Skipped" },
];

type KindFilter = "all" | LearnKind;
type StatusFilter = "open" | "done" | "skipped";

const KINDS: { value: KindFilter; label: string }[] = [
  { value: "tutorial", label: "Tutorials" }, { value: "set", label: "Sets & mixes" }, { value: "all", label: "All" },
];
const SHOWS: { value: StatusFilter; label: string }[] = [
  { value: "open", label: "To watch" }, { value: "done", label: "Done" }, { value: "skipped", label: "Skipped" },
];

const clock = (seconds: number) => {
  const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), s = Math.floor(seconds % 60);
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
};
const length = (seconds: number | null) => (seconds ? clock(seconds) : "—");

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((body as { error?: string }).error ?? "The server hit an error. Try again.");
  return body as T;
}

const patch = (videoId: string, body: Partial<LearnVideo>) =>
  json<LearnVideo>(`/api/learn/${videoId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

/* ---------------------------------------------------------------- player -- */

type YtPlayer = {
  loadVideoById: (o: { videoId: string; startSeconds?: number }) => void;
  getCurrentTime: () => number;
  seekTo: (seconds: number, allowSeekAhead: boolean) => void;
  destroy: () => void;
};
type YtApi = { Player: new (el: HTMLElement, opts: unknown) => YtPlayer };

declare global {
  interface Window { YT?: YtApi; onYouTubeIframeAPIReady?: () => void }
}

let apiPromise: Promise<YtApi> | null = null;

/** One script tag for the whole session; every player shares it. */
function loadPlayerApi(): Promise<YtApi> {
  if (apiPromise) return apiPromise;
  apiPromise = new Promise<YtApi>((resolve, reject) => {
    if (window.YT?.Player) { resolve(window.YT); return; }
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      if (window.YT?.Player) resolve(window.YT);
      else reject(new Error("YouTube player failed to load. Reload the page."));
    };
    const tag = document.createElement("script");
    tag.src = "https://www.youtube.com/iframe_api";
    tag.onerror = () => reject(new Error("YouTube player didn't load. Check your connection."));
    document.head.appendChild(tag);
  });
  return apiPromise;
}

/**
 * The embedded player, plus where you are in it.
 *
 * The position is read on a timer rather than from an event because the API
 * only reports state changes, and a video left paused halfway through is
 * exactly the case the watchlist exists to remember.
 */
function useYouTube(video: LearnVideo | null, onPosition: (seconds: number) => void) {
  const host = useRef<HTMLDivElement | null>(null);
  const player = useRef<YtPlayer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const report = useRef(onPosition);
  report.current = onPosition;

  // The resume point is taken once, when the video is opened. Reading it on
  // every render instead would rewind the player to its own last saved second.
  const videoId = video?.videoId ?? null;
  const resumeAt = useRef(0);
  const opened = useRef<string | null>(null);
  if (videoId !== opened.current) {
    opened.current = videoId;
    resumeAt.current = video?.position ?? 0;
  }

  useEffect(() => {
    if (!videoId) return;
    let dropped = false;
    const start = Math.max(0, resumeAt.current - 3);

    loadPlayerApi().then((api) => {
      if (dropped || !host.current) return;
      setError(null);
      if (player.current) { player.current.loadVideoById({ videoId, startSeconds: start }); return; }
      // The API replaces the element it is given, so it gets one of its own
      // rather than a node React still believes it owns.
      const mount = document.createElement("div");
      host.current.appendChild(mount);
      player.current = new api.Player(mount, {
        videoId,
        playerVars: { start: Math.floor(start), rel: 0, modestbranding: 1, playsinline: 1 },
      });
    }).catch((e: unknown) => setError((e as Error).message));

    return () => { dropped = true; };
  }, [videoId]);

  useEffect(() => {
    if (!videoId) return;
    const timer = setInterval(() => {
      const at = player.current?.getCurrentTime?.();
      if (typeof at === "number" && at > 0) report.current(Math.floor(at));
    }, 5000);
    return () => clearInterval(timer);
  }, [videoId]);

  useEffect(() => () => { player.current?.destroy(); player.current = null; }, []);

  const seek = useCallback((seconds: number) => {
    player.current?.seekTo(seconds, true);
  }, []);

  return { host, seek, error };
}

/* ------------------------------------------------------------------ view -- */

export function Learn({ onChanged, notify }: LearnProps) {
  const [videos, setVideos] = useState<LearnVideo[]>([]);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [kind, setKind] = useState<KindFilter>("all");
  const [status, setStatus] = useState<StatusFilter>("open");
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [menu, setMenu] = useState<DOMRect | null>(null);
  const notesId = useId();

  const say = useCallback((msg: string, k: "ok" | "err" = "ok") => notify?.(msg, k), [notify]);

  const load = useCallback(async () => {
    try {
      const data = await json<{ videos: LearnVideo[]; counts: Counts }>("/api/learn");
      setVideos(data.videos);
      setCounts(data.counts);
    } catch (e) { say((e as Error).message, "err"); }
    finally { setLoaded(true); }
  }, [say]);

  useEffect(() => { void load(); }, [load]);

  const shown = useMemo(() => {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return videos.filter((v) => {
      if (kind !== "all" && v.kind !== kind) return false;
      if (status === "open" && v.status !== "queued" && v.status !== "watching") return false;
      if (status === "done" && v.status !== "done") return false;
      if (status === "skipped" && v.status !== "skipped") return false;
      if (!terms.length) return true;
      const hay = `${v.title} ${v.channel ?? ""} ${v.topic ?? ""} ${v.notes}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }, [videos, kind, status, query]);

  const open = useMemo(() => videos.find((v) => v.videoId === openId) ?? null, [videos, openId]);

  /** Server is the source of truth; the local copy is patched in place so the
      list does not jump while a note is being typed. */
  const merge = useCallback((next: LearnVideo) => {
    setVideos((all) => all.map((v) => (v.videoId === next.videoId ? next : v)));
  }, []);

  const save = useCallback(async (videoId: string, body: Partial<LearnVideo>, refreshCounts = true) => {
    try {
      merge(await patch(videoId, body));
      if (refreshCounts) {
        const data = await json<{ counts: Counts }>("/api/learn");
        setCounts(data.counts);
        onChanged?.();
      }
    } catch (e) { say((e as Error).message, "err"); }
  }, [merge, onChanged, say]);

  /* ---- position, written back at most once every few seconds ---- */
  const lastSaved = useRef(0);
  const pending = useRef<{ videoId: string; at: number } | null>(null);

  const onPosition = useCallback((seconds: number) => {
    if (!open) return;
    pending.current = { videoId: open.videoId, at: seconds };
    if (Math.abs(seconds - lastSaved.current) < 10) return;
    lastSaved.current = seconds;
    // Watching starts when a video actually runs, not when it is clicked open.
    const body: Partial<LearnVideo> = { position: seconds };
    if (open.status === "queued" && seconds > 30) body.status = "watching";
    void save(open.videoId, body, body.status !== undefined);
  }, [open, save]);

  const { host, seek, error: playerError } = useYouTube(open, onPosition);

  // A position known only to the browser is lost on navigation, so the last
  // reading is flushed when the pane closes or the view goes away.
  const flush = useRef<() => void>(() => {});
  flush.current = () => {
    const last = pending.current;
    if (!last || Math.abs(last.at - lastSaved.current) < 5) return;
    lastSaved.current = last.at;
    void patch(last.videoId, { position: last.at }).catch(() => {});
  };
  useEffect(() => () => flush.current(), []);

  const openVideo = (videoId: string) => {
    flush.current();
    pending.current = null;
    lastSaved.current = videos.find((v) => v.videoId === videoId)?.position ?? 0;
    setMenu(null);
    setOpenId(videoId);
  };

  /** Closing hands focus back to the card that opened the video. */
  const closeVideo = () => {
    const id = openId;
    flush.current();
    setMenu(null);
    setOpenId(null);
    if (id) requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(`[data-video="${CSS.escape(id)}"]`)?.focus();
    });
  };

  /* ---- notes ---- */
  const [draftNotes, setDraftNotes] = useState("");
  const notesFor = useRef<string | null>(null);
  useEffect(() => {
    if (!open) { notesFor.current = null; return; }
    if (notesFor.current === open.videoId) return;
    notesFor.current = open.videoId;
    setDraftNotes(open.notes);
  }, [open]);

  useEffect(() => {
    if (!open || notesFor.current !== open.videoId || draftNotes === open.notes) return;
    const timer = setTimeout(() => { void save(open.videoId, { notes: draftNotes }, false); }, 700);
    return () => clearTimeout(timer);
  }, [draftNotes, open, save]);

  /* ---- add / refresh / remove ---- */
  const add = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!url.trim() || busy) return;
    setBusy(true);
    try {
      const result = await json<{ video: LearnVideo; alreadyHad: boolean }>("/api/learn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim(), kind: kind === "all" ? "tutorial" : kind }),
      });
      setUrl("");
      await load();
      onChanged?.();
      openVideo(result.video.videoId);
      say(result.alreadyHad ? `Already in your list: ${result.video.title}` : `Added ${result.video.title}`);
    } catch (e) { say((e as Error).message, "err"); }
    finally { setBusy(false); }
  };

  const refresh = async (videoId: string) => {
    setBusy(true);
    try {
      merge(await json<LearnVideo>(`/api/learn/${videoId}/refresh`, { method: "POST" }));
      say("Details updated");
    } catch (e) { say((e as Error).message, "err"); }
    finally { setBusy(false); }
  };

  const remove = async (video: LearnVideo) => {
    if (!confirm(`Remove “${video.title}”? Its notes are deleted too.`)) return;
    try {
      await json(`/api/learn/${video.videoId}`, { method: "DELETE" });
      if (openId === video.videoId) setOpenId(null);
      await load();
      onChanged?.();
      say("Removed");
    } catch (e) { say((e as Error).message, "err"); }
  };

  const filtered = kind !== "all" || status !== "open" || query.trim() !== "";
  const clearFilters = () => { setKind("all"); setStatus("open"); setQuery(""); };

  return (
    <div className="lrn">
      <div className="lrn-top">
        <div className="lrn-heading">
          <h1>Learn</h1>
          {counts ? <p>{counts.open} to watch · {counts.done} done</p> : null}
        </div>
        <form className="lrn-add" onSubmit={add}>
          <label className="ui-field">
            <Icon name="link" />
            <input
              value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false}
              type="url" inputMode="url" autoComplete="off"
              placeholder="Paste a YouTube link" aria-label="YouTube link"
            />
          </label>
          <button type="submit" className="ui-btn primary" disabled={busy || !url.trim()}>
            <Icon name="plus" />{busy ? "Adding…" : "Add video"}
          </button>
        </form>
      </div>

      <div className="lrn-filters">
        <Segmented label="Type" value={kind} options={KINDS} onChange={setKind} />
        <Segmented label="Show" value={status} options={SHOWS} onChange={setStatus} />
        <label className="ui-field lrn-find">
          <Icon name="search" />
          <input
            type="search" value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder="Search" aria-label="Search videos" spellCheck={false}
          />
        </label>
      </div>

      <div className={`lrn-split ${open ? "opened" : ""}`}>
        <div className="lrn-list">
          {!loaded ? (
            <div className="lrn-grid" aria-busy="true">
              <span className="sr-only" role="status">Loading</span>
              {Array.from({ length: 6 }, (_, i) => (
                <div className="lrn-card skel" key={i} aria-hidden="true">
                  <span className="lrn-thumb"><span className="ui-skel fill" /></span>
                  <span className="lrn-card-txt">
                    <span className="ui-skel sk-a" />
                    <span className="ui-skel sk-b" />
                  </span>
                </div>
              ))}
            </div>
          ) : shown.length === 0 ? (
            videos.length && filtered ? (
              <EmptyState
                title="No matches"
                action={<button type="button" className="ui-btn" onClick={clearFilters}>Clear filters</button>}
              />
            ) : (
              <EmptyState title={videos.length ? "Nothing to watch" : "No videos yet"} />
            )
          ) : (
            <div className="lrn-grid">
              {shown.map((video) => (
                <Card
                  key={video.videoId} video={video} active={video.videoId === openId}
                  onOpen={() => openVideo(video.videoId)}
                />
              ))}
            </div>
          )}
        </div>

        {open ? (
          <section className="lrn-pane" aria-labelledby={`${notesId}-t`}>
            <div className="lrn-pane-in">
              <div className="lrn-stage" ref={host} />
              {playerError ? (
                <div className="lrn-err" role="alert"><Icon name="warning" />{playerError}</div>
              ) : null}

              <div className="lrn-detail">
                <div className="lrn-head">
                  <div className="lrn-ttl">
                    <h2 id={`${notesId}-t`}>{open.title}</h2>
                    <p>{open.channel ?? "Unknown channel"} · <span className="num">{length(open.duration)}</span></p>
                  </div>
                  <button
                    type="button" className={`ui-icon-btn ${menu ? "on" : ""}`}
                    aria-label="More actions" title="More actions" aria-haspopup="menu" aria-expanded={!!menu}
                    onClick={(e) => setMenu(menu ? null : e.currentTarget.getBoundingClientRect())}
                  ><Icon name="more" /></button>
                  <button type="button" className="ui-icon-btn" aria-label="Close video" title="Close" onClick={closeVideo}>
                    <Icon name="x" />
                  </button>
                </div>

                <Segmented
                  label="Status" value={open.status} options={STATUSES}
                  onChange={(value) => void save(open.videoId, { status: value })}
                />

                <div className="lrn-block">
                  <h3>Chapters</h3>
                  {open.chapters.length ? (
                    <div className="lrn-chapters">
                      {open.chapters.map((chapter) => (
                        <button
                          type="button" className="lrn-chap" key={`${chapter.start}-${chapter.title}`}
                          onClick={() => seek(chapter.start)}
                        >
                          <span className="t">{clock(chapter.start)}</span>
                          <span className="n">{chapter.title}</span>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div>
                      <button
                        type="button" className="ui-btn sm ghost" disabled={busy}
                        title="Check YouTube for chapters" onClick={() => void refresh(open.videoId)}
                      ><Icon name="sync" />Find chapters</button>
                    </div>
                  )}
                </div>

                <div className="lrn-block">
                  <h3><label htmlFor={notesId}>Notes</label></h3>
                  <textarea
                    id={notesId} className="ui-textarea lrn-notes"
                    value={draftNotes} onChange={(e) => setDraftNotes(e.target.value)}
                    placeholder="What to try on the controller…"
                  />
                </div>
              </div>
            </div>

            {menu ? (
              <Popover anchor={menu} align="end" onClose={() => setMenu(null)}>
                <MenuItem icon="link" onClick={() => {
                  setMenu(null);
                  window.open(`https://youtu.be/${open.videoId}`, "_blank", "noopener,noreferrer");
                }}>Open on YouTube</MenuItem>
                <MenuItem icon="sync" disabled={busy} onClick={() => { setMenu(null); void refresh(open.videoId); }}>
                  Refresh details
                </MenuItem>
                <div className="sep" />
                <MenuItem icon="trash" danger onClick={() => { setMenu(null); void remove(open); }}>Remove</MenuItem>
              </Popover>
            ) : null}
          </section>
        ) : null}
      </div>
    </div>
  );
}

function Card({ video, active, onOpen }: { video: LearnVideo; active: boolean; onOpen: () => void }) {
  const progress = video.duration && video.position
    ? Math.min(100, Math.round((video.position / video.duration) * 100)) : 0;
  const tag = video.status === "watching"
    ? <span className="ui-tag info">{progress ? `${progress}% watched` : "Watching"}</span>
    : video.status === "done"
      ? <span className="ui-tag ok"><Icon name="check" stroke={2.4} />Done</span>
      : video.status === "skipped" ? <span className="ui-tag">Skipped</span> : null;
  const hasNotes = video.notes.trim() !== "";
  return (
    <button
      type="button" className={`lrn-card ${active ? "on" : ""} st-${video.status}`}
      onClick={onOpen} data-video={video.videoId} aria-current={active ? "true" : undefined}
    >
      <span className="lrn-thumb">
        <Icon name="learn" className="ph" />
        <img src={`/api/learn/${video.videoId}/thumb`} alt="" loading="lazy" decoding="async" draggable={false}
          onError={(e) => { e.currentTarget.style.visibility = "hidden"; }} />
        {video.duration ? <span className="len">{length(video.duration)}</span> : null}
        {progress ? <span className="prog"><i style={{ width: `${progress}%` }} /></span> : null}
      </span>
      <span className="lrn-card-txt">
        <span className="ttl" title={video.title}>{video.title}</span>
        <span className="sub">{[video.channel ?? "Unknown channel", video.topic].filter(Boolean).join(" · ")}</span>
        {tag || hasNotes ? (
          <span className="tags">
            {tag}
            {hasNotes ? <span className="ui-tag" title="Has notes"><Icon name="notes" /><span className="sr-only">Has notes</span></span> : null}
          </span>
        ) : null}
      </span>
    </button>
  );
}
