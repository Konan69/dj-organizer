/**
 * Changeset: staged state (this app's DB) vs reality (the .crate files on disk).
 *
 * The app never writes to Serato or rekordbox. It produces this diff, and the
 * diff gets applied by hand. Crates are read-only input here — they are the
 * baseline, nothing more.
 */
import { db } from "./db";
import * as serato from "./serato";

export type TrackRef = {
  id: number | null;
  path: string;
  filename: string;
  title: string | null;
  artist: string | null;
};

export type Modified = {
  name: string;
  added: TrackRef[];
  removed: TrackRef[];
  baseline: number;
  staged: number;
};

function byPath() {
  const m = new Map<string, TrackRef>();
  for (const r of db.query<
    { id: number; path: string; filename: string; title: string | null; artist: string | null },
    []
  >("SELECT id,path,filename,title,artist FROM tracks").all()) {
    m.set(r.path, { id: r.id, path: r.path, filename: r.filename, title: r.title, artist: r.artist });
  }
  return m;
}

const refFor = (map: Map<string, TrackRef>, path: string): TrackRef =>
  map.get(path) ?? {
    id: null, path,
    filename: path.split("/").pop() ?? path,
    title: null, artist: null,
  };

export function compute() {
  const known = byPath();
  const baseline = serato.readAll(); // crate name -> absolute paths

  const staged = new Map<string, string[]>();
  for (const p of db.query<{ id: number; name: string }, []>(
    "SELECT id,name FROM playlists ORDER BY sort,name").all()) {
    staged.set(
      p.name,
      db.query<{ path: string }, [number]>(
        `SELECT t.path FROM memberships m JOIN tracks t ON t.id=m.track_id
         WHERE m.playlist_id=? AND t.missing=0 ORDER BY m.sort`).all(p.id).map((r) => r.path),
    );
  }

  const created: { name: string; tracks: number }[] = [];
  const deleted: { name: string; tracks: number }[] = [];
  const modified: Modified[] = [];

  for (const [name, paths] of staged) {
    const base = baseline[name];
    if (!base) { created.push({ name, tracks: paths.length }); continue; }
    const baseSet = new Set(base);
    const stagedSet = new Set(paths);
    const added = paths.filter((p) => !baseSet.has(p)).map((p) => refFor(known, p));
    const removed = base.filter((p) => !stagedSet.has(p)).map((p) => refFor(known, p));
    if (added.length || removed.length) {
      modified.push({ name, added, removed, baseline: base.length, staged: paths.length });
    }
  }
  for (const name of Object.keys(baseline)) {
    if (!staged.has(name)) deleted.push({ name, tracks: baseline[name]!.length });
  }

  const deletes = db.query<
    { id: number; path: string; filename: string; title: string | null;
      artist: string | null; folder: string; reason: string }, []
  >(`SELECT t.id,t.path,t.filename,t.title,t.artist,t.folder,p.reason
     FROM pending_deletes p JOIN tracks t ON t.id=p.track_id`).all();

  return {
    playlists: { created, deleted, modified },
    deletes,
    summary: {
      created: created.length,
      deleted: deleted.length,
      modified: modified.length,
      tracksAdded: modified.reduce((n, m) => n + m.added.length, 0)
        + created.reduce((n, c) => n + c.tracks, 0),
      tracksRemoved: modified.reduce((n, m) => n + m.removed.length, 0),
      pendingDeletes: deletes.length,
      clean: !created.length && !deleted.length && !modified.length && !deletes.length,
    },
  };
}

/** Flat text form — easiest thing to work through by hand. */
export function asText() {
  const c = compute();
  const L: string[] = [];
  const rel = (p: string) => p.replace("/mnt/c/Users/you/Music/tracks/", "");

  L.push("# dj-organizer changeset");
  L.push(`# generated ${new Date().toISOString()}`);
  L.push("");
  if (c.summary.clean) { L.push("No changes. Staged state matches the crates on disk."); return L.join("\n"); }

  for (const p of c.playlists.created) {
    L.push(`NEW PLAYLIST  ${p.name}  (${p.tracks} tracks)`);
  }
  for (const p of c.playlists.deleted) {
    L.push(`DROP PLAYLIST ${p.name}  (was ${p.tracks} tracks)`);
  }
  if (c.playlists.created.length || c.playlists.deleted.length) L.push("");

  for (const m of c.playlists.modified) {
    L.push(`## ${m.name}   ${m.baseline} -> ${m.staged}`);
    for (const t of m.added) L.push(`  + ${rel(t.path)}`);
    for (const t of m.removed) L.push(`  - ${rel(t.path)}`);
    L.push("");
  }

  if (c.deletes.length) {
    L.push(`## delete by hand (${c.deletes.length}) — this app moves nothing`);
    for (const d of c.deletes) L.push(`  x ${rel(d.path)}${d.reason ? `   [${d.reason}]` : ""}`);
  }
  return L.join("\n");
}
