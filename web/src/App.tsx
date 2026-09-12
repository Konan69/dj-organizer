import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, unwrap, type State, type Track } from "./api";
import { ChangesModal, DuplicatesModal, UpstreamModal } from "./Modals";
import { OpsModal, StoresModal } from "./Stores";
import { fmtTime, useSelection, useToast, usePlayer } from "./hooks";

type View = { kind: "all" | "unfiled" | "trash" } | { kind: "pl"; id: number };
type SortKey = "artist" | "title" | "folder" | "duration" | "bitrate" | "size" | "added_at";
type Modal = null | "dupes" | "changes" | "upstream" | "stores" | "ops";
type Quality = "any" | "lossless" | "lossy";

type Filters = {
  folder: string;
  quality: Quality;
  dupes: boolean;
  staged: boolean;
  shared: boolean;
};

const NO_FILTERS: Filters = {
  folder: "", quality: "any", dupes: false, staged: false, shared: false,
};

const VIEW_TITLE: Record<string, string> = {
  all: "All tracks", unfiled: "Unfiled", trash: "Pending deletes",
};

const SORTS: [SortKey, string][] = [
  ["artist", "Artist"], ["title", "Title"], ["folder", "Folder"],
  ["duration", "Length"], ["bitrate", "Quality"], ["size", "File size"],
  ["added_at", "Recently added"],
];

/** Text reads best A–Z; numbers almost always read best biggest-first. */
const DESC_BY_DEFAULT = new Set<SortKey>(["duration", "bitrate", "size", "added_at"]);

const fmtSize = (n: number | null) =>
  n == null ? "—" : n >= 1 << 20 ? `${Math.round(n / (1 << 20))} MB` : `${Math.round(n / 1024)} KB`;

const MENU_W = 236;

type RowMenuState = {
  track: Track; ids: number[]; x: number; y: number; mode: "actions" | "playlists";
};

