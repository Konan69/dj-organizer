/**
 * Observing the two stores that hold this library.
 *
 *   fs         the audio files themselves  — the only complete set of content,
 *              but it cannot express membership (a file lives in one folder)
 *   rekordbox  master.db                   — the user's primary, and the one
 *              most prone to drift (it keeps rows for files long since moved)
 *
 * None of them is authoritative. Each is recorded as a timestamped observation
 * and diffed against staged intent by content hash, never by path or mtime.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { db, log, now } from "./db";
import { LIB, pathKey, RBX_DB } from "./paths";
import { py } from "./py";

export type StoreName = "fs" | "rekordbox";

export type ObservedTrack = {
  path: string;
  label: string;
  hash: string | null;
  videoId: string | null;
};

export type RekordboxTrack = {
  sourceId: string;
  path: string;
  title: string | null;
  artist: string | null;
  bpm: number | null;
  key: string | null;
  comment: string | null;
  analysisDataPath: string | null;
  cues: RekordboxCue[];
  trackNo: number | null;
  fileSize: number | null;
  bitRate: number | null;
  length: number | null;
};

export type RekordboxCue = {
  id: string;
  time: number;
  endTime: number | null;
  kind: "hot" | "memory";
  index: number | null;
  rawKind: number;
  label: string;
  comment: string | null;
};

export type RekordboxAnalysis = {
  status: "ready" | "partial" | "missing";
  source: "rekordbox";
  beats: { time: number; beat: number; bpm: number }[];
  phrases: { start: number; end: number; label: string; kind: number; mood: number }[];
  waveform: { samples: number[]; source: "PWAV" } | null;
  issues: string[];
  observedAt: number;
};

export type RekordboxPlaylist = {
  sourceId: string;
  name: string;
  parentSourceId: string | null;
  sort: number | null;
  members: { sourceId: string; trackSourceId: string; position: number | null }[];
};

export type Observation = {
  store: StoreName;
  observedAt: number;
  available: boolean;
  reason?: string;
  /** playlist / folder name -> member paths */
  groups: Record<string, string[]>;
  /** every distinct path the store references */
  paths: string[];
  /** paths the store references that do not exist on disk */
  dangling: string[];
  /** Rich records are present for Rekordbox snapshots and absent for fs. */
  tracks?: RekordboxTrack[];
  playlists?: RekordboxPlaylist[];
};

const AUDIO = new Set([".m4a", ".webm", ".mp3", ".wav", ".aiff", ".flac"]);
const SKIP = new Set(["_TRASH", "PioneerDJ", "rekordbox"]);
const uniquePaths = (paths: string[]) =>
  [...new Map(paths.map((path) => [pathKey(path), path])).values()];

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

type RbxDump = {
  error?: string;
  running?: boolean;
  playlists?: Record<string, string[]>;
  content?: string[];
  tracks?: unknown[];
  playlistRecords?: unknown[];
};

const textOrNull = (value: unknown) => typeof value === "string" && value.trim() ? value : null;
const finiteOrNull = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;
const bpmOrNull = (value: unknown) => {
  const bpm = finiteOrNull(value);
  return bpm !== null && bpm >= 20 && bpm <= 300 ? bpm : null;
};

function parseTracks(rows: unknown[] | undefined): RekordboxTrack[] {
  return (rows ?? []).flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const r = raw as Record<string, unknown>;
    if (typeof r.sourceId !== "string" || typeof r.path !== "string") return [];
    const cues = Array.isArray(r.cues) ? r.cues.flatMap((rawCue): RekordboxCue[] => {
      if (!rawCue || typeof rawCue !== "object") return [];
      const cue = rawCue as Record<string, unknown>;
      const time = finiteOrNull(cue.time);
      if (typeof cue.id !== "string" || time === null || time < 0
        || (cue.kind !== "hot" && cue.kind !== "memory") || typeof cue.label !== "string") return [];
      const endTime = finiteOrNull(cue.endTime);
      const index = finiteOrNull(cue.index);
      const rawKind = finiteOrNull(cue.rawKind);
      if (rawKind === null || !Number.isInteger(rawKind)) return [];
      return [{ id: cue.id, time, endTime: endTime !== null && endTime >= 0 ? endTime : null,
        kind: cue.kind, index: index !== null && Number.isInteger(index) ? index : null,
        rawKind, label: cue.label, comment: textOrNull(cue.comment) }];
    }) : [];
    return [{
      sourceId: r.sourceId, path: r.path, title: textOrNull(r.title),
      artist: textOrNull(r.artist), bpm: bpmOrNull(r.bpm), key: textOrNull(r.key),
      comment: textOrNull(r.comment), analysisDataPath: textOrNull(r.analysisDataPath), cues,
      trackNo: finiteOrNull(r.trackNo),
      fileSize: finiteOrNull(r.fileSize), bitRate: finiteOrNull(r.bitRate),
      length: finiteOrNull(r.length),
    }];
  });
}

