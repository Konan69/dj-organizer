import { readdirSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

/** WSL sees the Windows C: drive here; rekordbox paths use the same mapping. */
export const MNT_ROOT = "/mnt/c";
export const WIN_ROOT = "C:";

export const LIB = "/mnt/c/Users/you/Music/tracks";
// rekordbox stays read-only. download.ts is the sole LIB writer and may only
// add files; every other use exists to scan and diff external state.
export const RBX_DB = "/mnt/c/Users/you/AppData/Roaming/Pioneer/rekordbox/master.db";
export const BACKUP_DIR = "/mnt/c/Users/you/.dl";

export const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const TEST_DATA = process.env.NODE_ENV === "test" ? process.env.DJ_ORGANIZER_TEST_DATA : undefined;
export const DATA = TEST_DATA || join(ROOT, "data");
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
