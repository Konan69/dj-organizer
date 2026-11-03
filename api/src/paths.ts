import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

/** WSL sees the Windows C: drive here; rekordbox paths use the same mapping. */
export const MNT_ROOT = "/mnt/c";
export const WIN_ROOT = "C:";

const env = (name: string) => process.env[name]?.trim() || undefined;

export const LIB = resolve(env("DJ_LIBRARY_ROOT") ?? join(homedir(), "Music", "tracks"));
// rekordbox stays read-only. download.ts is the sole LIB writer and may only
// add files; every other use exists to scan and diff external state.
export const RBX_DIR = resolve(env("DJ_REKORDBOX_DIR") ?? join(homedir(), "AppData", "Roaming", "Pioneer", "rekordbox"));
export const RBX_DB = join(RBX_DIR, "master.db");
export const RBX_SHARE = join(RBX_DIR, "share");

/** Comma-separated playlist names from the environment; empty when unset. */
const envList = (name: string) => (env(name) ?? "").split(",").map((s) => s.trim()).filter(Boolean);
/** Hand-curated playlists: imported as manual, and dedupe never writes into them. */
export const MANUAL_PLAYLISTS = envList("DJ_MANUAL_PLAYLISTS");
/** Local playlists the periodic sync never pulls or stages. */
export const SYNC_EXCLUDED_PLAYLISTS = envList("DJ_SYNC_EXCLUDED_PLAYLISTS");
/** User-curated or deliberately capped playlists that never receive automatic memberships. */
export const AUTO_MEMBERSHIP_EXCLUDED_PLAYLISTS = envList("DJ_AUTO_MEMBERSHIP_EXCLUDED_PLAYLISTS");

export const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const TEST_DATA = process.env.NODE_ENV === "test" ? process.env.DJ_ORGANIZER_TEST_DATA : undefined;
export const DATA = TEST_DATA || resolve(env("DJ_DATA_DIR") ?? join(ROOT, "data"));
export const DB_PATH = join(DATA, "library.db");
export const PY_DIR = join(ROOT, "api", "py");
export const WEB_DIST = join(ROOT, "web", "dist");

/** Windows-backed library paths identify the same file regardless of casing. */
export const pathKey = (path: string) => path.toLowerCase();

/**
 * Preserve the spelling already present on disk for every existing directory.
 * Missing suffixes retain the requested spelling and may be created by the downloader.
 */
export function existingDirectoryCase(root: string, target: string) {
  const rel = relative(root, target);
  if (!rel || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) return target;

  let current = root;
  for (const requested of rel.split(/[\\/]/)) {
    let existing: string | undefined;
    try {
      const dirs = readdirSync(current, { withFileTypes: true }).filter((entry) => entry.isDirectory());
      existing = dirs.find((entry) => entry.name === requested)?.name
        ?? dirs.find((entry) => pathKey(entry.name) === pathKey(requested))?.name;
    } catch { /* A missing parent means this and the remaining suffix are new. */ }
    current = join(current, existing ?? requested);
  }
  return current;
}

export const toWin = (p: string) =>
  p.startsWith(MNT_ROOT + "/") ? WIN_ROOT + p.slice(MNT_ROOT.length) : p;

export const toWsl = (p: string) =>
  p.startsWith(WIN_ROOT + "/") ? MNT_ROOT + p.slice(WIN_ROOT.length) : p;
