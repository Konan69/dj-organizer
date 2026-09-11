import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, unwrap, type State, type Track } from "./api";
import { ChangesModal, DuplicatesModal, UpstreamModal } from "./Modals";
import { OpsModal, StoresModal } from "./Stores";
import { fmtTime, useSelection, useToast, usePlayer } from "./hooks";

type View = { kind: "all" | "unfiled" | "trash" } | { kind: "pl"; id: number };
type SortKey = "title" | "artist" | "folder" | "duration" | "bitrate";
type Modal = null | "dupes" | "changes" | "upstream" | "stores" | "ops";

const VIEW_TITLE: Record<string, string> = {
  all: "All tracks", unfiled: "Unfiled", trash: "Pending deletes",
};

export function App() {
  const [state, setState] = useState<State | null>(null);
  const [view, setView] = useState<View>({ kind: "all" });
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "artist", dir: 1 });
  const [modal, setModal] = useState<Modal>(null);
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

  const applyDeletes = () => {
    const n = state?.counts.pendingDeletes ?? 0;
    if (!n) return;
    if (!window.confirm(
      `Move ${n} file(s) to _TRASH?\n\nFiles are moved, never erased — recover them from:\n${state?.trash}`,
    )) return;
    void run(async () => {
      const r = await unwrap(api.delete.apply.post());
      return `${r.moved} moved to _TRASH${r.errors.length ? ` · ${r.errors.length} errors` : ""}`;
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
        <button className="pill" onClick={() => setModal("upstream")}>⇅ Upstream</button>
        <button className="pill" onClick={() => setModal("stores")} title="rekordbox · Serato · filesystem">
          ◫ Stores
        </button>
        <button className={`pill ${state.ops.open ? "dirty" : ""}`} onClick={() => setModal("ops")}>
          <span className="led" />
          {state.ops.open ? `${state.ops.open} staged` : "No changes"}
        </button>
        <button className="pill" onClick={() => setModal("changes")}>Changeset</button>
      </header>

      <div className="body">
        <aside>
          <div className="sec">Library</div>
          {navItem("all", view.kind === "all", "≡", "All tracks", state.counts.tracks,
            { onClick: () => setView({ kind: "all" }) })}
          {navItem("unfiled", view.kind === "unfiled", "◇", "Unfiled", state.counts.unfiled || "",
            { onClick: () => setView({ kind: "unfiled" }), cls: state.counts.unfiled ? "warn" : "" })}
          {navItem("dupes", false, "⧉", "Duplicates", state.counts.duplicates || "",
            { onClick: () => setModal("dupes"), cls: state.counts.duplicates ? "warn" : "" })}

          <div className="sec">
            Playlists
            <button onClick={newPlaylist} title="New playlist">+</button>
          </div>
          {state.playlists.map((p) =>
            navItem(`pl${p.id}`, view.kind === "pl" && view.id === p.id,
              p.is_manual ? "★" : "♪", p.name, p.count, {
                onClick: () => setView({ kind: "pl", id: p.id }),
                drop: () => dropOnPlaylist(p.id),
                dropKey: p.id,
                cls: p.is_manual ? "lock" : "",
              }))}

          <div className="sec">Staged</div>
          {navItem("trash", view.kind === "trash", "⌫", "Pending deletes",
            state.counts.pendingDeletes || "", {
              onClick: () => setView({ kind: "trash" }),
              drop: dropOnTrash,
              dropKey: "trash",
              cls: state.counts.pendingDeletes ? "dngr" : "",
            })}
        </aside>

        <main>
          <div className="bar">
            <h2>{activePl ? activePl.name : VIEW_TITLE[view.kind]}</h2>
            <span className="meta">
              {shown.length} track{shown.length === 1 ? "" : "s"}
              {activePl?.is_manual ? " · manually curated" : ""}
              {webmShown ? ` · ${webmShown} not DJ-readable` : ""}
            </span>
            <div className="spacer" />
            {sel.size ? <span className="meta">{sel.size} selected</span> : null}
            {sel.size && view.kind === "pl"
              ? <button className="act" onClick={removeFromPlaylist}>Remove from playlist</button> : null}
            {sel.size && view.kind !== "trash"
              ? <button className="act d" onClick={stageDelete}>Delete</button> : null}
            {sel.size && view.kind === "trash"
              ? <button className="act a" onClick={undoDelete}>Restore</button> : null}
            {view.kind === "trash" && state.counts.pendingDeletes
              ? <button className="act d" onClick={applyDeletes}>
                  Apply {state.counts.pendingDeletes} delete{state.counts.pendingDeletes === 1 ? "" : "s"} → _TRASH
                </button> : null}
          </div>

          <div className="head">
            <span />
            {([["title", "Title", ""], ["artist", "Artist", ""], ["folder", "Folder", ""],
              ["duration", "Time", "r"], ["bitrate", "Rate", "r"]] as const).map(([k, label, cls]) => (
              <button
                key={k} className={cls}
                onClick={() => setSort((s) => ({ key: k, dir: s.key === k ? (s.dir === 1 ? -1 : 1) : 1 }))}
              >
                {label}{sort.key === k ? (sort.dir === 1 ? " ↑" : " ↓") : ""}
              </button>
            ))}
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
                  : view.kind === "trash" ? "Select tracks and hit Delete to stage them."
                  : "Drag tracks here from another playlist."}
              </div>
            ) : shown.map((t, i) => (
              <TrackRow
                key={t.id} track={t} index={i}
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

function TrackRow({ track, index, selected, playing, dragging, ...rest }: {
  track: Track; index: number; selected: boolean; playing: boolean; dragging: boolean;
  onMouseDown: (e: React.MouseEvent) => void;
  onDoubleClick: () => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
}) {
  return (
    <div
      className={`row ${selected ? "sel" : ""} ${playing ? "playing" : ""} ` +
        `${track.pendingDelete ? "del" : ""} ${dragging ? "dragging" : ""}`}
      draggable
      {...rest}
    >
      <span className="n">{index + 1}</span>
      <span className="ti">
        {track.title ?? track.filename}
        {track.ext !== "m4a" ? <span className="tag bad">{track.ext}</span> : null}
      </span>
      <span>{track.artist ?? "—"}</span>
      <span className="fo">{track.folder || "—"}</span>
      <span className="du">{fmtTime(track.duration)}</span>
      <span className="br">{track.bitrate ? `${track.bitrate}k` : "—"}</span>
    </div>
  );
}
