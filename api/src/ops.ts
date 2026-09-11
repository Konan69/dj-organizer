/**
 * Append-only intent log.
 *
 * Every edit is recorded as an operation keyed by CONTENT HASH and playlist
 * NAME — never by path, mtime or an internal row id. That is what makes the log
 * replayable: the same op can be applied to the filesystem, to Serato, or to
 * rekordbox, each of which identifies tracks differently and has drifted from
 * the others.
 *
 * Nothing here writes to an external store. `plan()` turns the log into the
 * concrete list of actions a given store still needs, which is what gets
 * applied — by hand for now.
 */
import { db, log, now } from "./db";
import { latest, type Observation, type StoreName } from "./stores";

export type OpKind =
  | "create_playlist" | "delete_playlist" | "rename_playlist"
  | "add_to" | "remove_from" | "delete_track";

export type Op = {
  id: number; at: number; kind: OpKind;
  playlist: string | null; to_playlist: string | null;
  track_hash: string | null; track_path: string | null; track_label: string | null;
  payload: string | null; undone: number;
  applied_serato: number; applied_rekordbox: number; applied_fs: number;
};

const insert = db.query<{ id: number }, [
  number, string, string | null, string | null, string | null,
  string | null, string | null, string | null,
]>(`INSERT INTO ops(at,kind,playlist,to_playlist,track_hash,track_path,track_label,payload)
    VALUES(?,?,?,?,?,?,?,?) RETURNING id`);

export function record(kind: OpKind, o: {
  playlist?: string | null; toPlaylist?: string | null;
  trackHash?: string | null; trackPath?: string | null; trackLabel?: string | null;
  payload?: unknown;
} = {}) {
  const row = insert.get(
    now(), kind, o.playlist ?? null, o.toPlaylist ?? null,
    o.trackHash ?? null, o.trackPath ?? null, o.trackLabel ?? null,
    o.payload === undefined ? null : JSON.stringify(o.payload),
  )!;
  return row.id;
}

/** Bulk membership change: one op per track, so each is independently replayable. */
export function recordMembership(
  kind: "add_to" | "remove_from", playlist: string, trackIds: number[],
) {
  const q = db.query<
    { content_hash: string | null; path: string; title: string | null; artist: string | null },
    [number]
  >("SELECT content_hash,path,title,artist FROM tracks WHERE id=?");
  const ids: number[] = [];
  for (const tid of trackIds) {
    const t = q.get(tid);
    if (!t) continue;
    ids.push(record(kind, {
      playlist,
      trackHash: t.content_hash,
      trackPath: t.path,
      trackLabel: [t.artist, t.title].filter(Boolean).join(" - ") || t.path.split("/").pop()!,
    }));
  }
  return ids;
}

export function list(limit = 500, includeUndone = false) {
  return db.query<Op, [number]>(
    `SELECT * FROM ops ${includeUndone ? "" : "WHERE undone=0"}
     ORDER BY at DESC, id DESC LIMIT ?`).all(limit);
}

export function undo(ids: number[]) {
  const q = db.query("UPDATE ops SET undone=1 WHERE id=?");
  db.transaction(() => { for (const id of ids) q.run(id); })();
  log("ops_undo", { n: ids.length });
  return { undone: ids.length };
}

export function markApplied(store: StoreName, ids: number[]) {
  const col = store === "serato" ? "applied_serato"
    : store === "rekordbox" ? "applied_rekordbox" : "applied_fs";
  const q = db.query(`UPDATE ops SET ${col}=? WHERE id=?`);
  const ts = now();
  db.transaction(() => { for (const id of ids) q.run(ts, id); })();
  log("ops_mark_applied", { store, n: ids.length });
  return { store, marked: ids.length };
}

export function stats() {
  const row = db.query<{
    total: number; open: number; serato: number; rekordbox: number;
  }, []>(`SELECT COUNT(*) total,
      SUM(CASE WHEN undone=0 THEN 1 ELSE 0 END) open,
      SUM(CASE WHEN undone=0 AND applied_serato=0 THEN 1 ELSE 0 END) serato,
      SUM(CASE WHEN undone=0 AND applied_rekordbox=0 THEN 1 ELSE 0 END) rekordbox
    FROM ops`).get()!;
  return {
    total: row.total ?? 0,
    open: row.open ?? 0,
    pending: { serato: row.serato ?? 0, rekordbox: row.rekordbox ?? 0 },
  };
}

/* ---------------------------------------------------------------- planning */

export type PlanAction = {
  action: "create_playlist" | "delete_playlist" | "rename_playlist" | "add" | "remove" | "delete_file";
  playlist?: string;
  toPlaylist?: string;
  path?: string;
  label?: string;
  hash?: string | null;
  /** true when the store already reflects this — shown, but nothing to do */
  satisfied: boolean;
  opIds: number[];
};

/**
 * Collapse the open log into what `store` actually still needs, checked against
 * that store's most recent observation. A store that has drifted further needs
 * more actions; one already in the desired state needs none. Ops that cancel
 * out (add then remove) collapse to nothing.
 */
