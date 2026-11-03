/**
 * Files never move on disk. Genre folders are storage; playlists are metadata.
 * Outside data/, the downloader may only add folders and new files. There is no
 * external-store write, overwrite, rename, move, or delete; every destructive decision
 * leaves as a plan the user applies by hand.
 */
import { Database } from "bun:sqlite";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DATA, DB_PATH } from "./paths";

mkdirSync(DATA, { recursive: true });

export const db = new Database(DB_PATH, { create: true });
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS tracks(
  id INTEGER PRIMARY KEY, path TEXT UNIQUE NOT NULL, filename TEXT NOT NULL,
  folder TEXT, ext TEXT, title TEXT, artist TEXT, album TEXT, genre TEXT,
  duration REAL, bitrate INTEGER, size INTEGER, video_id TEXT,
  added_at INTEGER, missing INTEGER DEFAULT 0);
CREATE INDEX IF NOT EXISTS ix_tracks_vid ON tracks(video_id);
CREATE INDEX IF NOT EXISTS ix_tracks_missing ON tracks(missing);

CREATE TABLE IF NOT EXISTS track_overrides(
  track_hash TEXT PRIMARY KEY, title TEXT, artist TEXT, at INTEGER);

CREATE TABLE IF NOT EXISTS playlists(
  id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, sort INTEGER DEFAULT 0,
  is_manual INTEGER DEFAULT 0, created_at INTEGER);

CREATE TABLE IF NOT EXISTS memberships(
  playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  sort INTEGER DEFAULT 0, PRIMARY KEY(playlist_id, track_id));
CREATE INDEX IF NOT EXISTS ix_mem_track ON memberships(track_id);

CREATE TABLE IF NOT EXISTS pending_deletes(
  track_id INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
  queued_at INTEGER, reason TEXT);

CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS ytm_playlists(
  ytm_id TEXT PRIMARY KEY, title TEXT, count INTEGER,
  local_playlist_id INTEGER, fetched_at INTEGER);
CREATE TABLE IF NOT EXISTS ytm_tracks(
  ytm_id TEXT NOT NULL, video_id TEXT, title TEXT, artist TEXT, sort INTEGER,
  PRIMARY KEY(ytm_id, video_id));
CREATE TABLE IF NOT EXISTS ytm_staged(
  video_id TEXT PRIMARY KEY, ytm_id TEXT, local_playlist TEXT, title TEXT,
  artist TEXT, status TEXT DEFAULT 'pending'
    CHECK(status IN ('pending','approved','rejected','downloaded')),
  flags TEXT, staged_at INTEGER);
CREATE INDEX IF NOT EXISTS ix_ytm_staged_playlist ON ytm_staged(local_playlist);
CREATE INDEX IF NOT EXISTS ix_ytm_staged_status ON ytm_staged(status);
-- An upstream video whose playlist slot is held by another track (an extended
-- mix of it). Upstream sync places the replacement wherever the video appears.
CREATE TABLE IF NOT EXISTS track_replacements(
  video_id TEXT PRIMARY KEY, track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE);