function parsePlaylists(rows: unknown[] | undefined): RekordboxPlaylist[] {
  return (rows ?? []).flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const r = raw as Record<string, unknown>;
    if (typeof r.sourceId !== "string" || typeof r.name !== "string") return [];
    const members = Array.isArray(r.members) ? r.members.flatMap((rawMember) => {
      if (!rawMember || typeof rawMember !== "object") return [];
      const m = rawMember as Record<string, unknown>;
      if (typeof m.sourceId !== "string" || typeof m.trackSourceId !== "string") return [];
      return [{ sourceId: m.sourceId, trackSourceId: m.trackSourceId, position: finiteOrNull(m.position) }];
    }) : [];
    return [{ sourceId: r.sourceId, name: r.name,
      parentSourceId: textOrNull(r.parentSourceId), sort: finiteOrNull(r.sort), members }];
  });
}

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
  const paths = uniquePaths([...(dump.content ?? []), ...Object.values(groups).flat()]);
  return {
    store: "rekordbox",
    observedAt: now(),
    available: true,
    groups,
    paths,
    dangling: paths.filter((p) => !existsSync(p)),
    tracks: parseTracks(dump.tracks),
    playlists: parsePlaylists(dump.playlistRecords),
  };
}

export async function observeAll(): Promise<Record<StoreName, Observation>> {
  const [fs, rbx] = [observeFs(), await observeRekordbox()];
  for (const o of [fs, rbx]) record(o);
  return { fs, rekordbox: rbx };
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

/**
 * The most recent look that actually saw the store. A failed read (rekordbox
 * open and holding its database, master.db missing) is still recorded as
 * evidence of the attempt, but it saw nothing — treating it as "rekordbox has
 * no playlists" made every applied change read as owed again.
 */
export function latest(store: StoreName): Observation | null {
  const r = db.query<{ payload: string }, [string]>(
    `SELECT payload FROM observations WHERE store=?
       AND coalesce(json_extract(payload, '$.available'), 1) = 1
     ORDER BY observed_at DESC LIMIT 1`,
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
         WHERE store IN ('fs','rekordbox')
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
    if (r.content_hash) hashByPath.set(pathKey(r.path), r.content_hash);
  }
  const key = (p: string) => hashByPath.get(pathKey(p)) ?? `p:${pathKey(p)}`;
  const keysOf = (o: Observation) => new Set(o.paths.map(key));
  const inLibrary = (p: string) => pathKey(p).startsWith(`${pathKey(LIB)}/`);

  const fs = keysOf(obs.fs);
  // Rekordbox's collection also contains its own sampler presets outside the
  // user's music folder. They exist on disk, but are not part of this library.
  const rbx = new Set(obs.rekordbox.paths.filter(inLibrary).map(key));
  const diff = (a: Set<string>, b: Set<string>) => [...a].filter((x) => !b.has(x)).length;

  const names = [...new Set([
    ...Object.keys(obs.fs.groups),
    ...Object.keys(obs.rekordbox.groups),
  ])].filter((n) => n !== "(root)").sort();

  return {
    totals: {
      fs: fs.size,
      rekordbox: rbx.size,
    },
    missing: {
      notInRekordbox: diff(fs, rbx),
      rekordboxNotOnDisk: diff(rbx, fs),
    },
    dangling: {
      rekordbox: obs.rekordbox.dangling.filter(inLibrary).length,
    },
    available: {
      fs: obs.fs.available,
      rekordbox: obs.rekordbox.available,
      rekordboxReason: obs.rekordbox.reason ?? null,
    },
    groups: names.map((name) => {
      // Playlist and folder names can drift in case ("Vibe" vs "vibe").
      const lookup = (g: Record<string, string[]>) =>
        g[name] ?? g[Object.keys(g).find((k) => k.toLowerCase() === name.toLowerCase()) ?? ""] ?? [];
      const f = lookup(obs.fs.groups);
      const r = lookup(obs.rekordbox.groups);
      const caseOnly = !obs.fs.groups[name] || !obs.rekordbox.groups[name];
      return {
        name, fs: f.length, rekordbox: r.length,
        agree: f.length === r.length,
        caseMismatch: caseOnly && (f.length > 0 || r.length > 0),
      };
    }),
  };
}
