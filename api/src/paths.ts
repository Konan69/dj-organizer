import { join } from "node:path";

/** WSL sees the Windows C: drive here; Serato crates store real Windows-relative paths. */
export const MNT_ROOT = "/mnt/c";
export const WIN_ROOT = "C:";

export const LIB = "/mnt/c/Users/you/Music/tracks";
export const TRASH = join(LIB, "_TRASH");
export const SUBCRATES = "/mnt/c/Users/you/Music/_Serato_/Subcrates";
export const RBX_DB = "/mnt/c/Users/you/AppData/Roaming/Pioneer/rekordbox/master.db";
export const BACKUP_DIR = "/mnt/c/Users/you/.dl";

export const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
export const DATA = join(ROOT, "data");
export const DB_PATH = join(DATA, "library.db");
export const PY_DIR = join(ROOT, "api", "py");
export const WEB_DIST = join(ROOT, "web", "dist");

export const toWin = (p: string) =>
  p.startsWith(MNT_ROOT + "/") ? WIN_ROOT + p.slice(MNT_ROOT.length) : p;

export const toWsl = (p: string) =>
  p.startsWith(WIN_ROOT + "/") ? MNT_ROOT + p.slice(WIN_ROOT.length) : p;
