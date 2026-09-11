/**
 * Observing the three stores that hold this library.
 *
 *   fs         the audio files themselves  — the only complete set of content,
 *              but it cannot express membership (a file lives in one folder)
 *   serato     .crate files                — rewritten by Serato on exit
 *   rekordbox  master.db                   — the user's primary, and the one
 *              most prone to drift (it keeps rows for files long since moved)
 *
 * None of them is authoritative. Each is recorded as a timestamped observation
 * and diffed against staged intent by content hash, never by path or mtime.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { db, log, now } from "./db";
import { LIB, RBX_DB } from "./paths";
import { py } from "./py";
import * as serato from "./serato";

export type StoreName = "fs" | "serato" | "rekordbox";

export type ObservedTrack = {
  path: string;
  label: string;
  hash: string | null;
  videoId: string | null;
};

export type Observation = {
  store: StoreName;
  observedAt: number;
  available: boolean;
  reason?: string;
  /** playlist / crate / folder name -> member paths */
  groups: Record<string, string[]>;
  /** every distinct path the store references */
  paths: string[];
  /** paths the store references that do not exist on disk */
  dangling: string[];
};

const AUDIO = new Set([".m4a", ".webm", ".mp3", ".wav", ".aiff", ".flac"]);
const SKIP = new Set(["_TRASH", "_Serato_", "_Serato_Backup", "PioneerDJ", "rekordbox"]);

function* walk(dir: string): Generator<string> {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP.has(e.name) || e.name.startsWith(".")) continue;
      yield* walk(full);
    } else if (AUDIO.has(extname(e.name).toLowerCase())) yield full;
  }
}

export function observeFs(): Observation {
  const groups: Record<string, string[]> = {};
  const paths: string[] = [];
  for (const p of walk(LIB)) {
    const rel = relative(LIB, join(p, "..")).split("\\").join("/");
    const folder = rel === "" || rel === "." ? "(root)" : rel;
    (groups[folder] ??= []).push(p);
    paths.push(p);
  }
  return { store: "fs", observedAt: now(), available: true, groups, paths, dangling: [] };
}

export function observeSerato(): Observation {
  const groups = serato.readAll();
  const paths = [...new Set(Object.values(groups).flat())];
  return {
    store: "serato",
    observedAt: now(),
    available: Object.keys(groups).length > 0,
    groups,
    paths,
    dangling: paths.filter((p) => !existsSync(p)),
  };
}

type RbxDump = {
  error?: string;
  running?: boolean;
  playlists?: Record<string, string[]>;
  content?: string[];
};

export async function observeRekordbox(): Promise<Observation> {
  const base = { store: "rekordbox" as const, observedAt: now(), groups: {}, paths: [], dangling: [] };
  if (!existsSync(RBX_DB)) return { ...base, available: false, reason: "master.db not found" };

  let dump: RbxDump;
  try {
    dump = await py<RbxDump>("rekordbox_bridge.py", "dump", {}, 300_000);
  } catch (e) {
    return { ...base, available: false, reason: (e as Error).message };
  }
  if (dump.error) return { ...base, available: false, reason: dump.error };

  const groups = dump.playlists ?? {};
  const paths = [...new Set([...(dump.content ?? []), ...Object.values(groups).flat()])];
  return {
    store: "rekordbox",
    observedAt: now(),
    available: true,
    groups,
    paths,
    dangling: paths.filter((p) => !existsSync(p)),
  };
}

export async function observeAll(): Promise<Record<StoreName, Observation>> {
  const [fs, ser, rbx] = [observeFs(), observeSerato(), await observeRekordbox()];
  for (const o of [fs, ser, rbx]) record(o);
  return { fs, serato: ser, rekordbox: rbx };
}

