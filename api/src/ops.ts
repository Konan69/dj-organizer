/**
 * Append-only intent log.
 *
 * Every edit is recorded as an operation keyed by CONTENT HASH and playlist
 * NAME — never by path, mtime or an internal row id. That is what makes the log
 * replayable: the same op can be applied to the filesystem or rekordbox, each
 * of which identifies tracks differently and may have drifted from the other.
 *
 * Nothing here writes to an external store. `plan()` turns the log into the
 * concrete list of actions a given store still needs, which is what gets
 * applied — by hand for now.
 */
import { db, log, now } from "./db";
import { pathKey } from "./paths";
import { latest, type Observation, type StoreName } from "./stores";

export type OpKind =
  | "create_playlist" | "delete_playlist" | "rename_playlist"
  | "add_to" | "remove_from" | "delete_track" | "download_track"
  | "edit_metadata";

export type Op = {
  id: number; at: number; kind: OpKind;
  playlist: string | null; to_playlist: string | null;
  track_hash: string | null; track_path: string | null; track_label: string | null;
  payload: string | null; undone: number;
  applied_rekordbox: number; applied_fs: number;
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

/** A completed download is history, not pending work for an external store. */
export function recordDownload(o: {
  playlist: string; path: string; title: string; videoId: string; trackHash: string;
}) {
  const id = record("download_track", {
    playlist: o.playlist,
    trackHash: o.trackHash,
    trackPath: o.path,
    trackLabel: o.title,
    payload: { videoId: o.videoId },
  });
  const ts = now();
  db.query(
    `UPDATE ops SET applied_rekordbox=?,applied_fs=? WHERE id=?`,
  ).run(ts, ts, id);
  return id;
}

export function recordMetadataEdit(o: {
  trackHash: string;
  trackLabel: string;
  from: { title: string | null; artist: string | null };
  to: { title: string | null; artist: string | null };
}) {
  const id = record("edit_metadata", {
    trackHash: o.trackHash,
    trackLabel: o.trackLabel,
    payload: { from: o.from, to: o.to },
  });
  // Files are never retagged, so there is deliberately no filesystem action.
  db.query("UPDATE ops SET applied_fs=? WHERE id=?").run(now(), id);
  return id;
}

export function withdrawPendingMetadataEdits(trackHash: string) {
  const applied = db.query<{ found: number }, [string]>(`SELECT 1 AS found FROM ops
    WHERE kind='edit_metadata' AND track_hash=? AND undone=0
      AND applied_rekordbox<>0
    LIMIT 1`).get(trackHash) !== null;
  // Work that never left staging can be withdrawn instead of replayed twice.
  const undone = db.query(`UPDATE ops SET undone=1
    WHERE kind='edit_metadata' AND track_hash=? AND undone=0
      AND applied_rekordbox=0`).run(trackHash).changes;
  return { applied, undone };
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
  const col = store === "rekordbox" ? "applied_rekordbox" : "applied_fs";
  const q = db.query(`UPDATE ops SET ${col}=? WHERE id=?`);
  const ts = now();
  db.transaction(() => { for (const id of ids) q.run(ts, id); })();
  log("ops_mark_applied", { store, n: ids.length });
  return { store, marked: ids.length };
}

export function stats() {
  const row = db.query<{
    total: number; open: number; rekordbox: number; fs: number;
  }, []>(`SELECT COUNT(*) total,
      SUM(CASE WHEN undone=0 THEN 1 ELSE 0 END) open,
      SUM(CASE WHEN undone=0 AND applied_rekordbox=0 THEN 1 ELSE 0 END) rekordbox,
      SUM(CASE WHEN undone=0 AND applied_fs=0 THEN 1 ELSE 0 END) fs
    FROM ops`).get()!;
  return {
    total: row.total ?? 0,
    open: row.open ?? 0,
    pending: { rekordbox: row.rekordbox ?? 0, fs: row.fs ?? 0 },
  };
}

/* ---------------------------------------------------------------- planning */

export type PlanAction = {
  action: "create_playlist" | "delete_playlist" | "rename_playlist"
    | "add" | "remove" | "delete_file" | "edit_metadata";
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
      const trackKey = op.track_hash ?? (op.track_path ? pathKey(op.track_path) : null);
      const key = `${op.playlist}\u0000${trackKey}`;
      const prev = membership.get(key);
      membership.set(key, { op, ids: [...(prev?.ids ?? []), op.id] });
    } else if (op.kind === "delete_track") {
      const key = op.track_hash ?? (op.track_path ? pathKey(op.track_path) : String(op.id));
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
  const labelQ = db.query<{
    title: string | null; artist: string | null; filename: string;
  }, [string]>(`SELECT COALESCE(o.title,t.title) AS title,
      COALESCE(o.artist,t.artist) AS artist,t.filename
    FROM tracks t LEFT JOIN track_overrides o ON o.track_hash=t.content_hash
    WHERE t.content_hash=? ORDER BY t.missing,t.id LIMIT 1`);
  const currentLabel = (op: Op) => {
    const track = op.track_hash ? labelQ.get(op.track_hash) : null;
    return track
      ? [track.artist, track.title].filter(Boolean).join(" - ") || track.filename
      : op.track_label ?? undefined;
  };

  for (const op of playlistOps) {
    if (op.kind === "edit_metadata") {
      if (store === "fs") continue;
      const applied = op.applied_rekordbox;
      actions.push({
        action: "edit_metadata",
        label: currentLabel(op),
        hash: op.track_hash,
        satisfied: applied !== 0,
        opIds: [op.id],
      });
      continue;
    }
    const exists = lookup(op.playlist).length > 0
      || Object.keys(groups).some((k) => k.toLowerCase() === (op.playlist ?? "").toLowerCase());
    if (op.kind !== "create_playlist" && op.kind !== "delete_playlist"
      && op.kind !== "rename_playlist") continue;
    actions.push({
      action: op.kind,
      playlist: op.playlist ?? undefined,
      toPlaylist: op.to_playlist ?? undefined,
      satisfied: op.kind === "create_playlist" ? exists
        : op.kind === "delete_playlist" ? !exists
        : !exists && Object.keys(groups).some((k) => k.toLowerCase() === (op.to_playlist ?? "").toLowerCase()),
      opIds: [op.id],
    });
  }

  for (const { op, ids } of membership.values()) {
    const members = new Set(lookup(op.playlist).map(pathKey));
    const present = op.track_path ? members.has(pathKey(op.track_path)) : false;
    const want = op.kind === "add_to";
    actions.push({
      action: want ? "add" : "remove",
      playlist: op.playlist ?? undefined,
      path: op.track_path ?? undefined,
      label: currentLabel(op),
      hash: op.track_hash,
      satisfied: want ? present : !present,
      opIds: ids,
    });
  }

  for (const { op, ids } of deletions.values()) {
    const stillReferenced = Object.values(groups).some((paths) =>
      paths.some((p) => pathKey(p) === pathKey(op.track_path ?? "")));
    actions.push({
      action: "delete_file",
      path: op.track_path ?? undefined,
      label: currentLabel(op),
      hash: op.track_hash,
      satisfied: !stillReferenced,
      opIds: ids,
    });
  }

  const satisfied = actions.filter((a) => a.satisfied).length;
  const newestOpenAt = ops.length ? ops[ops.length - 1]!.at : null;
  const observedAt = observation?.observedAt ?? null;
  return {
    store,
    observedAt,
    stale: observedAt === null || (newestOpenAt !== null && observedAt < newestOpenAt),
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
        case "edit_metadata":
          L.push(`  ~ ${a.label ?? ""}  (edit metadata)`.trimEnd()); break;
        default:
          L.push(`  ${a.action === "add" ? "+" : "-"} ${a.label ?? ""}  ${rel(a.path)}`.trimEnd());
      }
    }
    L.push("");
  }
  return L.join("\n");
}
