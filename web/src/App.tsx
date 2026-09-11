import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, unwrap, type State, type Track } from "./api";
import { ChangesModal, DuplicatesModal, UpstreamModal } from "./Modals";
import { OpsModal, StoresModal } from "./Stores";
import { fmtTime, useSelection, useToast, usePlayer } from "./hooks";

type View = { kind: "all" | "unfiled" | "trash" } | { kind: "pl"; id: number };
type SortKey = "title" | "artist" | "folder" | "duration";
type Modal = null | "dupes" | "changes" | "upstream" | "stores" | "ops";

const VIEW_TITLE: Record<string, string> = {
  all: "All tracks", unfiled: "Unfiled", trash: "Pending deletes",
};

const SORTS: [SortKey, string][] = [
  ["artist", "Artist"], ["title", "Title"], ["folder", "Folder"], ["duration", "Length"],
];

export function App() {
  const [state, setState] = useState<State | null>(null);
  const [view, setView] = useState<View>({ kind: "all" });
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "artist", dir: 1 });
  const [modal, setModal] = useState<Modal>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [dragCount, setDragCount] = useState(0);
  const [dropTarget, setDropTarget] = useState<number | "trash" | null>(null);
  const [ghost, setGhost] = useState<{ x: number; y: number; label: string } | null>(null);

  const { toast, show } = useToast();
  const player = usePlayer();
  const searchRef = useRef<HTMLInputElement>(null);
  const dragIds = useRef<number[]>([]);
  const shiftDrop = useRef(false);

  const load = useCallback(async () => {
    try { setState(await unwrap(api.state.get())); }
    catch (e) { show((e as Error).message, "err"); }
  }, [show]);

  useEffect(() => { void load(); }, [load]);

  /* ---------- derived list ---------- */
  const shown = useMemo(() => {
    if (!state) return [];
    let t = state.tracks;
    if (view.kind === "unfiled") t = t.filter((x) => x.playlists.length === 0);
    else if (view.kind === "trash") t = t.filter((x) => x.pendingDelete);
    else if (view.kind === "pl") t = t.filter((x) => x.playlists.includes(view.id));

    const q = query.trim().toLowerCase();
    if (q) {
      t = t.filter((x) =>
        `${x.title ?? ""} ${x.artist ?? ""} ${x.filename}`.toLowerCase().includes(q));
    }
    const { key, dir } = sort;
    return [...t].sort((a, b) => {
      const x = a[key], y = b[key];
      if (typeof x === "number" || typeof y === "number") {
        return (((x as number) ?? 0) - ((y as number) ?? 0)) * dir;
      }
      return String(x ?? "").localeCompare(String(y ?? ""), undefined, { sensitivity: "base" }) * dir;
    });
  }, [state, view, query, sort]);

  const selection = useSelection(shown);
  const { sel } = selection;
  const selected = useMemo(() => shown.filter((t) => sel.has(t.id)), [shown, sel]);

  const activePl = view.kind === "pl" ? state?.playlists.find((p) => p.id === view.id) : undefined;

  /* ---------- mutations ---------- */
  const run = useCallback(async (fn: () => Promise<string | void>) => {
    try {
      const msg = await fn();
      await load();
      if (msg) show(msg, "ok");
    } catch (e) { show((e as Error).message, "err"); }
  }, [load, show]);

  const newPlaylist = () => {
    const name = window.prompt("New playlist name")?.trim();
    if (!name) return;
    void run(async () => {
      await unwrap(api.playlist.post({ name }));
      return `Created “${name}”`;
    });
  };

  const removeFromPlaylist = () => {
    if (view.kind !== "pl") return;
    const ids = [...sel];
    void run(async () => {
      const r = await unwrap(api.membership.post({
        trackIds: ids, playlistId: view.id, op: "remove",
      }));
      selection.clear();
      return `Removed ${r.changed}`;
    });
  };

  const stageDelete = () => {
    const ids = [...sel];
    if (!ids.length) return;
    void run(async () => {
      await unwrap(api.delete.post({ trackIds: ids }));
      selection.clear();
      return `${ids.length} staged — nothing deleted yet`;
    });
  };

  const undoDelete = () => {
    const ids = [...sel];
    void run(async () => {
      await unwrap(api.delete.undo.post({ trackIds: ids }));
      selection.clear();
      return "Restored";
    });
  };

  /** Deletes never touch disk here — they go onto the fs plan you apply yourself. */
  const stageToPlan = () => {
    const n = state?.counts.pendingDeletes ?? 0;
    if (!n) return;
    void run(async () => {
      const r = await unwrap(api.delete.stage.post());
      window.open("/api/plan/fs/text", "_blank");
      return `${r.staged} on the fs plan — nothing was moved`;
    });
  };

  /* ---------- drag & drop ---------- */
  const onDragStart = (e: React.DragEvent, id: number) => {
    if (!sel.has(id)) selection.replace(id);
    const ids = sel.has(id) ? [...sel] : [id];
    dragIds.current = ids;
    setDragCount(ids.length);
    e.dataTransfer.effectAllowed = "copyMove";
    e.dataTransfer.setData("text/plain", ids.join(","));
    const img = new Image();
    img.src = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
    e.dataTransfer.setDragImage(img, 0, 0);
  };

  const onDragEnd = () => {
    dragIds.current = [];
    setDragCount(0);
    setDropTarget(null);
    setGhost(null);
  };

  useEffect(() => {
    if (!dragCount) return;
    const move = (e: DragEvent) => {
      e.preventDefault();
      shiftDrop.current = e.shiftKey;
      setGhost((g) => (g ? { ...g, x: e.clientX + 14, y: e.clientY + 14 } : g));
    };
    document.addEventListener("dragover", move);
    return () => document.removeEventListener("dragover", move);
  }, [dragCount]);

  const dropOnPlaylist = (targetId: number) => {
    const ids = dragIds.current;
    if (!ids.length) return;
    const from = view.kind === "pl" ? view.id : null;
    const moving = shiftDrop.current && from != null && from !== targetId;
    const name = state?.playlists.find((p) => p.id === targetId)?.name ?? "";
    void run(async () => {
      if (moving) {
        const r = await unwrap(api.move.post({
          trackIds: ids, fromPlaylistId: from, toPlaylistId: targetId,
        }));
        return `Moved ${r.added} → ${name}`;
      }
      const r = await unwrap(api.membership.post({
        trackIds: ids, playlistId: targetId, op: "add",
      }));
      return r.changed ? `Added ${r.changed} → ${name}` : "Already in that playlist";
    });
  };

  const dropOnTrash = () => {
    const ids = dragIds.current;
    if (!ids.length) return;
    void run(async () => {
      await unwrap(api.delete.post({ trackIds: ids }));
      return `${ids.length} staged for deletion`;
    });
  };

  /* ---------- keyboard ---------- */
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.tagName === "INPUT") { if (e.key === "Escape") el.blur(); return; }
      if (modal) return;
      if (e.key === "/") { e.preventDefault(); searchRef.current?.focus(); return; }
      if (e.key === "Escape") { selection.clear(); return; }
      if ((e.metaKey || e.ctrlKey) && e.key === "a") { e.preventDefault(); selection.selectAll(); return; }
      if (e.key === " ") {
        e.preventDefault();
        const first = [...sel][0];
        if (first != null && first !== player.playingId) player.play(first);
        else player.toggle();
        return;
      }
      if ((e.key === "Delete" || e.key === "Backspace") && sel.size) { e.preventDefault(); stageDelete(); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  });

  useEffect(() => {
    player.onEnded(() => {
      const i = shown.findIndex((t) => t.id === player.playingId);
      const next = shown[i + 1];
      if (next) player.play(next.id);
    });
  }, [shown, player]);

  if (!state) {
    return <div className="app"><div className="empty" style={{ marginTop: 120 }}>Loading library…</div></div>;
  }

  const nowTrack = state.tracks.find((t) => t.id === player.playingId);
  const webmShown = shown.filter((t) => t.ext !== "m4a").length;
  const dirty = !state.changes.clean;

  const navItem = (
    key: string, active: boolean, icon: string, label: string, count: number | string,
    opts: { onClick: () => void; drop?: () => void; cls?: string; dropKey?: number | "trash" } = { onClick: () => {} },
  ) => (
    <button
      key={key}
      className={`nav ${active ? "active" : ""} ${opts.cls ?? ""} ${dropTarget === opts.dropKey && opts.dropKey != null ? "drop" : ""}`}
      onClick={opts.onClick}
      onDragOver={opts.drop ? (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = shiftDrop.current ? "move" : "copy";
        if (opts.dropKey != null) setDropTarget(opts.dropKey);
        setGhost({
          x: e.clientX + 14, y: e.clientY + 14,
          label: opts.dropKey === "trash"
            ? `Stage ${dragCount} for deletion`
            : `${shiftDrop.current && view.kind === "pl" ? "Move" : "Add"} ${dragCount} → ${label}`,
        });
      } : undefined}
      onDragLeave={opts.drop ? () => setDropTarget(null) : undefined}
      onDrop={opts.drop ? (e) => { e.preventDefault(); setDropTarget(null); opts.drop!(); } : undefined}
    >
      <span className="ic">{icon}</span>
      <span className="nm">{label}</span>
      <span className="ct">{count}</span>
    </button>
  );

  return (
    <div className="app">
      <header>
        <div className="brand">
          <span className="dot" />dj-organizer
          <small>{state.counts.tracks} tracks</small>
        </div>
        <label className="search">
          <span style={{ color: "var(--fg-3)", fontSize: 11 }}>⌕</span>
          <input
            ref={searchRef} value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter tracks…" spellCheck={false} autoComplete="off"
          />
          <kbd>/</kbd>
        </label>
        <div className="spacer" />
        {/* One pill, because only one of these is ever actionable: whether you
            have unapplied changes. The rest are inspection, and inspection can
            live behind a menu. */}
        <button
          className={`pill ${state.ops.open || dirty ? "dirty" : ""}`}
          onClick={() => setModal(state.ops.open || dirty ? "changes" : "ops")}
        >
          <span className="led" />
          {state.ops.open ? `${state.ops.open} to apply` : dirty ? "Changes staged" : "In sync"}
        </button>
        <div className="menuwrap">
          <button
            className={`pill icon ${menuOpen ? "on" : ""}`}
            onClick={() => setMenuOpen((v) => !v)}
            aria-label="More"
          >⋯</button>
          {menuOpen ? (
            <>
              <div className="menuscrim" onClick={() => setMenuOpen(false)} />
              <div className="menu">
                {([
                  ["upstream", "Compare with YouTube Music"],
                  ["stores", "Compare rekordbox · Serato · disk"],
                  ["ops", "Change log"],
                  ["changes", "Changeset to apply"],
                  ["dupes", `Duplicates${state.counts.duplicates ? ` (${state.counts.duplicates})` : ""}`],
                ] as [Modal, string][]).map(([m, label]) => (
                  <button key={m} onClick={() => { setMenuOpen(false); setModal(m); }}>{label}</button>
                ))}
              </div>
            </>
          ) : null}
        </div>
      </header>

      <div className="body">
        <aside>
          <div className="sec">Library</div>
          {navItem("all", view.kind === "all", "≡", "All tracks", state.counts.tracks,
            { onClick: () => setView({ kind: "all" }) })}
          {navItem("unfiled", view.kind === "unfiled", "◇", "Unfiled", state.counts.unfiled || "",
            { onClick: () => setView({ kind: "unfiled" }), cls: state.counts.unfiled ? "warn" : "" })}
          {navItem("trash", view.kind === "trash", "⌫", "Pending deletes",
            state.counts.pendingDeletes || "", {
              onClick: () => setView({ kind: "trash" }),
              drop: dropOnTrash,
              dropKey: "trash",
              cls: state.counts.pendingDeletes ? "dngr" : "",
            })}

          <div className="sec">
            Playlists
            <button onClick={newPlaylist} title="New playlist">+</button>
          </div>
          {state.playlists.map((p) =>
            navItem(`pl${p.id}`, view.kind === "pl" && view.id === p.id,
              p.is_manual ? "★" : "", p.name, p.count, {
                onClick: () => setView({ kind: "pl", id: p.id }),
                drop: () => dropOnPlaylist(p.id),
                dropKey: p.id,
                cls: p.is_manual ? "lock" : "",
              }))}
        </aside>

        <main>
          <div className="bar">
            <h2>{activePl ? activePl.name : VIEW_TITLE[view.kind]}</h2>
            <span className="meta">
              {shown.length} track{shown.length === 1 ? "" : "s"}
              {activePl?.is_manual ? " · yours to curate" : ""}
            </span>
            {webmShown ? (
              <button
                className="chip warn" onClick={() => setModal("dupes")}
                title={`${webmShown} WebM/Opus file(s). Serato and rekordbox decode neither, ` +
                  `but each one already has an .m4a twin here — they are spare copies, not gaps.`}
              >{webmShown} webm</button>
            ) : null}
            <div className="spacer" />
            {!sel.size ? (
              <label className="sortsel">
                <select
                  value={sort.key}
                  onChange={(e) => setSort((s) => ({ ...s, key: e.target.value as SortKey }))}
                >
                  {SORTS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                </select>
                <button
                  onClick={() => setSort((s) => ({ ...s, dir: s.dir === 1 ? -1 : 1 }))}
                  title="Reverse"
                >{sort.dir === 1 ? "↑" : "↓"}</button>
              </label>
            ) : <span className="meta">{sel.size} selected</span>}
            {sel.size && view.kind === "pl"
              ? <button className="act" onClick={removeFromPlaylist}>Remove from playlist</button> : null}
            {sel.size && view.kind !== "trash"
              ? <button className="act d" onClick={stageDelete}>Delete</button> : null}
            {sel.size && view.kind === "trash"
              ? <button className="act a" onClick={undoDelete}>Restore</button> : null}
            {view.kind === "trash" && state.counts.pendingDeletes
              ? <button className="act" onClick={stageToPlan}>
                  Put {state.counts.pendingDeletes} delete{state.counts.pendingDeletes === 1 ? "" : "s"} on the fs plan
                </button> : null}
          </div>

          <div className="list">
            {!shown.length ? (
              <div className="empty">
                <b>
                  {view.kind === "unfiled" ? "Nothing unfiled"
                    : view.kind === "trash" ? "Nothing staged for deletion"
                    : "No tracks here"}
                </b>
                {view.kind === "unfiled" ? "Every track belongs to at least one playlist."
                  : view.kind === "trash" ? "Select tracks and hit Delete to stage them. Staging never moves a file."
                  : "Drag tracks here from another playlist."}
              </div>
            ) : shown.map((t) => (
              <TrackRow
                key={t.id} track={t} showFolder={view.kind !== "pl"}
                selected={sel.has(t.id)} playing={player.playingId === t.id}
                dragging={dragCount > 0 && sel.has(t.id)}
                onMouseDown={(e) => selection.click(t.id, e)}
                onDoubleClick={() => player.play(t.id)}
                onDragStart={(e) => onDragStart(e, t.id)}
                onDragEnd={onDragEnd}
              />
            ))}
          </div>
        </main>
      </div>

      <footer>
        <button className="pbtn" onClick={() => {
          if (!nowTrack) { const f = selected[0] ?? shown[0]; if (f) player.play(f.id); return; }
          player.toggle();
        }}>{player.paused ? "▶" : "❚❚"}</button>
        <div className="now">
          <div className="t">{nowTrack ? nowTrack.title ?? nowTrack.filename : "Nothing playing"}</div>
          <div className="a">
            {nowTrack ? `${nowTrack.artist ?? "—"} · ${nowTrack.folder}` : "select a track · space to preview"}
          </div>
        </div>
        <div className="seek">
          <span className="tm">{fmtTime(player.time)}</span>
          <div
            className="track"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              player.seek((e.clientX - r.left) / r.width);
            }}
          >
            <div className="fill" style={{
              width: player.duration ? `${(player.time / player.duration) * 100}%` : 0,
            }} />
          </div>
          <span className="tm">{fmtTime(player.duration)}</span>
        </div>
        <input
          type="range" className="vol" min={0} max={1} step={0.01} defaultValue={0.8}
          onChange={(e) => player.setVolume(Number(e.target.value))}
        />
      </footer>

      {ghost && dragCount ? (
        <div className="ghost" style={{ left: ghost.x, top: ghost.y }}>
          {ghost.label}
          <span className="hint">hold ⇧ to move</span>
        </div>
      ) : null}

      {toast ? <div className={`toast ${toast.kind}`}>{toast.msg}</div> : null}

      {modal === "dupes" ? (
        <DuplicatesModal
          playlists={state.playlists} onClose={() => setModal(null)}
          onResolved={() => { void load(); setView({ kind: "trash" }); }} notify={show}
        />
      ) : null}
      {modal === "changes" ? <ChangesModal onClose={() => setModal(null)} notify={show} /> : null}
      {modal === "upstream" ? <UpstreamModal onClose={() => setModal(null)} notify={show} /> : null}
      {modal === "stores" ? <StoresModal onClose={() => setModal(null)} notify={show} /> : null}
      {modal === "ops" ? (
        <OpsModal onClose={() => setModal(null)} notify={show} onChange={() => void load()} />
      ) : null}
    </div>
  );
}

