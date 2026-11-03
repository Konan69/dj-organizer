import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";
import { db, log, markDirty, now, setMeta } from "./db";
import { contentHash } from "./identity";
import { LIB, pathKey } from "./paths";
import { observeRekordbox, record as recordObservation } from "./stores";
import { fromFilename, read } from "./tags";

const AUDIO = new Set([".m4a", ".webm", ".mp3", ".wav", ".aiff", ".flac"]);
const SKIP_DIRS = new Set(["_TRASH", "PioneerDJ", "rekordbox"]);

function* walk(dir: string): Generator<string> {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
      yield* walk(full);
    } else if (AUDIO.has(extname(e.name).toLowerCase())) {
      yield full;
    }
  }
}

export async function scan(full = false) {
  type Known = { id: number; path: string; missing: number };
  const known = new Map<string, Known>();
  for (const row of db.query<Known, []>(
    "SELECT id,path,missing FROM tracks ORDER BY missing,id").all()) {
    const key = pathKey(row.path);
    if (!known.has(key)) known.set(key, row);
  }

  const insert = db.query(`INSERT INTO tracks(path,filename,folder,ext,title,artist,album,
    genre,duration,bitrate,size,video_id,added_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const update = db.query(`UPDATE tracks SET path=?,filename=?,folder=?,ext=?,title=?,artist=?,
    album=?,genre=?,duration=?,bitrate=?,size=?,video_id=?,missing=0 WHERE id=?`);
  const recase = db.query(
    "UPDATE tracks SET path=?,filename=?,folder=?,missing=0 WHERE id=?");

  const seen = new Set<string>();
  let added = 0;
  const ts = now();

  for (const path of walk(LIB)) {
    const key = pathKey(path);
    const existing = known.get(key);
    seen.add(key);
    const fn = basename(path);
    const rel = relative(LIB, join(path, "..")).split("\\").join("/");
    const folder = rel === "" || rel === "." ? "" : rel;
    if (existing && !full) {
      if (existing.path !== path || existing.missing) recase.run(path, fn, folder, existing.id);
      continue;
    }

    let size = 0;
    try { size = statSync(path).size; } catch { continue; }
    const md = await read(path, size);
    const guess = fromFilename(fn);
    const title = md.title ?? guess.title;
    const artist = md.artist ?? guess.artist;
    const ext = extname(fn).toLowerCase().slice(1);

    if (existing) {
      update.run(path, fn, folder, ext, title, artist, md.album, md.genre,
        md.duration, md.bitrate, size, md.videoId, existing.id);
    } else {
      insert.run(path, fn, folder, ext, title, artist, md.album, md.genre,
        md.duration, md.bitrate, size, md.videoId, ts);
      added++;
    }
  }

  let missing = 0;
  const flag = db.query("UPDATE tracks SET missing=1 WHERE id=?");
  for (const [key, row] of known) if (!seen.has(key)) { flag.run(row.id); missing++; }

  const hashed = await hashPending();

  setMeta("last_scan", ts);
  const total = db.query<{ n: number }, []>(
    "SELECT COUNT(*) n FROM tracks WHERE missing=0").get()!.n;
  log("scan", { full }, `+${added} missing=${missing} hashed=${hashed} total=${total}`);
  return { added, missing, total, hashed };
}

/**
 * Content-hash any track that lacks one, or whose size changed since hashing.
 * Identity has to survive renames and folder moves, so it is derived from the
 * audio payload rather than the path or any timestamp.
 */
export async function hashPending(limit = 5000) {
  const rows = db.query<{ id: number; path: string; size: number | null }, [number]>(
    `SELECT id,path,size FROM tracks
     WHERE missing=0 AND (content_hash IS NULL OR hashed_at IS NULL)
     LIMIT ?`).all(limit);
  if (!rows.length) return 0;

  const set = db.query(
    "UPDATE tracks SET content_hash=?, hash_scope=?, hashed_at=? WHERE id=?");
  const ts = now();
  let n = 0;
  for (const r of rows) {
    try {
      const size = r.size ?? statSync(r.path).size;
      const h = await contentHash(r.path, size);
      set.run(h.hash, h.scope, ts, r.id);
      n++;
    } catch { /* unreadable file — leave it unhashed, the scan flags it missing */ }
  }
  return n;
}

export async function bootstrap() {
  const first = db.query<{ n: number }, []>("SELECT COUNT(*) n FROM tracks").get()!.n === 0;
  const s = await scan(first);
  const observation = await observeRekordbox();
  recordObservation(observation);
  const existing = db.query<{ n: number }, []>("SELECT COUNT(*) n FROM playlists").get()!.n;
  let seed = { seeded: false, reason: "playlists already exist" } as
    | { seeded: false; reason: string }
    | { seeded: true; playlists: number; links: number; unresolved: number };
  if (!existing && Object.keys(observation.groups).length) {
    const byPath = new Map<string, number>();
    for (const r of db.query<{ id: number; path: string }, []>(
      "SELECT id,path FROM tracks").all()) byPath.set(pathKey(r.path), r.id);

    const mkPl = db.query<{ id: number }, [string, number, number, number]>(
      "INSERT INTO playlists(name,sort,is_manual,created_at) VALUES(?,?,?,?) RETURNING id");
    const mkMem = db.query(
      "INSERT OR IGNORE INTO memberships(playlist_id,track_id,sort) VALUES(?,?,?)");

    let made = 0, linked = 0, unresolved = 0, sort = 0;
    const ts = now();
    for (const [name, paths] of Object.entries(observation.groups)) {
      const pid = mkPl.get(name, ++sort, name.trim() === "BANGERS !!!!" ? 1 : 0, ts)!.id;
      made++;
      paths.forEach((p, i) => {
        const tid = byPath.get(pathKey(p));
        if (tid === undefined) { unresolved++; return; }
        mkMem.run(pid, tid, i);
        linked++;
      });
    }
    log("seed_from_rekordbox", {}, `${made} playlists, ${linked} links, ${unresolved} unresolved`);
    seed = { seeded: true, playlists: made, links: linked, unresolved };
  } else if (!existing) {
    seed = { seeded: false, reason: "no rekordbox playlists available" };
  }
  return { scan: s, seed };
}

// There is deliberately no apply/commit function here. The downloader may add
// new files, but nothing moves, renames, or deletes one. Deletes stay staged and
// leave through GET /api/plan/fs, applied by hand.
