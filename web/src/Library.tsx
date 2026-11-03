/**
 * The library: collections and playlists on the left, the track table on the
 * right. Everything that reads or files tracks lives here; the shell only
 * mounts it and hands over state, the preview player and the toast.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { api, unwrap, type State, type Track } from "./api";
import { useSelection, type usePlayer } from "./hooks";
import { fmtBpm, parseKey } from "./keys";
import { DuplicatesModal, EditTrackModal, TrackHistoryModal } from "./Modals";
import { useSet } from "./setStore";
import {
  AddButton, Art, EmptyState, Icon, KeyBadge, MenuItem, PlayButton, Popover, Segmented,
  fmtLength, fmtTotal, type IconName,
} from "./ui";
import "./library.css";

export type LibraryProps = {
  state: State;
  reload: () => Promise<void>;
  player: ReturnType<typeof usePlayer>;
  notify: (msg: string, kind?: "" | "ok" | "err") => void;
  /** Only the visible view binds keyboard shortcuts and autoplay. */
  active: boolean;
};

type View = { kind: "all" | "unfiled" | "trash" | "fav" } | { kind: "pl"; id: number };
type SortKey = "artist" | "title" | "folder" | "duration" | "bitrate" | "size" | "added_at" | "key" | "bpm";
type Quality = "any" | "lossless" | "lossy";
type Mode = "compact" | "list" | "grid";
/** What the length column shows: sorting by size or quality swaps it in. */
type Metric = "length" | "size" | "bitrate";
type Align = "start" | "end";

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

const VIEW_TITLE = {
  all: "All tracks", unfiled: "Unfiled", trash: "Pending deletes", fav: "Favourites",
} as const;

const SORTS: [SortKey, string][] = [
  ["artist", "By artist"], ["title", "By title"],
  ["duration", "By length"], ["key", "By key"], ["bpm", "By BPM"],
  ["bitrate", "By quality"], ["size", "By file size"], ["added_at", "By date added"],
];

/**
 * Text reads best A–Z; numbers almost always read best biggest-first. Key and
 * BPM are the exception: they read like the Camelot wheel and a tempo ramp,
 * lowest first.
 */
const DESC_BY_DEFAULT = new Set<SortKey>(["duration", "bitrate", "size", "added_at"]);

const MODE_KEY = "dj-organizer:library-mode";
const MODES: { value: Mode; label: string; icon: IconName }[] = [
  { value: "compact", label: "Compact", icon: "list" },
  { value: "list", label: "List", icon: "rows" },
  { value: "grid", label: "Grid", icon: "grid" },
];

const readMode = (): Mode => {
  const saved = localStorage.getItem(MODE_KEY);
  return saved === "compact" || saved === "grid" ? saved : "list";
};

const fmtSize = (n: number | null) =>
  n == null ? "—" : n >= 1 << 20 ? `${Math.round(n / (1 << 20))} MB` : `${Math.round(n / 1024)} KB`;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Camelot order: 1A, 1B, 2A … 12B. An unknown key has no rank. */
const keyRank = (raw: string | null | undefined) => {
  const k = parseKey(raw);
  return k ? k.num * 2 + (k.letter === "B" ? 1 : 0) : null;
};

const titleOf = (t: Track) => t.title ?? t.filename;

/**
 * File details that used to be row badges. They now live in the title tooltip
 * and the menu header, so a row stays one calm line of music.
 */
const flagsOf = (t: Track) =>
  [(t.bitrate ?? 0) > 400 ? "Lossless" : null, t.edited ? "Edited" : null].filter(Boolean).join(" · ");

const detailsOf = (t: Track) => [
  flagsOf(t),
  [t.bitrate ? `${t.bitrate} kbps` : null, t.ext].filter(Boolean).join(" "),
  fmtSize(t.size),
].filter(Boolean).join(" · ");

const tooltipOf = (t: Track) =>
  [titleOf(t), t.artist, t.folder, detailsOf(t)].filter(Boolean).join("\n");

/** Row handlers live in a ref so memoised rows never re-render for them. */
type RowHandlers = {
  press: (id: number, e: React.MouseEvent) => void;
  restart: (id: number) => void;
  toggle: (id: number) => void;
  add: (id: number) => void;
  menu: (track: Track, anchor: DOMRect, align: Align) => void;
  dragStart: (id: number, e: React.DragEvent) => void;
  dragEnd: () => void;
};

type RowMenu = {
  track: Track; ids: number[]; anchor: DOMRect; align: Align; mode: "actions" | "playlists";
};
type PlaylistMenu = { id: number; name: string; anchor: DOMRect };
type Ghost = { x: number; y: number; label: string; canMove: boolean };

const MENU_ITEMS = "[role^='menuitem']:not(:disabled)";

/** Arrow keys walk a menu, as they do in every native one. */
const menuKeys = (e: React.KeyboardEvent<HTMLElement>) => {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
  if (e.target instanceof HTMLInputElement && (e.key === "Home" || e.key === "End")) return;
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>(MENU_ITEMS)];
  if (!items.length) return;
  e.preventDefault();
  const i = items.indexOf(document.activeElement as HTMLElement);
  const next = e.key === "Home" ? 0
    : e.key === "End" ? items.length - 1
    : e.key === "ArrowDown" ? (i + 1) % items.length
    : (i - 1 + items.length) % items.length;
  items[next]!.focus();
};

/** Anchor for a context menu: the cursor, or the element when opened from the keyboard. */
const contextAnchor = (e: React.MouseEvent) =>
  e.clientX || e.clientY
    ? new DOMRect(e.clientX, e.clientY, 0, 0)
    : e.currentTarget.getBoundingClientRect();

