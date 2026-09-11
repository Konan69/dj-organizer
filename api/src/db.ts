/**
 * Files never move on disk. Genre folders are storage; playlists are metadata.
 * The only filesystem mutation in the app is applyDeletes(), and that moves
 * files to _TRASH rather than unlinking them.
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
`);

export type TrackRow = {
  id: number; path: string; filename: string; folder: string; ext: string;
  title: string | null; artist: string | null; album: string | null;
  genre: string | null; duration: number | null; bitrate: number | null;
  size: number | null; video_id: string | null; added_at: number; missing: number;
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