/** Persist an observation verbatim; these rows are evidence and are never edited. */
export function record(o: Observation) {
  const payload = JSON.stringify(o);
  const digest = Bun.hash.xxHash64(payload).toString(16);
  const prev = db.query<{ digest: string }, [string]>(
    "SELECT digest FROM observations WHERE store=? ORDER BY observed_at DESC LIMIT 1",
  ).get(o.store);
  if (prev?.digest === digest) return { store: o.store, changed: false, digest };

  db.query(
    "INSERT INTO observations(store,observed_at,tracks,playlists,digest,payload) VALUES(?,?,?,?,?,?)",
  ).run(o.store, o.observedAt, o.paths.length, Object.keys(o.groups).length, digest, payload);
  log("observe", { store: o.store }, `${o.paths.length} paths, digest ${digest}`);
  return { store: o.store, changed: true, digest };
}

export function latest(store: StoreName): Observation | null {
  const r = db.query<{ payload: string }, [string]>(
    "SELECT payload FROM observations WHERE store=? ORDER BY observed_at DESC LIMIT 1",
  ).get(store);
  return r ? (JSON.parse(r.payload) as Observation) : null;
}

export function history(store?: StoreName) {
  const rows = store
    ? db.query<Record<string, unknown>, [string]>(
        `SELECT id,store,observed_at,tracks,playlists,digest FROM observations
         WHERE store=? ORDER BY observed_at DESC LIMIT 50`).all(store)
    : db.query<Record<string, unknown>, []>(
        `SELECT id,store,observed_at,tracks,playlists,digest FROM observations
         ORDER BY observed_at DESC LIMIT 50`).all();
  return rows;
}

/**
 * How far each store has drifted from the others, by content hash where we have
 * one and by path otherwise. This is the honest answer to "which is the source
 * of truth": whichever the user decides, with the cost of choosing made explicit.
 */
export function compare(obs: Record<StoreName, Observation>) {
  const hashByPath = new Map<string, string>();
  for (const r of db.query<{ path: string; content_hash: string | null }, []>(
    "SELECT path, content_hash FROM tracks").all()) {
    if (r.content_hash) hashByPath.set(r.path, r.content_hash);
  }
  const key = (p: string) => hashByPath.get(p) ?? `p:${p.toLowerCase()}`;
  const keysOf = (o: Observation) => new Set(o.paths.map(key));

  const fs = keysOf(obs.fs);
  const ser = keysOf(obs.serato);
  const rbx = keysOf(obs.rekordbox);
  const diff = (a: Set<string>, b: Set<string>) => [...a].filter((x) => !b.has(x)).length;

  const names = [...new Set([
    ...Object.keys(obs.fs.groups), ...Object.keys(obs.serato.groups),
    ...Object.keys(obs.rekordbox.groups),
  ])].filter((n) => n !== "(root)").sort();

  return {
    totals: {
      fs: fs.size,
      serato: ser.size,
      rekordbox: rbx.size,
    },
    missing: {
      notInSerato: diff(fs, ser),
      notInRekordbox: diff(fs, rbx),
      seratoNotOnDisk: diff(ser, fs),
      rekordboxNotOnDisk: diff(rbx, fs),
    },
    dangling: {
      serato: obs.serato.dangling.length,
      rekordbox: obs.rekordbox.dangling.length,
    },
    available: {
      fs: obs.fs.available,
      serato: obs.serato.available,
      rekordbox: obs.rekordbox.available,
      rekordboxReason: obs.rekordbox.reason ?? null,
    },
    groups: names.map((name) => {
      // Crate and folder names have drifted in case ("Vibe" vs "vibe").
      const lookup = (g: Record<string, string[]>) =>
        g[name] ?? g[Object.keys(g).find((k) => k.toLowerCase() === name.toLowerCase()) ?? ""] ?? [];
      const f = lookup(obs.fs.groups);
      const s = lookup(obs.serato.groups);
      const r = lookup(obs.rekordbox.groups);
      const caseOnly = !obs.fs.groups[name] || !obs.serato.groups[name] || !obs.rekordbox.groups[name];
      return {
        name, fs: f.length, serato: s.length, rekordbox: r.length,
        agree: f.length === s.length && s.length === r.length,
        caseMismatch: caseOnly && (f.length > 0 || s.length > 0 || r.length > 0),
      };
    }),
  };
}