export function Library({ state, reload, player, notify, active }: LibraryProps) {
  const [view, setView] = useState<View>({ kind: "all" });
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "artist", dir: 1 });
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [mode, setModeState] = useState<Mode>(readMode);
  const [rowMenu, setRowMenu] = useState<RowMenu | null>(null);
  const [plMenu, setPlMenu] = useState<PlaylistMenu | null>(null);
  /** Targets ticked in the playlist picker, so one trip can hit several. */
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [pickQ, setPickQ] = useState("");
  const [editTrack, setEditTrack] = useState<Track | null>(null);
  const [histTrack, setHistTrack] = useState<Track | null>(null);
  const [dupesOpen, setDupesOpen] = useState(false);
  const [dragCount, setDragCount] = useState(0);
  const [dropTarget, setDropTarget] = useState<number | "trash" | null>(null);
  // A playlist being dragged to a new place in the sidebar, and where it would land.
  const plDrag = useRef<number | null>(null);
  const [plOver, setPlOver] = useState<{ id: number; after: boolean } | null>(null);
  const [ghost, setGhost] = useState<Ghost | null>(null);
  /** The row the keyboard is on: the one tab stop inside the list. */
  const [cursorId, setCursorId] = useState<number | null>(null);

  const set = useSet();
  const { inSet, facts } = set;
  const setReady = set.ready;
  const setName = set.draft.name?.trim() || "your set";

  const searchRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const dragIds = useRef<number[]>([]);
  const shiftDrop = useRef(false);
  const activeRef = useRef(active);
  const returnFocus = useRef<HTMLElement | null>(null);

  const setMode = (m: Mode) => {
    setModeState(m);
    localStorage.setItem(MODE_KEY, m);
  };

  /* ---------- derived list ---------- */
  const folders = useMemo(
    () => [...new Set(state.tracks.map((t) => t.folder))].filter(Boolean).sort(),
    [state.tracks],
  );
  const dupeIds = useMemo(() => new Set(state.duplicateIds), [state.duplicateIds]);
  const trackById = useMemo(() => new Map(state.tracks.map((t) => [t.id, t])), [state.tracks]);

  /** Everything the view itself does not already decide. */
  const activeFilters =
    (filters.folder ? 1 : 0) + (filters.quality !== "any" ? 1 : 0) +
    (filters.dupes ? 1 : 0) + (filters.staged ? 1 : 0) + (filters.shared ? 1 : 0);
  const narrowed = activeFilters > 0 || query.trim() !== "";

  const shown = useMemo(() => {
    let t = state.tracks;
    if (view.kind === "unfiled") t = t.filter((x) => x.playlists.length === 0);
    else if (view.kind === "trash") t = t.filter((x) => x.pendingDelete);
    else if (view.kind === "fav") t = t.filter((x) => x.favorite);
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
    if (key === "key" || key === "bpm") {
      const value = (x: Track) =>
        key === "bpm" ? facts.get(x.id)?.bpm ?? null : keyRank(facts.get(x.id)?.key);
      // Unknowns sink either way: a column of dashes at the top of a BPM sort
      // hides the answer you sorted for.
      return [...t].sort((a, b) => {
        const x = value(a), y = value(b);
        if (x == null || y == null) return x == null ? (y == null ? 0 : 1) : -1;
        return (x - y) * dir;
      });
    }
    return [...t].sort((a, b) => {
      const x = a[key], y = b[key];
      if (key === "duration" || key === "bitrate" || key === "size" || key === "added_at") {
        return (((x as number) ?? 0) - ((y as number) ?? 0)) * dir;
      }
      return String(x ?? "").localeCompare(String(y ?? ""), undefined, { sensitivity: "base" }) * dir;
    });
  }, [state.tracks, view, query, sort, filters, dupeIds, facts]);

  const selection = useSelection(shown);
  const { sel } = selection;
  /**
   * A selection outlives the filter that made it, so every bulk action works
   * from the visible intersection. Narrowing the list can only ever narrow
   * what a button is about to touch — never hide part of its blast radius.
   */
  const selected = useMemo(() => shown.filter((t) => sel.has(t.id)), [shown, sel]);
  const selIds = useMemo(() => selected.map((t) => t.id), [selected]);

  const activePl = view.kind === "pl" ? state.playlists.find((p) => p.id === view.id) : undefined;

  /** What the view holds before search and filters cut it down. */
  const total = view.kind === "unfiled" ? state.counts.unfiled
    : view.kind === "trash" ? state.counts.pendingDeletes
    : view.kind === "fav" ? state.counts.favorites
    : view.kind === "pl" ? activePl?.count ?? 0
    : state.counts.tracks;

  const seconds = useMemo(() => shown.reduce((s, t) => s + (t.duration ?? 0), 0), [shown]);

  /* ---------- menus ---------- */
  const openRowMenu = useCallback(
    (anchor: DOMRect, align: Align, track: Track, ids: number[], mode: RowMenu["mode"]) => {
      setPicked(new Set());
      setPickQ("");
      setRowMenu({ track, ids, anchor, align, mode });
    }, []);
  const closeRowMenu = useCallback(() => setRowMenu(null), []);
  const closePlMenu = useCallback(() => setPlMenu(null), []);

  /** A fresh rect makes the popover re-measure for the taller picker. */
  const switchMenu = (mode: RowMenu["mode"]) =>
    setRowMenu((m) => (m ? { ...m, mode, anchor: DOMRect.fromRect(m.anchor) } : m));

  /*
   * Menus take focus when they open and hand it back when they close, so a
   * keyboard user lands where they started.
   */
  const menuKey = rowMenu ? `${rowMenu.mode}:${rowMenu.track.id}` : plMenu ? `pl:${plMenu.id}` : null;
  useEffect(() => {
    if (!menuKey) {
      const back = returnFocus.current;
      returnFocus.current = null;
      if (back?.isConnected) back.focus({ preventScroll: true });
      return;
    }
    if (!returnFocus.current) returnFocus.current = document.activeElement as HTMLElement | null;
    // The picker opens on its search box, so typing finds a playlist at once.
    const pop = document.querySelector<HTMLElement>(".ui-pop");
    const first = pop?.querySelector<HTMLElement>(".lib-pick-search input")
      ?? pop?.querySelector<HTMLElement>(MENU_ITEMS);
    first?.focus({ preventScroll: true });
  }, [menuKey]);

  /* ---------- mutations ---------- */
  const run = useCallback(async (fn: () => Promise<string | void>) => {
    try {
      const msg = await fn();
      await reload();
      if (msg) notify(msg, "ok");
    } catch (e) { notify((e as Error).message, "err"); }
  }, [reload, notify]);

  const newPlaylist = () => {
    const name = window.prompt("New playlist name")?.trim();
    if (!name) return;
    void run(async () => {
      await unwrap(api.playlist.post({ name }));
      return `Created “${name}”`;
    });
  };

  const renamePlaylist = (id: number, current: string) => {
    const name = window.prompt("Rename playlist", current)?.trim();
    if (!name || name === current) return;
    void run(async () => {
      await unwrap(api.playlist({ id: String(id) }).patch({ name }));
      return `Renamed to “${name}”`;
    });
  };

  /** Drops the grouping, never the music — the files are untouched. */
  const reorderPlaylists = (from: number, to: number, after: boolean) => {
    if (from === to) return;
    const ids = state.playlists.map((p) => p.id).filter((id) => id !== from);
    ids.splice(ids.indexOf(to) + (after ? 1 : 0), 0, from);
    void run(async () => { await unwrap(api.playlists.order.post({ ids })); });
  };

  const deletePlaylist = (id: number, name: string) => {
    if (!window.confirm(`Delete the playlist “${name}”?\n\nThe tracks stay on disk.`)) return;
    void run(async () => {
      await unwrap(api.playlist({ id: String(id) }).delete());
      if (view.kind === "pl" && view.id === id) setView({ kind: "all" });
      return `Deleted “${name}”`;
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

  /** Silent on purpose — a star is feedback enough, and a toast per tap nags. */
  const toggleFavorite = (t: Track) => {
    void run(async () => {
      await unwrap(api.track({ id: String(t.id) }).favorite.post({ on: !t.favorite }));
    });
  };

  const saveMeta = (t: Track, title: string | null, artist: string | null) => {
    void run(async () => {
      await unwrap(api.track({ id: String(t.id) }).patch({ title, artist }));
      return "Saved — the file itself is untouched";
    });
  };

  /** Copy leaves the originals filed where they were; move does not. */
  const copyTo = (targets: number[], ids: number[]) => {
    void run(async () => {
      let n = 0;
      for (const pid of targets) {
        n += (await unwrap(api.membership.post({ trackIds: ids, playlistId: pid, op: "add" }))).changed;
      }
      return `Copied into ${plural(targets.length, "playlist")} (${n} added)`;
    });
  };

  const moveTo = (targets: number[], ids: number[], from: number) => {
    const fromName = state.playlists.find((p) => p.id === from)?.name ?? "";
    void run(async () => {
      for (const pid of targets) {
        await unwrap(api.membership.post({ trackIds: ids, playlistId: pid, op: "add" }));
      }
      // Only drop the source after every target has it — a failure part-way
      // through must never leave a track filed nowhere.
      await unwrap(api.membership.post({ trackIds: ids, playlistId: from, op: "remove" }));
      selection.clear();
      return `Moved out of “${fromName}” into ${plural(targets.length, "playlist")}`;
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
      return `${plural(ids.length, "track")} marked for deletion — nothing deleted yet`;
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
      return `${plural(ids.length, "track")} marked for deletion — nothing deleted yet`;
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
    const n = state.counts.pendingDeletes;
    if (!n) return;
    void run(async () => {
      const r = await unwrap(api.delete.stage.post());
      window.open("/api/plan/fs/text", "_blank");
      return `${plural(r.staged, "track")} on the file plan — nothing was moved`;
    });
  };

  /** The set is a running order, so adding never duplicates; say what really changed. */
  const addToSet = (ids: number[]) => {
    const fresh = ids.filter((id) => !inSet.has(id)).length;
    set.addMany(ids);
    notify(fresh ? `Added ${plural(fresh, "track")} to ${setName}` : `Already in ${setName}`, fresh ? "ok" : "");
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
    const name = state.playlists.find((p) => p.id === targetId)?.name ?? "";
    void run(async () => {
      if (moving) {
        const r = await unwrap(api.move.post({
          trackIds: ids, fromPlaylistId: from, toPlaylistId: targetId,
        }));
        return `Moved ${plural(r.added, "track")} to “${name}”`;
      }
      const r = await unwrap(api.membership.post({
        trackIds: ids, playlistId: targetId, op: "add",
      }));
      return r.changed ? `Added ${plural(r.changed, "track")} to “${name}”` : "Already in that playlist";
    });
  };

  const dropOnTrash = () => {
    const ids = dragIds.current;
    if (!ids.length) return;
    void run(async () => {
      await unwrap(api.delete.post({ trackIds: ids }));
      return `${plural(ids.length, "track")} marked for deletion — nothing deleted yet`;
    });
  };

  /* ---------- keyboard ---------- */
  const rowEl = (id: number) =>
    listRef.current?.querySelector<HTMLElement>(`[data-track-id="${id}"]`) ?? null;

  /**
   * Moves the keyboard cursor; Shift extends the selection from its anchor.
   * With no cursor yet, a step lands on the first row and a jump (Home/End)
   * goes where it says.
   */
  const step = (to: (i: number) => number, extend: boolean, jump: boolean) => {
    if (!shown.length) return;
    const from = shown.findIndex((t) => t.id === (cursorId ?? selIds[0]));
    const i = Math.max(0, Math.min(shown.length - 1, from < 0 && !jump ? 0 : to(Math.max(from, 0))));
    const id = shown[i]!.id;
    setCursorId(id);
    if (extend) selection.click(id, { shiftKey: true, metaKey: false, ctrlKey: false });
    else selection.replace(id);
    const el = rowEl(id);
    el?.scrollIntoView({ block: "nearest" });
    el?.focus({ preventScroll: true });
  };

  const gridColumns = () => {
    const grid = listRef.current;
    return mode === "grid" && grid
      ? getComputedStyle(grid).gridTemplateColumns.split(" ").length : 1;
  };

  useEffect(() => {
    if (!active) return;
    const h = (e: KeyboardEvent) => {
      // A widget that already handled the key (the seek slider's Home/End) keeps it.
      if (e.defaultPrevented) return;
      const el = e.target as HTMLElement;
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable) { if (e.key === "Escape") el.blur(); return; }
      if (el.tagName === "SELECT" && e.key !== "Escape") return;
      // A focused button keeps its own Space and Enter.
      if (el.tagName === "BUTTON" && (e.key === " " || e.key === "Enter")) return;
      // Modals own the keyboard while they are open, including the shell's
      // (Changes, Duplicates…): Backspace in one must not stage the selection behind it.
      if (editTrack || histTrack || dupesOpen || el.closest?.("[aria-modal='true']")) return;
      if (rowMenu || plMenu) {
        if (e.key === "Escape") { setRowMenu(null); setPlMenu(null); }
        return;
      }
      if (e.key === "/") { e.preventDefault(); searchRef.current?.focus(); return; }
      if (e.key === "Escape") { selection.clear(); return; }
      if ((e.metaKey || e.ctrlKey) && e.key === "a") { e.preventDefault(); selection.selectAll(); return; }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === " ") {
        e.preventDefault();
        const first = selIds[0];
        if (first != null && first !== player.playingId) player.play(first);
        else player.toggle();
        return;
      }
      if ((e.key === "Delete" || e.key === "Backspace") && selIds.length) {
        e.preventDefault(); stageDelete();
        return;
      }
      // Walking the list only happens from the list or from nowhere, so other
      // widgets keep their own arrows. The menu key needs nothing here: the
      // browser fires contextmenu on the focused row.
      if (el !== document.body && !el.closest(".lib")) return;
      if (e.key === "Enter") {
        const id = cursorId ?? selIds[0];
        if (id != null) { e.preventDefault(); player.play(id); }
        return;
      }
      const cols = gridColumns();
      const moves: Record<string, (i: number) => number> = {
        ArrowDown: (i) => i + cols, ArrowUp: (i) => i - cols,
        Home: () => 0, End: () => shown.length - 1,
        ...(mode === "grid" ? { ArrowRight: (i: number) => i + 1, ArrowLeft: (i: number) => i - 1 } : {}),
      };
      const move = moves[e.key];
      if (move) { e.preventDefault(); step(move, e.shiftKey, e.key === "Home" || e.key === "End"); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  });

  useEffect(() => { activeRef.current = active; }, [active]);

  // One onended slot is shared by every view; the callback checks it is still
  // the visible one before moving on.
  const { playingId, play, onEnded } = player;
  useEffect(() => {
    if (!active) return;
    onEnded(() => {
      if (!activeRef.current) return;
      const i = shown.findIndex((t) => t.id === playingId);
      const next = shown[i + 1];
      if (next) play(next.id);
    });
  }, [shown, playingId, play, onEnded, active]);

  useEffect(() => { scrollRef.current?.scrollTo({ top: 0 }); }, [view]);

  /*
   * One tab stop inside the list: the cursor row and its buttons. Every other
   * row's buttons leave the tab order, so Tab crosses 800 tracks in one press
   * and arrows do the walking. The shared buttons take no tabIndex prop, so
   * this is set on the DOM directly.
   */
  const tabId = cursorId != null && shown.some((t) => t.id === cursorId) ? cursorId : shown[0]?.id ?? null;
  useLayoutEffect(() => {
    const root = listRef.current;
    if (!root) return;
    for (const row of root.querySelectorAll<HTMLElement>("[data-track-id]")) {
      const on = row.dataset.trackId === String(tabId);
      for (const b of row.querySelectorAll<HTMLElement>("button")) b.tabIndex = on ? 0 : -1;
    }
  }, [tabId, shown, mode, inSet, setReady]);

  /* ---------- row wiring ---------- */
  const rowHandlers: RowHandlers = {
    press: (id, e) => { setCursorId(id); selection.click(id, e); },
    restart: (id) => player.play(id),
    toggle: (id) => { if (player.playingId === id) player.toggle(); else player.play(id); },
    add: (id) => set.add(id),
    menu: (track, anchor, align) => openRowMenu(anchor, align, track, targetIds(track.id), "actions"),
    dragStart: (id, e) => onDragStart(e, id),
    dragEnd: onDragEnd,
  };
  const handlers = useRef(rowHandlers);
  useLayoutEffect(() => { handlers.current = rowHandlers; });

  /**
   * Reaching for a filter drops you out of a playlist. Otherwise you are
   * narrowing inside a selection you can no longer see, and the usual result
   * is an empty list with no obvious cause.
   */
  const applyFilter = (fn: (f: Filters) => Filters) => {
    setFilters(fn);
    if (view.kind === "pl") setView({ kind: "all" });
  };
  const clearFilters = () => { setFilters(NO_FILTERS); setQuery(""); };

  const sortBy = (key: SortKey) =>
    setSort((s) => (s.key === key
      ? { key, dir: s.dir === 1 ? -1 : 1 }
      : { key, dir: DESC_BY_DEFAULT.has(key) ? -1 : 1 }));

  const webmShown = shown.filter((t) => t.ext !== "m4a").length;
  const showFolder = view.kind !== "pl";
  const metric: Metric = sort.key === "size" ? "size" : sort.key === "bitrate" ? "bitrate" : "length";
  const title = activePl ? activePl.name : view.kind === "pl" ? "Playlist" : VIEW_TITLE[view.kind];
  const countText = shown.length === total ? plural(total, "track") : `${shown.length} of ${plural(total, "track")}`;

  /* ---------- rail ---------- */
  const railItem = (key: string, o: {
    active: boolean; icon: IconName; label: string; count: number | null;
    tone?: "warn" | "danger"; hint?: string; onClick: () => void;
    dropKey?: number | "trash"; onDrop?: () => void; onContext?: (e: React.MouseEvent) => void;
    reorderId?: number;
  }) => {
    const dropping = o.dropKey != null && dropTarget === o.dropKey;
    const ins = o.reorderId != null && plOver?.id === o.reorderId ? (plOver.after ? "ins-after" : "ins-before") : "";
    const rid = o.reorderId;
    return (
      <button
        key={key} type="button" title={o.hint ?? (o.label.length > 22 ? o.label : undefined)}
        className={`lib-nav ${o.active ? "active" : ""} ${dropping ? "drop" : ""} ${ins}`}
        aria-current={o.active ? "page" : undefined}
        onClick={o.onClick}
        onContextMenu={o.onContext}
        draggable={rid != null}
        onDragStart={rid != null ? (e) => {
          plDrag.current = rid;
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", o.label);
        } : undefined}
        onDragEnd={rid != null ? () => { plDrag.current = null; setPlOver(null); } : undefined}
        onDragOver={o.onDrop || rid != null ? (e) => {
          if (plDrag.current != null) {
            if (rid == null) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            const r = e.currentTarget.getBoundingClientRect();
            const after = e.clientY > r.top + r.height / 2;
            if (plOver?.id !== rid || plOver.after !== after) setPlOver({ id: rid, after });
            return;
          }
          if (!o.onDrop) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = shiftDrop.current ? "move" : "copy";
          if (o.dropKey != null) setDropTarget(o.dropKey);
          const canMove = o.dropKey !== "trash" && view.kind === "pl" && view.id !== o.dropKey;
          const n = plural(dragCount, "track");
          setGhost({
            x: e.clientX + 14, y: e.clientY + 14, canMove,
            label: o.dropKey === "trash" ? `Mark ${n} for deletion`
              : `${canMove && shiftDrop.current ? "Move" : "Add"} ${n} to ${o.label}`,
          });
        } : undefined}
        onDragLeave={o.onDrop ? () => setDropTarget(null) : undefined}
        onDrop={o.onDrop || rid != null ? (e) => {
          e.preventDefault();
          if (plDrag.current != null) {
            const from = plDrag.current;
            plDrag.current = null; setPlOver(null);
            if (rid != null && plOver) reorderPlaylists(from, rid, plOver.after);
            return;
          }
          setDropTarget(null); o.onDrop?.();
        } : undefined}
      >
        <Icon name={o.icon} />
        <span className="nm">{o.label}</span>
        {o.count != null
          ? <span className={`ui-count ${o.active ? "accent" : o.tone ?? ""}`}>{o.count}</span>
          : null}
      </button>
    );
  };

  /* ---------- empty states ---------- */
  const showAll = (
    <button type="button" className="ui-btn" onClick={() => setView({ kind: "all" })}>Show all tracks</button>
  );
  const emptyState = () => {
    if (narrowed) {
      const q = query.trim();
      return (
        <EmptyState
          title={q ? `No matches for “${q}”` : "No matches"}
          action={<button type="button" className="ui-btn" onClick={clearFilters}>{q && !activeFilters ? "Clear search" : "Clear filters"}</button>}
        />
      );
    }
    if (!state.tracks.length) return <EmptyState title="No tracks yet" />;
    if (view.kind === "unfiled") return <EmptyState title="Nothing unfiled" action={showAll} />;
    if (view.kind === "trash") return <EmptyState title="No pending deletes" action={showAll} />;
    if (view.kind === "fav") return <EmptyState title="No favourites yet" action={showAll} />;
    return <EmptyState title="Empty playlist" action={showAll} />;
  };

  /* ---------- menus ---------- */
  const actionsMenu = (m: RowMenu) => {
    const t = m.track;
    const one = m.ids.length === 1;
    const isPlaying = player.playingId === t.id && !player.paused;
    const allInSet = m.ids.every((id) => inSet.has(id));
    // Every playlist this track actually sits in, so unfiling does not depend
    // on having navigated to the right one first.
    const inPls = state.playlists.filter((p) => t.playlists.includes(p.id));
    const done = (fn: () => void) => () => { fn(); setRowMenu(null); };
    const flags = one ? flagsOf(t) : "";
    return (
      <>
        <div className="lib-menu-head" title={one ? detailsOf(t) : undefined}>
          <div className="t">{one ? titleOf(t) : plural(m.ids.length, "track")}</div>
          {flags ? <div className="s">{flags}</div> : null}
        </div>
        <MenuItem icon={isPlaying ? "pause" : "play"} onClick={done(() => handlers.current.toggle(t.id))}>
          {isPlaying ? "Pause" : "Play"}
        </MenuItem>
        <MenuItem icon={allInSet ? "check" : "plus"} disabled={allInSet || !setReady} onClick={done(() => addToSet(m.ids))}>
          {allInSet ? "In set" : "Add to set"}
        </MenuItem>
        {one ? (
          <MenuItem icon={t.favorite ? "starFill" : "star"} onClick={done(() => toggleFavorite(t))}>
            {t.favorite ? "Unfavourite" : "Favourite"}
          </MenuItem>
        ) : null}
        <MenuItem icon="playlist" hint={<Icon name="chevronRight" />} onClick={() => switchMenu("playlists")}>
          Add to playlist
        </MenuItem>
        <MenuItem icon="edit" onClick={done(() => setEditTrack(t))}>Edit…</MenuItem>
        <MenuItem icon="history" onClick={done(() => setHistTrack(t))}>History…</MenuItem>
        {inPls.length ? (
          <>
            <div className="sep" role="separator" />
            <div className="head">Remove from</div>
            {inPls.map((p) => (
              <MenuItem key={p.id} icon="x" onClick={done(() => removeFrom(p.id, m.ids))}>{p.name}</MenuItem>
            ))}
          </>
        ) : null}
        <div className="sep" role="separator" />
        {t.video_id ? (
          <MenuItem icon="link" onClick={done(() => window.open(`https://www.youtube.com/watch?v=${t.video_id}`, "_blank"))}>
            Open on YouTube
          </MenuItem>
        ) : null}
        <MenuItem icon="folder" onClick={done(() => {
          void navigator.clipboard.writeText(t.path);
          notify("Path copied", "ok");
        })}>Copy path</MenuItem>
        <div className="sep" role="separator" />
        {t.pendingDelete ? (
          <MenuItem icon="undo" onClick={done(() => undoDeleteIds(m.ids))}>Restore</MenuItem>
        ) : (
          <MenuItem icon="trash" danger onClick={done(() => stageDeleteIds(m.ids))}>Delete</MenuItem>
        )}
      </>
    );
  };

  // Most recently added to first; never-used playlists keep the sidebar order.
  const pickable = state.playlists
    .filter((p) => p.name.toLowerCase().includes(pickQ.trim().toLowerCase()))
    .sort((a, b) => (b.last_added ?? 0) - (a.last_added ?? 0));

  const playlistPicker = (m: RowMenu) => (
    <>
      <div className="lib-menu-head back">
        <button type="button" role="menuitem" className="ui-icon-btn sm" aria-label="Back" onClick={() => switchMenu("actions")}>
          <Icon name="chevronLeft" />
        </button>
        <div className="t">{m.ids.length > 1 ? plural(m.ids.length, "track") : "Playlists"}</div>
      </div>
      {/* Tick several, then say whether this is a copy or a move. Drag-and-drop
          hides that choice behind a held modifier; here it is two labelled
          buttons and no guessing. */}
      <label className="ui-field lib-pick-search">
        <Icon name="search" />
        <input
          value={pickQ} onChange={(e) => setPickQ(e.target.value)}
          placeholder="Find playlist" aria-label="Find playlist"
          type="search" spellCheck={false} autoComplete="off"
        />
      </label>
      <div className="lib-pick">
        {pickable.length ? pickable.map((p) => {
          const already = m.ids.every((id) => trackById.get(id)?.playlists.includes(p.id));
          const on = picked.has(p.id);
          return (
            <button
              key={p.id} type="button" role="menuitemcheckbox" aria-checked={on || already}
              className="item" disabled={already}
              onClick={() => setPicked((s) => {
                const n = new Set(s);
                if (n.has(p.id)) n.delete(p.id); else n.add(p.id);
                return n;
              })}
            >
              <span className={`lib-check ${on ? "on" : ""} ${already ? "in" : ""}`}>
                {on || already ? <Icon name="check" stroke={2.4} /> : null}
              </span>
              <span className="nm">{p.name}</span>
              {already ? null : <span className="hint">{p.count}</span>}
            </button>
          );
        }) : <p className="lib-pick-empty">{pickQ ? `No playlist matches “${pickQ}”` : "No playlists yet"}</p>}
      </div>
      <div className="lib-pick-foot">
        <button
          type="button" role="menuitem" className="ui-btn sm primary" disabled={!picked.size}
          onClick={() => { copyTo([...picked], m.ids); setRowMenu(null); }}
        >Copy</button>
        {/* aria-disabled, not disabled: the tooltip saying why has to stay reachable. */}
        <button
          type="button" role="menuitem" className="ui-btn sm" aria-disabled={!picked.size || view.kind !== "pl"}
          title={view.kind === "pl"
            ? `Also removes from “${activePl?.name ?? ""}”`
            : "Open a playlist first — move needs somewhere to move out of"}
          onClick={() => {
            if (view.kind !== "pl" || !picked.size) return;
            moveTo([...picked], m.ids, view.id);
            setRowMenu(null);
          }}
        >Move</button>
      </div>
    </>
  );

  /* ---------- render ---------- */
  // The column shows which playlists a track is filed in. The disk folder is a
  // leftover of where the download landed and can carry a playlist's old name,
  // so it lives in the tooltip rather than reading like a playlist.
  const playlistName = new Map(state.playlists.map((p) => [p.id, p.name]));
  const listsOf = (t: Track) => {
    const names = t.playlists.map((id) => playlistName.get(id)).filter((n): n is string => !!n);
    return names.length <= 2 ? names.join(", ") : `${names.slice(0, 2).join(", ")} +${names.length - 2}`;
  };
  const rowProps = (t: Track) => ({
    track: t,
    selected: sel.has(t.id),
    current: player.playingId === t.id,
    playing: player.playingId === t.id && !player.paused,
    inSet: inSet.has(t.id),
    setReady,
    menuOpen: rowMenu?.track.id === t.id,
    dragging: dragCount > 0 && sel.has(t.id),
    isCursor: t.id === tabId,
    bpm: facts.get(t.id)?.bpm ?? null,
    keyRaw: facts.get(t.id)?.key ?? null,
    lists: listsOf(t),
    h: handlers,
  });

  const th = (key: SortKey, label: string) => (
    <button
      type="button" className={`lib-th ${sort.key === key ? "on" : ""}`} onClick={() => sortBy(key)}
      aria-label={`${label}${sort.key === key ? `, sorted ${sort.dir === 1 ? "ascending" : "descending"}` : ""}`}
    >
      {label}
      {sort.key === key ? <Icon name="chevronDown" size={14} className={sort.dir === 1 ? "lib-up" : ""} /> : null}
    </button>
  );

  const isPl = view.kind === "pl";
  const isTrash = view.kind === "trash";

  return (
    <div className="lib">
      <nav className="lib-rail" aria-label="Library">
        <h2 className="lib-group">Collections</h2>
        {railItem("all", {
          active: view.kind === "all", icon: "library", label: "All tracks", count: state.counts.tracks,
          onClick: () => setView({ kind: "all" }),
        })}
        {railItem("fav", {
          active: view.kind === "fav", icon: "star", label: "Favourites", count: state.counts.favorites || null,
          onClick: () => setView({ kind: "fav" }),
        })}
        {railItem("unfiled", {
          active: view.kind === "unfiled", icon: "folder", label: "Unfiled", count: state.counts.unfiled || null,
          tone: "warn", hint: "Tracks that are in no playlist", onClick: () => setView({ kind: "unfiled" }),
        })}
        {railItem("trash", {
          active: isTrash, icon: "trash", label: "Pending deletes", count: state.counts.pendingDeletes || null,
          tone: "danger", hint: "Marked for deletion — nothing leaves the disk until you apply the file plan",
          onClick: () => setView({ kind: "trash" }), onDrop: dropOnTrash, dropKey: "trash",
        })}

        <div className="lib-group">
          <h2>Playlists</h2>
          <button type="button" className="ui-icon-btn sm" onClick={newPlaylist} aria-label="New playlist" title="New playlist">
            <Icon name="plus" />
          </button>
        </div>
        {state.playlists.map((p) => railItem(`pl${p.id}`, {
          active: isPl && view.id === p.id, icon: p.is_manual ? "star" : "playlist", label: p.name, count: p.count,
          hint: p.is_manual ? "Hand-picked: duplicate cleanup never adds or removes tracks here" : undefined,
          onClick: () => setView({ kind: "pl", id: p.id }),
          onDrop: () => dropOnPlaylist(p.id), dropKey: p.id, reorderId: p.id,
          onContext: (e) => {
            e.preventDefault();
            setPlMenu({ id: p.id, name: p.name, anchor: contextAnchor(e) });
          },
        }))}
      </nav>

      <section className="lib-main" aria-labelledby="lib-title">
        <div className="lib-head">
          <div className="lib-heading">
            <h1 id="lib-title" title={title}>{title}</h1>
            <span className="lib-meta">{seconds ? `${countText} · ${fmtTotal(seconds)}` : countText}</span>
          </div>
          <div className="lib-head-end">
            {isTrash && state.counts.pendingDeletes ? (
              <button
                type="button" className={`ui-btn ${selected.length ? "outline" : "primary"}`} onClick={stageToPlan}
                title={`Put ${plural(state.counts.pendingDeletes, "track")} on the file plan and open it. ` +
                  "The app never deletes files; you apply the plan by hand."}
              >
                <Icon name="export" />Send to file plan
              </button>
            ) : null}
            <Segmented label="Track view" value={mode} onChange={setMode} options={MODES} />
          </div>
        </div>

        <div className="lib-tools">
          {selected.length ? (
            <>
              <span className="lib-selcount">{selected.length} selected</span>
              <div className="lib-tgroup">
                <button type="button" className="ui-btn sm primary" disabled={!setReady} onClick={() => addToSet(selIds)}>
                  <Icon name="plus" stroke={2.2} />Add to set
                </button>
                <button
                  type="button" className="ui-btn sm"
                  onClick={(e) => openRowMenu(e.currentTarget.getBoundingClientRect(), "start", selected[0]!, selIds, "playlists")}
                >Add to playlist…</button>
                {isPl ? (
                  <button type="button" className="ui-btn sm" onClick={removeFromPlaylist} title="Remove from this playlist">
                    Remove
                  </button>
                ) : null}
              </div>
              {isTrash ? (
                <button type="button" className="ui-btn sm" onClick={undoDelete}><Icon name="undo" />Restore</button>
              ) : (
                <button
                  type="button" className="ui-btn sm danger" onClick={stageDelete}
                  title="Marks them for deletion. Nothing leaves the disk until you apply the file plan."
                ><Icon name="trash" />Delete</button>
              )}
              <div className="lib-spacer" />
              <button type="button" className="ui-btn sm ghost" onClick={selection.clear} title="Clear selection (Esc)">
                Clear
              </button>
            </>
          ) : (
            <>
              <label className="ui-field lib-search">
                <Icon name="search" />
                <input
                  ref={searchRef} value={query} onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search" aria-label="Search title, artist or folder"
                  type="search" spellCheck={false} autoComplete="off"
                />
                <kbd aria-hidden="true">/</kbd>
              </label>

              {/* Filters narrow what the sidebar already chose; sort stays pinned
                  right so it never trades places with the selection buttons. */}
              <div className="lib-tgroup">
                {([
                  ["dupes", "Duplicates", state.counts.duplicates,
                    "Redundant copies matched by audio content"],
                  ["shared", "In 2+ playlists", 0, "Filed in more than one playlist"],
                  ["staged", "Deleting", 0, "Marked for deletion"],
                ] as [keyof Filters, string, number, string][]).map(([k, label, n, hint]) => (
                  <button
                    key={k} type="button" title={hint} aria-pressed={!!filters[k]}
                    className={`lib-pill ${filters[k] ? "on" : ""}`}
                    onClick={() => applyFilter((f) => ({ ...f, [k]: !f[k] }))}
                  >{label}{n ? <span className="n">{n}</span> : null}</button>
                ))}
                {webmShown ? (
                  <button
                    type="button" className="lib-pill warn" onClick={() => setDupesOpen(true)}
                    title={`${webmShown} WebM/Opus file(s) — rekordbox reads neither, ` +
                      `and each already has a lossless .m4a twin here. Spare copies, not gaps.`}
                  ><Icon name="warning" size={14} />{webmShown} webm</button>
                ) : null}
              </div>

              <div className="lib-tgroup">
                <select
                  className={`ui-select sm ${filters.quality !== "any" ? "on" : ""}`} value={filters.quality} aria-label="Quality"
                  onChange={(e) => applyFilter((f) => ({ ...f, quality: e.target.value as Quality }))}
                >
                  <option value="any">Any quality</option>
                  <option value="lossless">Lossless only</option>
                  <option value="lossy">Compressed only</option>
                </select>
                {narrowed ? (
                  <button type="button" className="ui-btn sm ghost" onClick={clearFilters}>
                    <Icon name="x" />Clear
                  </button>
                ) : null}
              </div>

              <div className="lib-spacer" />
              <div className="lib-tgroup">
                <select
                  className="ui-select sm" value={sort.key} aria-label="Sort by"
                  onChange={(e) => {
                    const key = e.target.value as SortKey;
                    setSort({ key, dir: DESC_BY_DEFAULT.has(key) ? -1 : 1 });
                  }}
                >
                  {SORTS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                </select>
                <button
                  type="button" className="ui-icon-btn sm"
                  onClick={() => setSort((s) => ({ ...s, dir: s.dir === 1 ? -1 : 1 }))}
                  aria-label={sort.dir === 1 ? "Ascending — switch to descending" : "Descending — switch to ascending"}
                  title={sort.dir === 1 ? "Ascending" : "Descending"}
                ><Icon name="chevronDown" className={sort.dir === 1 ? "lib-up" : ""} /></button>
              </div>
            </>
          )}
        </div>
        <div className="sr-only" role="status">{selected.length ? `${selected.length} selected` : ""}</div>

        <div className="lib-scroll" ref={scrollRef}>
          {!shown.length ? emptyState() : mode === "grid" ? (
            <div className="lib-grid" ref={listRef} aria-label={`${title} tracks`} role="group">
              {shown.map((t) => <TrackCard key={t.id} {...rowProps(t)} />)}
            </div>
          ) : (
            <div
              className={`lib-table ${mode === "compact" ? "compact" : ""} ${showFolder ? "" : "nofolder"}`}
              ref={listRef} aria-label={`${title} tracks`} role="group"
            >
              <div className="lib-thead">
                <span />
                <span className="lib-th-title">{th("title", "Title")}{th("artist", "Artist")}</span>
                {showFolder ? <span className="lib-c-folder lib-th-plain">Playlists</span> : null}
                <span className="lib-c-len">
                  {metric === "size" ? th("size", "Size") : metric === "bitrate" ? th("bitrate", "Quality") : th("duration", "Length")}
                </span>
                <span className="lib-c-key">{th("key", "Key")}</span>
                <span className="lib-c-bpm">{th("bpm", "BPM")}</span>
                <span />
              </div>
              {shown.map((t) => (
                <TrackRow key={t.id} {...rowProps(t)} compact={mode === "compact"} showFolder={showFolder} metric={metric} />
              ))}
            </div>
          )}
        </div>
      </section>

      {/* Pinned to the viewport, not to the row: the list scrolls and clips, and
          a menu that vanishes when you reach for it is worse than no menu. The
          playlist picker swaps in place rather than flying out sideways. */}
      {rowMenu ? (
        <Popover
          anchor={rowMenu.anchor} align={rowMenu.align} onClose={closeRowMenu}
          width={rowMenu.mode === "actions" ? 264 : 288}
        >
          <div onKeyDown={menuKeys}>
            {rowMenu.mode === "actions" ? actionsMenu(rowMenu) : playlistPicker(rowMenu)}
          </div>
        </Popover>
      ) : null}

      {plMenu ? (
        <Popover anchor={plMenu.anchor} onClose={closePlMenu} width={216}>
          <div onKeyDown={menuKeys}>
            <div className="head">{plMenu.name}</div>
            <MenuItem icon="edit" onClick={() => {
              const m = plMenu; setPlMenu(null); renamePlaylist(m.id, m.name);
            }}>Rename…</MenuItem>
            <MenuItem icon="trash" danger onClick={() => {
              const m = plMenu; setPlMenu(null); deletePlaylist(m.id, m.name);
            }}>Delete playlist</MenuItem>
          </div>
        </Popover>
      ) : null}

      {ghost && dragCount ? (
        <div className="lib-ghost" style={{ left: ghost.x, top: ghost.y }} aria-hidden="true">
          {ghost.label}
          {ghost.canMove ? <span className="hint"><kbd className="ui-kbd">Shift</kbd> to move</span> : null}
        </div>
      ) : null}

      {dupesOpen ? (
        <DuplicatesModal
          playlists={state.playlists} onClose={() => setDupesOpen(false)}
          onResolved={() => { void reload(); setView({ kind: "trash" }); }} notify={notify}
        />
      ) : null}
      {editTrack ? (
        <EditTrackModal
          track={editTrack} onClose={() => setEditTrack(null)}
          onSave={(t, a) => { saveMeta(editTrack, t, a); setEditTrack(null); }}
        />
      ) : null}
      {histTrack ? (
        <TrackHistoryModal track={histTrack} onClose={() => setHistTrack(null)} notify={notify} />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ rows */

type ItemProps = {
  track: Track;
  selected: boolean;
  /** Loaded in the preview player, playing or paused. */
  current: boolean;
  playing: boolean;
  inSet: boolean;
  setReady: boolean;
  menuOpen: boolean;
  dragging: boolean;
  isCursor: boolean;
  bpm: number | null;
  keyRaw: string | null;
  /** Playlist names this track is filed in, already shortened for the column. */
  lists: string;
  h: RefObject<RowHandlers>;
};

const stop = (e: React.SyntheticEvent) => e.stopPropagation();

/** Shared wiring for a row or a card: select, drag, preview, context menu. */
const itemEvents = (track: Track, h: RefObject<RowHandlers>) => ({
  draggable: true,
  onMouseDown: (e: React.MouseEvent) => h.current.press(track.id, e),
  onDoubleClick: () => h.current.restart(track.id),
  onDragStart: (e: React.DragEvent) => h.current.dragStart(track.id, e),
  onDragEnd: () => h.current.dragEnd(),
  onContextMenu: (e: React.MouseEvent<HTMLElement>) => {
    e.preventDefault();
    // From the keyboard menu key there is no pointer; open from the row's ⋯ instead.
    if (!e.clientX && !e.clientY) {
      const more = e.currentTarget.querySelector<HTMLElement>("[data-more]") ?? e.currentTarget;
      h.current.menu(track, more.getBoundingClientRect(), "end");
      return;
    }
    h.current.menu(track, new DOMRect(e.clientX, e.clientY, 0, 0), "start");
  },
});

const itemClass = (base: string, p: ItemProps) =>
  `${base} ${p.selected ? "sel" : ""} ${p.current ? "current" : ""} ${p.track.pendingDelete ? "del" : ""} ` +
  `${p.dragging ? "dragging" : ""} ${p.menuOpen ? "menu-open" : ""} ${p.inSet ? "inset" : ""}`;

/** The tags a row keeps: only what changes what you can do with the file. */
function Tags({ track }: { track: Track }) {
  return (
    <>
      {track.ext !== "m4a" ? (
        <span className="ui-tag warn" title="rekordbox can’t read this format">{track.ext}</span>
      ) : null}
      {track.pendingDelete ? (
        <span className="ui-tag danger" title="Marked for deletion — nothing leaves the disk until you apply the file plan">
          Deleting
        </span>
      ) : null}
    </>
  );
}

/** Cover art as the play control; the whole square is the target. */
function ArtButton({ track, playing, current, size, h }: {
  track: Track; playing: boolean; current: boolean; size?: number; h: RefObject<RowHandlers>;
}) {
  const title = titleOf(track);
  return (
    <button
      type="button" className={`lib-artbtn ${current ? "on" : ""}`}
      onMouseDown={stop} onDoubleClick={stop}
      onClick={(e) => { e.stopPropagation(); h.current.toggle(track.id); }}
      aria-label={`${playing ? "Pause" : "Play"} ${title}`}
    >
      <Art trackId={track.id} label={title} size={size} playing={playing} />
      <span className="lib-artplay" aria-hidden="true"><Icon name={playing ? "pause" : "play"} /></span>
    </button>
  );
}

function RowActions({ track, inSet, setReady, h, className }: {
  track: Track; inSet: boolean; setReady: boolean; h: RefObject<RowHandlers>; className: string;
}) {
  const title = titleOf(track);
  // A click on an action must not also re-select the row underneath it.
  return (
    <span className={className} onMouseDown={stop} onDoubleClick={stop}>
      <AddButton added={inSet} disabled={!setReady} label={title} onClick={() => h.current.add(track.id)} />
      <button
        type="button" className="ui-icon-btn sm lib-more" data-more=""
        aria-label={`More actions for ${title}`} title="More actions"
        onClick={(e) => { e.stopPropagation(); h.current.menu(track, e.currentTarget.getBoundingClientRect(), "end"); }}
      ><Icon name="more" /></button>
    </span>
  );
}

const TrackRow = memo(function TrackRow(p: ItemProps & { compact: boolean; showFolder: boolean; metric: Metric }) {
  const { track, h } = p;
  const title = titleOf(track);
  // The trailing number answers whatever you sorted by, so the ordering is
  // legible instead of mysterious.
  const trail = p.metric === "size" ? fmtSize(track.size)
    : p.metric === "bitrate" ? (track.bitrate ? `${track.bitrate}k` : "—")
    : fmtLength(track.duration);
  return (
    <div
      className={itemClass("lib-row", p)} data-track-id={track.id} tabIndex={p.isCursor ? 0 : -1}
      {...itemEvents(track, h)}
    >
      <span className="lib-c-art">
        {p.compact ? (
          <span onMouseDown={stop} onDoubleClick={stop}>
            <PlayButton playing={p.playing} label={title} onClick={() => h.current.toggle(track.id)} />
          </span>
        ) : <ArtButton track={track} playing={p.playing} current={p.current} h={h} />}
      </span>
      <span className="lib-c-title" title={tooltipOf(track)}>
        <span className="lib-t1">
          <span className="lib-tt">{title}</span>
          {track.favorite ? <><Icon name="starFill" size={14} className="lib-fav" /><span className="sr-only">Favourite</span></> : null}
          <Tags track={track} />
        </span>
        {track.artist ? <span className="lib-t2">{track.artist}</span> : null}
      </span>
      {p.showFolder ? <span className="lib-c-folder" title={p.lists || "Not in any playlist"}>{p.lists || "—"}</span> : null}
      <span className="lib-c-len">{trail}</span>
      <span className="lib-c-key"><KeyBadge value={p.keyRaw} size={p.compact ? "sm" : undefined} /></span>
      <span className="lib-c-bpm">{fmtBpm(p.bpm)}</span>
      <RowActions track={track} inSet={p.inSet} setReady={p.setReady} h={h} className="lib-c-acts" />
    </div>
  );
});

const TrackCard = memo(function TrackCard(p: ItemProps) {
  const { track, h } = p;
  const title = titleOf(track);
  return (
    <div
      className={itemClass("lib-card", p)} data-track-id={track.id} tabIndex={p.isCursor ? 0 : -1}
      {...itemEvents(track, h)}
    >
      <div className="lib-card-art">
        <ArtButton track={track} playing={p.playing} current={p.current} size={176} h={h} />
        <span className="lib-card-tags"><Tags track={track} /></span>
        <RowActions track={track} inSet={p.inSet} setReady={p.setReady} h={h} className="lib-card-acts" />
      </div>
      <div className="lib-card-title" title={tooltipOf(track)}>
        {track.favorite ? <><Icon name="starFill" size={14} className="lib-fav" /><span className="sr-only">Favourite</span></> : null}
        <span className="lib-tt">{title}</span>
      </div>
      <div className="lib-card-artist">{track.artist}</div>
      <div className="lib-card-facts">
        <KeyBadge value={p.keyRaw} size="sm" />
        {p.bpm ? <span>{fmtBpm(p.bpm)} BPM</span> : null}
        <span className="len">{fmtLength(track.duration)}</span>
      </div>
    </div>
  );
});
