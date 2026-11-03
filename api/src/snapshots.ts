/**
 * Staging persistence.
 *
 * The staging DB (data/library.db) is the only place this app's work lives, so
 * it must survive restarts and be recoverable if a bulk action goes wrong.
 * Snapshots are taken before anything that changes membership in bulk.
 */
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { db, log, now } from "./db";
import { DATA, DB_PATH } from "./paths";

const SNAP_DIR = join(DATA, "snapshots");
const KEEP = 20;

export function snapshot(reason: string) {
  mkdirSync(SNAP_DIR, { recursive: true });
  const name = `${now()}-${reason.replace(/[^a-z0-9]+/gi, "-")}.db`;
  const dst = join(SNAP_DIR, name);
  // SQLite writes the copy itself, WAL included. Never copy the live file with
  // fs: opening and closing a second descriptor on library.db inside this
  // process silently drops every POSIX lock SQLite holds on it, and the next
  // outside connection to close then believes it is the last one and deletes
  // the WAL from under the running server (2026-09-24: an hour of writes lived
  // only in a deleted -wal until recovered from /proc/<pid>/fd).
  db.query("VACUUM INTO ?").run(dst);

  const all = readdirSync(SNAP_DIR).filter((f) => f.endsWith(".db")).sort();
  for (const old of all.slice(0, Math.max(0, all.length - KEEP))) {
    try { unlinkSync(join(SNAP_DIR, old)); } catch { /* best effort */ }
  }
  log("snapshot", { reason }, name);
  return { name, path: dst, reason };
}

export function list() {
  if (!existsSync(SNAP_DIR)) return [];
  return readdirSync(SNAP_DIR)
    .filter((f) => f.endsWith(".db"))
    .sort()
    .reverse()
    .map((f) => {
      const [ts, ...rest] = f.replace(/\.db$/, "").split("-");
      return {
        name: f,
        at: Number(ts),
        reason: rest.join("-"),
        size: statSync(join(SNAP_DIR, f)).size,
      };
    });
}

/**
 * Restore is deliberately not wired to a route: swapping the DB file under a
 * live connection corrupts it. Stop the server, copy the snapshot over
 * data/library.db, delete the -wal/-shm siblings, start again.
 */
export function restoreHint(name: string) {
  return {
    steps: [
      "stop the server",
      `cp ${join(SNAP_DIR, name)} ${DB_PATH}`,
      `rm -f ${DB_PATH}-wal ${DB_PATH}-shm`,
      "start the server",
    ],
  };
}
