/**
 * Duplicate detection.
 *
 *   twin — same folder + same stem, different container (.webm beside .m4a).
 *          The non-m4a copy is dead weight: rekordbox can't read it.
 *   same — the same YouTube video id indexed at more than one path. Keeping one
 *          file and letting playlist membership do the rest beats two copies.
 *
 * Nothing here deletes. It proposes a keeper and a list of redundant copies.
 */
import { extname } from "node:path";
import { db, log, markDirty, now } from "./db";

const RANK: Record<string, number> = { m4a: 0, flac: 1, wav: 2, aiff: 3, mp3: 4, webm: 9 };

export type DupTrack = {
  id: number; path: string; filename: string; folder: string; ext: string;
  title: string | null; artist: string | null; bitrate: number | null;
  size: number | null; duration: number | null; video_id: string | null;
  content_hash: string | null; playlists: number[];
};

/**
 * Ordered by strength of evidence:
 *   identical — byte-identical audio payload. Not a guess.
 *   source    — same YouTube video, different encoding (260k vs 132k rip).
 *   twin      — same folder + stem, different container (.webm beside .m4a).
 * Filename similarity alone is never enough to call something a duplicate.
 */
export type DupGroup = {
  kind: "identical" | "source" | "twin";
  why: string;
  keep: DupTrack;
  redundant: DupTrack[];
  reclaim: number;
};

/**
 * Lower sorts first. A copy that sits in a manually curated playlist always
 * wins, so resolving a duplicate can never add a track *into* one of those —
 * BANGERS !!!! is hand-curated and nothing automatic may change it. After that:
 * prefer a DJ-readable container, then higher bitrate, then the bigger file.
 */
const score = (t: DupTrack, manual: Set<number>): [number, number, number, number] => [
  t.playlists.some((p) => manual.has(p)) ? 0 : 1,
  RANK[t.ext] ?? 8,
  -(t.bitrate ?? 0),
  -(t.size ?? 0),
];

const cmp = (manual: Set<number>) => (a: DupTrack, b: DupTrack) => {
  const x = score(a, manual), y = score(b, manual);
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2] || x[3] - y[3];
};

export function find() {
  const rows = db.query<Omit<DupTrack, "playlists">, []>(
    `SELECT id,path,filename,folder,ext,title,artist,bitrate,size,duration,video_id,content_hash
     FROM tracks WHERE missing=0`).all();

  const mem = new Map<number, number[]>();
  for (const r of db.query<{ playlist_id: number; track_id: number }, []>(
    "SELECT playlist_id,track_id FROM memberships").all()) {
    const list = mem.get(r.track_id);
    if (list) list.push(r.playlist_id); else mem.set(r.track_id, [r.playlist_id]);
  }

  const manual = new Set(
    db.query<{ id: number }, []>("SELECT id FROM playlists WHERE is_manual=1")
      .all().map((r) => r.id));

  const tracks: DupTrack[] = rows.map((r) => ({ ...r, playlists: mem.get(r.id) ?? [] }));
  const groups: DupGroup[] = [];
  const claimed = new Set<number>();
  const byScore = cmp(manual);

  const emit = (kind: DupGroup["kind"], members: DupTrack[], why: string) => {
    const sorted = [...members].sort(byScore);
    const [keep, ...redundant] = sorted;
    if (!keep || !redundant.length) return;
    for (const m of sorted) claimed.add(m.id);
    groups.push({
      kind, why, keep, redundant,
      reclaim: redundant.reduce((n, m) => n + (m.size ?? 0), 0),
    });
  };

  // 1. byte-identical audio — the only tier that is proof rather than inference
  const byHash = new Map<string, DupTrack[]>();
  for (const t of tracks) {
    if (!t.content_hash) continue;
    const list = byHash.get(t.content_hash);
    if (list) list.push(t); else byHash.set(t.content_hash, [t]);
  }
  for (const members of byHash.values()) {
    if (members.length > 1) {
      const folders = [...new Set(members.map((m) => m.folder || "root"))].sort();
      emit("identical", members, `identical audio in ${folders.join(" + ")}`);
    }
  }

  // 2. same source video, different encoding
  const byVid = new Map<string, DupTrack[]>();
  for (const t of tracks) {
    if (!t.video_id || claimed.has(t.id)) continue;
    const list = byVid.get(t.video_id);
    if (list) list.push(t); else byVid.set(t.video_id, [t]);
  }
  for (const members of byVid.values()) {
    if (members.length > 1) {
      const rates = members.map((m) => `${m.bitrate ?? "?"}k`).join(" / ");
      emit("source", members, `same source video, different encodings (${rates})`);
    }
  }

  // 3. same name, different container
  const byStem = new Map<string, DupTrack[]>();
  for (const t of tracks) {
    if (claimed.has(t.id)) continue;
    const stem = t.filename.slice(0, t.filename.length - extname(t.filename).length);
    const key = `${t.folder}\u0000${stem}`;
    const list = byStem.get(key);
    if (list) list.push(t); else byStem.set(key, [t]);
  }
  for (const [key, members] of byStem) {
    if (members.length > 1) {
      emit("twin", members, `same name in ${key.split("\u0000")[0] || "root"}, different format`);
    }
  }

  groups.sort((a, b) => b.reclaim - a.reclaim);
  return {
    groups,
    redundantIds: groups.flatMap((g) => g.redundant.map((m) => m.id)),
    count: groups.reduce((n, g) => n + g.redundant.length, 0),
    reclaim: groups.reduce((n, g) => n + g.reclaim, 0),
  };
}

/**
 * Fold every redundant copy's playlists into its keeper, then stage the copies
 * for deletion. Still non-destructive: deletion needs an explicit Apply.
 */
export function resolveAll() {
  const d = find();
  const addMem = db.query(
    "INSERT OR IGNORE INTO memberships(playlist_id,track_id,sort) VALUES(?,?,0)");
  const queue = db.query(
    "INSERT OR IGNORE INTO pending_deletes(track_id,queued_at,reason) VALUES(?,?,?)");

  const manual = new Set(
    db.query<{ id: number }, []>("SELECT id FROM playlists WHERE is_manual=1")
      .all().map((r) => r.id));

  let merged = 0;
  let skippedManual = 0;
  const ts = now();
  db.transaction(() => {
    for (const g of d.groups) {
      for (const m of g.redundant) {
        for (const pid of m.playlists) {
          // Never let dedupe write into a hand-curated playlist.
          if (manual.has(pid)) { skippedManual++; continue; }
          merged += addMem.run(pid, g.keep.id).changes;
        }
        queue.run(m.id, ts, "duplicate");
      }
    }
  })();

  if (d.count) markDirty("changes");
  log("dupes_resolve", { groups: d.groups.length },
    `${d.count} staged, ${merged} memberships merged, ${skippedManual} manual skipped`);
  return {
    groups: d.groups.length, staged: d.count,
    membershipsMerged: merged, skippedManual, reclaim: d.reclaim,
  };
}