-- Raw observation of an external store at a point in time. Never mutated:
-- these are the evidence a diff is computed against, so a stale rekordbox or a
-- filesystem observation is visible as drift rather than silently assumed.
CREATE TABLE IF NOT EXISTS observations(
  id INTEGER PRIMARY KEY, store TEXT NOT NULL, observed_at INTEGER NOT NULL,
  tracks INTEGER, playlists INTEGER, digest TEXT, payload TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS ix_obs_store ON observations(store, observed_at DESC);

-- The learning queue. The library is what he plays; this is what he watches to
-- get better at playing it. Keyed by YouTube id because that is the only
-- identifier a video keeps across playlists, re-uploads of the URL, and notes
-- written months apart.
CREATE TABLE IF NOT EXISTS learn_videos(
  video_id TEXT PRIMARY KEY, title TEXT NOT NULL, channel TEXT, duration INTEGER,
  kind TEXT NOT NULL DEFAULT 'tutorial' CHECK(kind IN ('tutorial','set')),
  topic TEXT,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK(status IN ('queued','watching','done','skipped')),
  notes TEXT NOT NULL DEFAULT '',
  -- yt-dlp chapter list, cached so the pane can offer jump points offline.
  chapters TEXT,
  -- Seconds into the video, so "go through it" survives closing the tab.
  position INTEGER NOT NULL DEFAULT 0,
  sort INTEGER DEFAULT 0, added_at INTEGER, watched_at INTEGER);
CREATE INDEX IF NOT EXISTS ix_learn_status ON learn_videos(status);
CREATE INDEX IF NOT EXISTS ix_learn_kind ON learn_videos(kind);

-- Append-only, replayable intent log.
-- Deliberately keyed by content hash + playlist NAME rather than internal ids,
-- so the same op can be replayed against the filesystem or rekordbox.
CREATE TABLE IF NOT EXISTS ops(
  id INTEGER PRIMARY KEY, at INTEGER NOT NULL, kind TEXT NOT NULL,
  playlist TEXT, to_playlist TEXT,
  track_hash TEXT, track_path TEXT, track_label TEXT,
  payload TEXT, undone INTEGER DEFAULT 0,
  applied_serato INTEGER DEFAULT 0, applied_rekordbox INTEGER DEFAULT 0,
  applied_fs INTEGER DEFAULT 0);
CREATE INDEX IF NOT EXISTS ix_ops_hash ON ops(track_hash);
CREATE INDEX IF NOT EXISTS ix_ops_at ON ops(at);
`);

/** Additive migrations for columns introduced after the first schema. */
for (const [table, col, decl] of [
  ["tracks", "content_hash", "TEXT"],
  ["tracks", "hash_scope", "TEXT"],
  ["tracks", "hashed_at", "INTEGER"],
  ["tracks", "favorite", "INTEGER DEFAULT 0"],
  // YouTube's own reported track count, which is NOT the number of tracks we
  // keep (unavailable entries get dropped, so `count` runs a few lower).
  // Stored separately from fetched rows so the upstream reported total stays
  // visible when unavailable entries are dropped.
  ["ytm_playlists", "track_count", "INTEGER"],
  // Greyed out upstream (deleted/blocked): staged with an `unavailable` flag.
  ["ytm_tracks", "unavailable", "INTEGER DEFAULT 0"],
] as const) {
  const cols = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
}
db.exec("CREATE INDEX IF NOT EXISTS ix_tracks_hash ON tracks(content_hash)");

export type TrackRow = {
  id: number; path: string; filename: string; folder: string; ext: string;
  title: string | null; artist: string | null; album: string | null;
  genre: string | null; duration: number | null; bitrate: number | null;
  size: number | null; video_id: string | null; added_at: number; missing: number;
  content_hash: string | null; hash_scope: string | null; hashed_at: number | null;
  favorite: number;
};

export type PlaylistRow = {
  id: number; name: string; sort: number; is_manual: number; created_at: number;
};

export function log(op: string, args: unknown, result = "") {
  try {
    appendFileSync(
      join(DATA, "ops.log"),
      JSON.stringify({ ts: Math.floor(Date.now() / 1000), op, args, result }) + "\n",
    );
  } catch { /* logging must never break an operation */ }
}

export function getMeta(key: string): string | null {
  const r = db.query<{ value: string }, [string]>(
    "SELECT value FROM meta WHERE key=?").get(key);
  return r?.value ?? null;
}

export function setMeta(key: string, value: string | number) {
  db.query(
    "INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  ).run(key, String(value));
}

export function markDirty(...targets: string[]) {
  for (const t of targets) setMeta(`${t}_dirty`, "1");
}

export const now = () => Math.floor(Date.now() / 1000);