export function App() {
  const [state, setState] = useState<State | null>(null);
  const [view, setView] = useState<View>({ kind: "all" });
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "artist", dir: 1 });
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [modal, setModal] = useState<Modal>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [rowMenu, setRowMenu] = useState<RowMenuState | null>(null);
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
  const folders = useMemo(
    () => [...new Set(state?.tracks.map((t) => t.folder) ?? [])].filter(Boolean).sort(),
    [state],
  );
  const dupeIds = useMemo(() => new Set(state?.duplicateIds ?? []), [state]);

  /** Everything the view itself does not already decide. */
  const activeFilters =
    (filters.folder ? 1 : 0) + (filters.quality !== "any" ? 1 : 0) +
    (filters.dupes ? 1 : 0) + (filters.staged ? 1 : 0) + (filters.shared ? 1 : 0);

  const shown = useMemo(() => {
    if (!state) return [];
    let t = state.tracks;
    if (view.kind === "unfiled") t = t.filter((x) => x.playlists.length === 0);
    else if (view.kind === "trash") t = t.filter((x) => x.pendingDelete);
    else if (view.kind === "pl") t = t.filter((x) => x.playlists.includes(view.id));

    // Every term must match something, so "skrillex dnb" narrows instead of
    // returning everything by either word.
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length) {
      t = t.filter((x) => {
        const hay = `${x.title ?? ""} ${x.artist ?? ""} ${x.folder} ${x.filename}`.toLowerCase();
        return terms.every((w) => hay.includes(w));
      });
    }

    if (filters.folder) t = t.filter((x) => x.folder === filters.folder);
    if (filters.quality === "lossless") t = t.filter((x) => (x.bitrate ?? 0) > 400);
    if (filters.quality === "lossy") t = t.filter((x) => (x.bitrate ?? 0) <= 400);
    if (filters.dupes) t = t.filter((x) => dupeIds.has(x.id));
    if (filters.staged) t = t.filter((x) => x.pendingDelete);
    if (filters.shared) t = t.filter((x) => x.playlists.length > 1);

    const { key, dir } = sort;
    return [...t].sort((a, b) => {
      const x = a[key], y = b[key];
      if (key === "duration" || key === "bitrate" || key === "size" || key === "added_at") {
        return (((x as number) ?? 0) - ((y as number) ?? 0)) * dir;
      }
      return String(x ?? "").localeCompare(String(y ?? ""), undefined, { sensitivity: "base" }) * dir;
    });
  }, [state, view, query, sort, filters, dupeIds]);

  const selection = useSelection(shown);
  const { sel } = selection;
  /**
   * A selection outlives the filter that made it, so every bulk action works
   * from the visible intersection. Narrowing the list can only ever narrow
   * what a button is about to touch — never hide part of its blast radius.
   */
  const selected = useMemo(() => shown.filter((t) => sel.has(t.id)), [shown, sel]);
  const selIds = useMemo(() => selected.map((t) => t.id), [selected]);

  const activePl = view.kind === "pl" ? state?.playlists.find((p) => p.id === view.id) : undefined;

  /** What the view holds before search and filters cut it down. */
  const total = !state ? 0
    : view.kind === "unfiled" ? state.counts.unfiled
    : view.kind === "trash" ? state.counts.pendingDeletes
    : view.kind === "pl" ? activePl?.count ?? 0
    : state.counts.tracks;

  const openRowMenu = useCallback(
    (rect: DOMRect, track: Track, ids: number[], mode: "actions" | "playlists") => {
      setRowMenu({
        track, ids, mode,
        x: Math.max(8, Math.min(rect.right - MENU_W, window.innerWidth - MENU_W - 8)),
        y: Math.min(rect.bottom + 6, window.innerHeight - 340),
      });
    }, []);

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

  const removeFrom = (playlistId: number, ids: number[]) => {
    void run(async () => {
      const r = await unwrap(api.membership.post({ trackIds: ids, playlistId, op: "remove" }));
      selection.clear();
      return `Removed ${r.changed}`;
    });
  };

  const removeFromPlaylist = () => {
    if (view.kind !== "pl" || !selIds.length) return;
    removeFrom(view.id, selIds);
  };

  const addTo = (playlistId: number, ids: number[]) => {
    const name = state?.playlists.find((p) => p.id === playlistId)?.name ?? "";
    void run(async () => {
      const r = await unwrap(api.membership.post({ trackIds: ids, playlistId, op: "add" }));
      return r.changed ? `Added ${r.changed} → ${name}` : "Already in that playlist";
    });
  };

  /**
   * Row actions follow the selection when the row is part of it, and otherwise
   * act on just that row — so hovering a track you never selected can't quietly
   * operate on a dozen others.
   */
  const targetIds = useCallback(
    (id: number) => (sel.has(id) && selIds.length > 1 ? selIds : [id]),
    [sel, selIds],
  );

  const stageDeleteIds = (ids: number[]) => {
    void run(async () => {
      await unwrap(api.delete.post({ trackIds: ids }));
      return `${ids.length} staged — nothing deleted yet`;
    });
  };

  const undoDeleteIds = (ids: number[]) => {
    void run(async () => {
      await unwrap(api.delete.undo.post({ trackIds: ids }));
      return "Restored";
    });
  };

  const stageDelete = () => {
    const ids = selIds;
    if (!ids.length) return;
    void run(async () => {
      await unwrap(api.delete.post({ trackIds: ids }));
      selection.clear();
      return `${ids.length} staged — nothing deleted yet`;
    });
  };

  const undoDelete = () => {
    if (!selIds.length) return;
    void run(async () => {
      await unwrap(api.delete.undo.post({ trackIds: selIds }));
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
      if (el.tagName === "SELECT" || el.tagName === "BUTTON") {
        if (e.key !== "Escape") return;
      }
      if (modal) return;
      if (rowMenu) { if (e.key === "Escape") setRowMenu(null); return; }
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
      if ((e.key === "Delete" || e.key === "Backspace") && selIds.length) {
        e.preventDefault(); stageDelete();
      }
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
          {navItem("trash", view.kind === "trash", "✕", "Pending deletes",
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
              {shown.length === total ? `${total} tracks`
                : `${shown.length} of ${total}`}
              {activePl?.is_manual ? " · yours to curate" : ""}
            </span>
            <div className="spacer" />
            {selected.length ? (
              <>
                <span className="meta sel-n">{selected.length} selected</span>
                <button className="act" onClick={(e) =>
                  openRowMenu(e.currentTarget.getBoundingClientRect(), selected[0]!, selIds, "playlists")
                }>Add to…</button>
                {view.kind === "pl"
                  ? <button className="act" onClick={removeFromPlaylist}>Remove</button> : null}
                {view.kind === "trash"
                  ? <button className="act a" onClick={undoDelete}>Restore</button>
                  : <button className="act d" onClick={stageDelete}>Delete</button>}
              </>
            ) : null}
            {view.kind === "trash" && state.counts.pendingDeletes
              ? <button className="act" onClick={stageToPlan}>
                  Put {state.counts.pendingDeletes} on the fs plan
                </button> : null}
          </div>

          {/* Filters narrow what the sidebar already chose; sort stays pinned
              right so it never trades places with the selection buttons. */}
          <div className="fbar">
            <select
              className={`fsel ${filters.folder ? "on" : ""}`} value={filters.folder}
              onChange={(e) => setFilters((f) => ({ ...f, folder: e.target.value }))}
            >
              <option value="">Any folder</option>
              {folders.map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
            <select
              className={`fsel ${filters.quality !== "any" ? "on" : ""}`} value={filters.quality}
              onChange={(e) => setFilters((f) => ({ ...f, quality: e.target.value as Quality }))}
            >
              <option value="any">Any quality</option>
              <option value="lossless">Lossless only</option>
              <option value="lossy">Compressed only</option>
            </select>

            {([
              ["dupes", `Duplicates${state.counts.duplicates ? ` ${state.counts.duplicates}` : ""}`,
                "Redundant copies the app has matched by audio content"],
              ["shared", "In 2+ playlists", "Tracks filed in more than one playlist"],
              ["staged", "Staged to delete", "Tracks queued onto the fs plan"],
            ] as [keyof Filters, string, string][]).map(([k, label, hint]) => (
              <button
                key={k} title={hint}
                className={`chip ${filters[k] ? "on" : ""}`}
                onClick={() => setFilters((f) => ({ ...f, [k]: !f[k] }))}
              >{label}</button>
            ))}

            {webmShown ? (
              <button
                className="chip warn" onClick={() => setModal("dupes")}
                title={`${webmShown} WebM/Opus file(s) — Serato and rekordbox read neither, ` +
                  `and each already has a lossless .m4a twin here. Spare copies, not gaps.`}
              >{webmShown} webm</button>
            ) : null}

            {activeFilters || query ? (
              <button className="chip clear" onClick={() => { setFilters(NO_FILTERS); setQuery(""); }}>
                × Clear
              </button>
            ) : null}

            <div className="spacer" />
            <label className="sortsel">
              <select
                value={sort.key}
                onChange={(e) => {
                  const key = e.target.value as SortKey;
                  setSort({ key, dir: DESC_BY_DEFAULT.has(key) ? -1 : 1 });
                }}
              >
                {SORTS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
              </select>
              <button
                onClick={() => setSort((s) => ({ ...s, dir: s.dir === 1 ? -1 : 1 }))}
                title={sort.dir === 1 ? "Ascending" : "Descending"}
              >{sort.dir === 1 ? "↑" : "↓"}</button>
            </label>
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
                key={t.id} track={t} showFolder={view.kind !== "pl"} sortKey={sort.key}
                selected={sel.has(t.id)} playing={player.playingId === t.id}
                paused={player.paused} menuOpen={rowMenu?.track.id === t.id}
                dragging={dragCount > 0 && sel.has(t.id)}
                onMouseDown={(e) => selection.click(t.id, e)}
                onDoubleClick={() => player.play(t.id)}
                onDragStart={(e) => onDragStart(e, t.id)}
                onDragEnd={onDragEnd}
                onPlay={() => {
                  if (player.playingId === t.id) player.toggle();
                  else player.play(t.id);
                }}
                onAdd={(rect) => openRowMenu(rect, t, targetIds(t.id), "playlists")}
                onMore={(rect) => openRowMenu(rect, t, targetIds(t.id), "actions")}
                onDelete={() => (t.pendingDelete ? undoDeleteIds : stageDeleteIds)(targetIds(t.id))}
                onRemove={view.kind === "pl"
                  ? () => removeFrom(view.id, targetIds(t.id))
                  : undefined}
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

      {/* Pinned to the viewport, not to the row: the list scrolls and clips, and
          a menu that vanishes when you reach for it is worse than no menu. The
          playlist picker swaps in place rather than flying out sideways. */}
      {rowMenu ? (
        <>
          <div className="menuscrim" onClick={() => setRowMenu(null)} />
          <div className="menu float" style={{ left: rowMenu.x, top: rowMenu.y, width: MENU_W }}>
            {rowMenu.mode === "actions" ? (
              <>
                <div className="mhd">
                  {rowMenu.ids.length > 1
                    ? `${rowMenu.ids.length} tracks`
                    : rowMenu.track.title ?? rowMenu.track.filename}
                </div>
                <button onClick={() => {
                  const id = rowMenu.track.id;
                  if (player.playingId === id) player.toggle(); else player.play(id);
                  setRowMenu(null);
                }}>
                  {player.playingId === rowMenu.track.id && !player.paused ? "Pause" : "Play"}
                </button>
                <button onClick={() => setRowMenu({ ...rowMenu, mode: "playlists" })}>
                  Add to playlist…
                </button>
                {view.kind === "pl" && activePl ? (
                  <button onClick={() => { removeFrom(view.id, rowMenu.ids); setRowMenu(null); }}>
                    Remove from “{activePl.name}”
                  </button>
                ) : null}
                <div className="msep" />
                {rowMenu.track.video_id ? (
                  <button onClick={() => {
                    window.open(`https://www.youtube.com/watch?v=${rowMenu.track.video_id}`, "_blank");
                    setRowMenu(null);
                  }}>Open on YouTube</button>
                ) : null}
                <button onClick={() => {
                  void navigator.clipboard.writeText(rowMenu.track.path);
                  setRowMenu(null);
                  show("Path copied", "ok");
                }}>Copy file path</button>
                <div className="msep" />
                {rowMenu.track.pendingDelete ? (
                  <button className="good" onClick={() => { undoDeleteIds(rowMenu.ids); setRowMenu(null); }}>
                    Unstage delete
                  </button>
                ) : (
                  <button className="bad" onClick={() => { stageDeleteIds(rowMenu.ids); setRowMenu(null); }}>
                    Stage delete
                  </button>
                )}
              </>
            ) : (
              <>
                <div className="mhd">
                  <button className="back" onClick={() => setRowMenu({ ...rowMenu, mode: "actions" })}>‹</button>
                  Add {rowMenu.ids.length > 1 ? `${rowMenu.ids.length} tracks` : "track"} to
                </div>
                <div className="mlist">
                  {state.playlists.map((p) => {
                    const already = rowMenu.ids.every((id) =>
                      state.tracks.find((t) => t.id === id)?.playlists.includes(p.id));
                    return (
                      <button
                        key={p.id} disabled={already}
                        onClick={() => { addTo(p.id, rowMenu.ids); setRowMenu(null); }}
                      >
                        <span className="ic">{p.is_manual ? "★" : ""}</span>
                        <span className="nm">{p.name}</span>
                        <span className="ct">{already ? "✓" : p.count}</span>
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        </>
      ) : null}

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

/**
 * Actions sit in a column that is always there and merely fades in, so the row
 * never reflows under the cursor and the buttons stay exactly where the eye
 * last saw them. They are inside the row, so reaching for one keeps :hover.
 */
function TrackRow({
  track, showFolder, sortKey, selected, playing, paused, menuOpen, dragging,
  onPlay, onAdd, onMore, onDelete, onRemove, ...rest
}: {
  track: Track; showFolder: boolean; sortKey: SortKey;
  selected: boolean; playing: boolean; paused: boolean; menuOpen: boolean; dragging: boolean;
  onPlay: () => void;
  onAdd: (rect: DOMRect) => void;
  onMore: (rect: DOMRect) => void;
  onDelete: () => void;
  /** Only inside a playlist, where unfiling beats deleting. */
  onRemove?: () => void;
  onMouseDown: (e: React.MouseEvent) => void;
  onDoubleClick: () => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
}) {
  const title = track.title ?? track.filename;
  const sub = [track.artist, showFolder ? track.folder : null].filter(Boolean).join(" · ");

  // The trailing column answers whatever you sorted by, so the ordering is
  // legible instead of mysterious.
  const trail = sortKey === "size" ? fmtSize(track.size)
    : sortKey === "bitrate" ? (track.bitrate ? `${track.bitrate}k` : "—")
    : fmtTime(track.duration);

  // A click on an action must not also re-select the row underneath it.
  const act = (fn: (r: DOMRect) => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    fn(e.currentTarget.getBoundingClientRect());
  };

  return (
    <div
      className={`row ${selected ? "sel" : ""} ${playing ? "playing" : ""} ` +
        `${track.pendingDelete ? "del" : ""} ${dragging ? "dragging" : ""} ` +
        `${menuOpen ? "menuon" : ""}`}
      draggable
      title={`${track.bitrate ? `${track.bitrate} kbps · ` : ""}${track.ext} · ${fmtSize(track.size)}`}
      {...rest}
    >
      <span className="artwrap" onClick={(e) => { e.stopPropagation(); onPlay(); }}>
        <Art id={track.id} label={title} />
        <span className="artplay">{playing && !paused ? "❚❚" : "▶"}</span>
      </span>

      <span className="meta2">
        <span className="t1">
          {title}
          {track.ext !== "m4a" ? <span className="tag bad">{track.ext}</span> : null}
          {(track.bitrate ?? 0) > 400 ? <span className="tag good">lossless</span> : null}
        </span>
        <span className="t2">{sub || "—"}</span>
      </span>

      {/* Two shortcuts and a menu. In a playlist the useful second action is
          unfiling, not deleting — deleting is still one step away under ⋯. */}
      <span className="acts" draggable={false} onDragStart={(e) => e.preventDefault()}>
        <button title="Add to playlist…" onClick={act(onAdd)}>＋</button>
        {onRemove ? (
          <button
            className="bad" title="Remove from this playlist"
            onClick={(e) => { e.stopPropagation(); onRemove(); }}
          >−</button>
        ) : (
          <button
            className={track.pendingDelete ? "good" : "bad"}
            title={track.pendingDelete ? "Unstage delete" : "Stage delete"}
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
          >{track.pendingDelete ? "↺" : "✕"}</button>
        )}
        <button title="More…" onClick={act(onMore)}>⋯</button>
      </span>

      <span className="du">{trail}</span>
    </div>
  );
}
