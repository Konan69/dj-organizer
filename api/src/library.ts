import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";
import { db, log, markDirty, now, setMeta } from "./db";
import { contentHash } from "./identity";
import { LIB, TRASH } from "./paths";
import * as serato from "./serato";
import { fromFilename, read } from "./tags";

const AUDIO = new Set([".m4a", ".webm", ".mp3", ".wav", ".aiff", ".flac"]);
const SKIP_DIRS = new Set(["_TRASH", "_Serato_", "_Serato_Backup", "PioneerDJ", "rekordbox"]);

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
  const known = new Map<string, number>();
  for (const r of db.query<{ id: number; path: string }, []>(
    "SELECT id,path FROM tracks").all()) known.set(r.path, r.id);

  const insert = db.query(`INSERT INTO tracks(path,filename,folder,ext,title,artist,album,
    genre,duration,bitrate,size,video_id,added_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const update = db.query(`UPDATE tracks SET filename=?,folder=?,ext=?,title=?,artist=?,
    album=?,genre=?,duration=?,bitrate=?,size=?,video_id=?,missing=0 WHERE path=?`);

  const seen = new Set<string>();
  let added = 0;
  const ts = now();

  for (const path of walk(LIB)) {
    seen.add(path);
    if (known.has(path) && !full) continue;
    let size = 0;
    try { size = statSync(path).size; } catch { continue; }
    const md = await read(path, size);
    const fn = basename(path);
    const rel = relative(LIB, join(path, "..")).split("\\").join("/");
    const folder = rel === "" || rel === "." ? "" : rel;
    const guess = fromFilename(fn);
    const title = md.title ?? guess.title;
    const artist = md.artist ?? guess.artist;
    const ext = extname(fn).toLowerCase().slice(1);

    if (known.has(path)) {
      update.run(fn, folder, ext, title, artist, md.album, md.genre,
        md.duration, md.bitrate, size, md.videoId, path);
    } else {
      insert.run(path, fn, folder, ext, title, artist, md.album, md.genre,
        md.duration, md.bitrate, size, md.videoId, ts);
      added++;
    }
  }

  let missing = 0;
  const flag = db.query("UPDATE tracks SET missing=1 WHERE path=?");
  for (const p of known.keys()) if (!seen.has(p)) { flag.run(p); missing++; }

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

/** One-time: the existing .crate files are the current source of truth for membership. */
export function seedFromCrates() {
  const existing = db.query<{ n: number }, []>("SELECT COUNT(*) n FROM playlists").get()!.n;
  if (existing) return { seeded: false, reason: "playlists already exist" };

  const byPath = new Map<string, number>();
  for (const r of db.query<{ id: number; path: string }, []>(
    "SELECT id,path FROM tracks").all()) byPath.set(r.path, r.id);

  const mkPl = db.query<{ id: number }, [string, number, number, number]>(
    "INSERT INTO playlists(name,sort,is_manual,created_at) VALUES(?,?,?,?) RETURNING id");
  const mkMem = db.query(
    "INSERT OR IGNORE INTO memberships(playlist_id,track_id,sort) VALUES(?,?,?)");

  let made = 0, linked = 0, unresolved = 0, sort = 0;
  const ts = now();
  for (const [name, paths] of Object.entries(serato.readAll())) {
    const pid = mkPl.get(name, ++sort, name.trim() === "BANGERS !!!!" ? 1 : 0, ts)!.id;
    made++;
    paths.forEach((p, i) => {
      const tid = byPath.get(p);
      if (tid === undefined) { unresolved++; return; }
      mkMem.run(pid, tid, i);
      linked++;
    });
  }
  log("seed_from_crates", {}, `${made} playlists, ${linked} links, ${unresolved} unresolved`);
  return { seeded: true, playlists: made, links: linked, unresolved };
}

export async function bootstrap() {
  const first = db.query<{ n: number }, []>("SELECT COUNT(*) n FROM tracks").get()!.n === 0;
  const s = await scan(first);
  const seed = seedFromCrates();
  return { scan: s, seed };
}

export function applyDeletes() {
  const rows = db.query<{ id: number; path: string; filename: string }, []>(
    "SELECT t.id,t.path,t.filename FROM pending_deletes p JOIN tracks t ON t.id=p.track_id",
  ).all();
  mkdirSync(TRASH, { recursive: true });

  const del = db.query("DELETE FROM tracks WHERE id=?");
  const moved: string[] = [], errors: string[] = [];
  for (const r of rows) {
    try {
      if (existsSync(r.path)) {
        let dst = join(TRASH, r.filename);
        let i = 1;
        while (existsSync(dst)) {
          const ext = extname(r.filename);
          dst = join(TRASH, `${basename(r.filename, ext)} (${i++})${ext}`);
        }
        renameSync(r.path, dst);
      }
      del.run(r.id);
      moved.push(r.filename);
    } catch (e) {
      errors.push(`${r.filename}: ${(e as Error).message}`);
    }
  }
  db.query("DELETE FROM pending_deletes").run();
  log("apply_deletes", { n: moved.length }, `${errors.length} errors`);
  if (moved.length) markDirty("changes");
  return { moved: moved.length, errors, trash: TRASH };
}