/**
 * Cover art comes from the track's YouTube thumbnail, cached server-side. A
 * track with no art falls back to its initial rather than a broken-image box.
 */
function Art({ id, label }: { id: number; label: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <span className="art ph">{label.slice(0, 1).toUpperCase()}</span>;
  return (
    <img
      className="art" src={`/api/art/${id}`} alt="" loading="lazy" decoding="async"
      draggable={false} onError={() => setFailed(true)}
    />
  );
}

function TrackRow({ track, showFolder, selected, playing, dragging, ...rest }: {
  track: Track; showFolder: boolean; selected: boolean; playing: boolean; dragging: boolean;
  onMouseDown: (e: React.MouseEvent) => void;
  onDoubleClick: () => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
}) {
  const title = track.title ?? track.filename;
  const sub = [track.artist, showFolder ? track.folder : null].filter(Boolean).join(" · ");
  return (
    <div
      className={`row ${selected ? "sel" : ""} ${playing ? "playing" : ""} ` +
        `${track.pendingDelete ? "del" : ""} ${dragging ? "dragging" : ""}`}
      draggable
      title={track.bitrate ? `${track.bitrate} kbps · ${track.ext}` : track.ext}
      {...rest}
    >
      <Art id={track.id} label={title} />
      <span className="meta2">
        <span className="t1">
          {title}
          {track.ext !== "m4a" ? <span className="tag bad">{track.ext}</span> : null}
        </span>
        <span className="t2">{sub || "—"}</span>
      </span>
      <span className="du">{fmtTime(track.duration)}</span>
    </div>
  );
}