export function plan(store: StoreName, obs?: Observation | null): {
  store: StoreName; observedAt: number | null; stale: boolean;
  actions: PlanAction[]; satisfied: number; pending: number;
} {
  const observation = obs ?? latest(store);
  const ops = db.query<Op, []>(
    "SELECT * FROM ops WHERE undone=0 ORDER BY at ASC, id ASC").all();

  // Fold membership ops: last write per (playlist, track) wins.
  type Slot = { op: Op; ids: number[] };
  const membership = new Map<string, Slot>();
  const playlistOps: Op[] = [];
  const deletions = new Map<string, Slot>();

  for (const op of ops) {
    if (op.kind === "add_to" || op.kind === "remove_from") {
      const key = `${op.playlist}\u0000${op.track_hash ?? op.track_path}`;
      const prev = membership.get(key);
      membership.set(key, { op, ids: [...(prev?.ids ?? []), op.id] });
    } else if (op.kind === "delete_track") {
      const key = op.track_hash ?? op.track_path ?? String(op.id);
      const prev = deletions.get(key);
      deletions.set(key, { op, ids: [...(prev?.ids ?? []), op.id] });
    } else {
      playlistOps.push(op);
    }
  }

  const groups = observation?.groups ?? {};
  const lookup = (name: string | null) => {
    if (!name) return [] as string[];
    if (groups[name]) return groups[name];
    const ci = Object.keys(groups).find((k) => k.toLowerCase() === name.toLowerCase());
    return ci ? groups[ci]! : [];
  };

  const actions: PlanAction[] = [];

  for (const op of playlistOps) {
    const exists = lookup(op.playlist).length > 0
      || Object.keys(groups).some((k) => k.toLowerCase() === (op.playlist ?? "").toLowerCase());
    if (op.kind !== "create_playlist" && op.kind !== "delete_playlist"
      && op.kind !== "rename_playlist") continue;
    actions.push({
      action: op.kind,
      playlist: op.playlist ?? undefined,
      toPlaylist: op.to_playlist ?? undefined,
      satisfied: op.kind === "create_playlist" ? exists : op.kind === "delete_playlist" ? !exists : false,
      opIds: [op.id],
    });
  }

  for (const { op, ids } of membership.values()) {
    const members = new Set(lookup(op.playlist).map((p) => p.toLowerCase()));
    const present = op.track_path ? members.has(op.track_path.toLowerCase()) : false;
    const want = op.kind === "add_to";
    actions.push({
      action: want ? "add" : "remove",
      playlist: op.playlist ?? undefined,
      path: op.track_path ?? undefined,
      label: op.track_label ?? undefined,
      hash: op.track_hash,
      satisfied: want ? present : !present,
      opIds: ids,
    });
  }

  for (const { op, ids } of deletions.values()) {
    const stillReferenced = Object.values(groups).some((paths) =>
      paths.some((p) => p.toLowerCase() === (op.track_path ?? "").toLowerCase()));
    actions.push({
      action: "delete_file",
      path: op.track_path ?? undefined,
      label: op.track_label ?? undefined,
      hash: op.track_hash,
      satisfied: !stillReferenced,
      opIds: ids,
    });
  }

  const satisfied = actions.filter((a) => a.satisfied).length;
  return {
    store,
    observedAt: observation?.observedAt ?? null,
    stale: !observation,
    actions,
    satisfied,
    pending: actions.length - satisfied,
  };
}

/** The plan as text — the thing to work through by hand. */
export function planText(store: StoreName) {
  const p = plan(store);
  const rel = (s?: string) => (s ?? "").replace("/mnt/c/Users/you/Music/tracks/", "");
  const L: string[] = [
    `# dj-organizer — replay plan for ${store}`,
    `# generated ${new Date().toISOString()}`,
    p.observedAt
      ? `# against observation from ${new Date(p.observedAt * 1000).toISOString()}`
      : "# NO OBSERVATION of this store yet — run a refresh first",
    `# ${p.pending} pending, ${p.satisfied} already satisfied`,
    "",
  ];
  const todo = p.actions.filter((a) => !a.satisfied);
  if (!todo.length) { L.push("Nothing to apply."); return L.join("\n"); }

  const byPlaylist = new Map<string, PlanAction[]>();
  for (const a of todo) {
    const k = a.playlist ?? "(files)";
    (byPlaylist.get(k) ?? byPlaylist.set(k, []).get(k)!).push(a);
  }
  for (const [name, group] of byPlaylist) {
    L.push(`## ${name}`);
    for (const a of group) {
      switch (a.action) {
        case "create_playlist":
          L.push(`  NEW PLAYLIST   ${a.playlist}`); break;
        case "delete_playlist":
          L.push(`  DROP PLAYLIST  ${a.playlist}`); break;
        case "rename_playlist":
          L.push(`  RENAME         ${a.playlist} -> ${a.toPlaylist}`); break;
        case "delete_file":
          L.push(`  x ${a.label ?? ""}  ${rel(a.path)}`.trimEnd()); break;
        default:
          L.push(`  ${a.action === "add" ? "+" : "-"} ${a.label ?? ""}  ${rel(a.path)}`.trimEnd());
      }
    }
    L.push("");
  }
  return L.join("\n");
}
