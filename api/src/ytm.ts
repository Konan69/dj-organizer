/**
 * Upstream diff against YouTube Music.
 *
 * Unauthenticated by design — see api/py/ytm_bridge.py for why the signed-in
 * path is unavailable and why it does not matter. Playlist reads use the
 * innertube reader shared with the dj-sync Worker (worker/src/ytm.ts); channel
 * discovery still goes through Python. Name matching, caching and diffing live here.
 */
import { db, log, markDirty, now, setMeta } from "./db";
import * as ops from "./ops";
import { py } from "./py";
import { fetchPlaylist } from "../../worker/src/ytm";
import { norm } from "./tags";

type BridgeStatus = { reachable: boolean; reason: string | null; owner: string | null };
type BridgeDiscover = {
  channel: string; owner: string | null;
  playlists: { ytmId: string; title: string }[];
};
type BridgeFetch = {
  playlists: {
    name: string; ytmId: string; title: string;
    /** YouTube's own count, which runs above `tracks.length` (dropped entries). */
    trackCount: number | null;
    tracks: { videoId: string; title: string | null; artist: string; sort: number;
      unavailable?: boolean }[];
  }[];
  errors: { playlist: string; error: string }[];
};

export type StagedStatus = "pending" | "approved" | "rejected" | "downloaded";

export type StagedRow = {
  videoId: string;
  ytmId: string | null;
  localPlaylist: string;
  title: string | null;
  artist: string | null;
  status: StagedStatus;
  flags: string;
  stagedAt: number | null;
};

/** User-curated or deliberately capped playlists must never receive automatic memberships. */
/** Local playlists the periodic sync never pulls or stages. */
export const SYNC_EXCLUDED_PLAYLISTS = ["Chill house", "Dubstep"] as const;
const syncExcludedSql = SYNC_EXCLUDED_PLAYLISTS.map((n) => `'${n}'`).join(",");

export const AUTO_MEMBERSHIP_EXCLUDED_PLAYLISTS = [
  "BANGERS !!!!",
  "Chill house",
  "Dubstep",
  "OG Grime",
] as const;

export async function status() {
  const s = await py<BridgeStatus>("ytm_bridge.py", "status", {}, 90_000);
  const c = db.query<{ known: number; linked: number; fetched: number }, []>(
    `SELECT COUNT(*) known,
            COUNT(local_playlist_id) linked,
            COUNT(CASE WHEN fetched_at > 0 THEN 1 END) fetched
     FROM ytm_playlists`).get()!;
  return {
    // Never call this key `error`: unwrap() on the client treats any `error`
    // key as a failed request, so a perfectly healthy status with error:null
    // used to throw and leave the modal stuck on "Checking…" forever.
    reachable: s.reachable,
    reason: s.reason,
    owner: s.owner,
    lastSync: getNum("last_ytm_sync"),
    discovered: c.known,
    linked: c.linked,
    fetched: c.fetched,
  };
}

/** Loose enough for “Brostep-Dubstep” vs “Brostep/Dubstep”, strict on letters. */
const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Enumerate the owner's public playlists and link them to local ones by name.
 *
 * Exact normalised match first. Then a containment match, but only when it is
 * unambiguous — two upstream playlists called “Haussss” must not race to claim
 * the same local one, so both are left for the user to pick.
 */
export async function discover() {
  const d = await py<BridgeDiscover>("ytm_bridge.py", "discover", {}, 120_000);

  const locals = db.query<{ id: number; name: string }, []>(
    "SELECT id,name FROM playlists").all();
  const alreadyLinked = new Set(
    db.query<{ local_playlist_id: number }, []>(
      "SELECT local_playlist_id FROM ytm_playlists WHERE local_playlist_id IS NOT NULL")
      .all().map((r) => r.local_playlist_id));

  // localId -> claimants, split by how strong the evidence is. Two upstream
  // playlists that normalise to the same name (“techno” and “Techno”, the two
  // “Haussss”) are one intent expressed twice, so both may link. Containment
  // is a guess, so it only wins when it is the only claim on that playlist.
  const exactClaims = new Map<number, string[]>();
  const looseClaims = new Map<number, string[]>();
  const wants = new Map<string, number>();

  for (const p of d.playlists) {
    const k = key(p.title);
    const exact = locals.filter((l) => key(l.name) === k);
    const hit = exact.length === 1 ? exact[0]
      : exact.length ? undefined
      : (() => {
          const loose = locals.filter(
            (l) => key(l.name).includes(k) || k.includes(key(l.name)));
          return loose.length === 1 ? loose[0] : undefined;
        })();
    if (!hit) continue;
    wants.set(p.ytmId, hit.id);
    const bucket = exact.length === 1 ? exactClaims : looseClaims;
    bucket.set(hit.id, [...(bucket.get(hit.id) ?? []), p.ytmId]);
  }

  const upsert = db.query(
    `INSERT INTO ytm_playlists(ytm_id,title,count,local_playlist_id,fetched_at)
     VALUES(?,?,0,?,0) ON CONFLICT(ytm_id) DO UPDATE SET
       title=excluded.title,
       local_playlist_id=COALESCE(ytm_playlists.local_playlist_id, excluded.local_playlist_id)`);

  let linked = 0, ambiguous = 0;
  db.transaction(() => {
    for (const p of d.playlists) {
      const localId = wants.get(p.ytmId);
      let link: number | null = null;
      if (localId != null) {
        const isExact = (exactClaims.get(localId) ?? []).includes(p.ytmId);
        // A loose guess never overrides a name that matched exactly, and never
        // competes with another loose guess for the same playlist.
        const ok = isExact || (!exactClaims.has(localId)
          && (looseClaims.get(localId) ?? []).length === 1);
        if (ok) link = localId; else ambiguous++;
      }
      if (link != null) linked++;
      upsert.run(p.ytmId, p.title, link);
    }
  })();

  log("ytm_discover", { channel: d.channel }, `${d.playlists.length} upstream, ${linked} linked`);
  return {
    owner: d.owner, channel: d.channel,
    found: d.playlists.length, linked, ambiguous,
    unlinkedLocal: locals
      .filter((l) => ![...wants.values()].includes(l.id) && !alreadyLinked.has(l.id))
      .map((l) => l.name),
  };
}

/** Everything discovered upstream, with whatever it is linked to locally. */
export function candidates() {
  return db.query<
    { ytmId: string; title: string; localPlaylistId: number | null;
      localName: string | null; count: number; fetchedAt: number }, []
  >(`SELECT y.ytm_id AS ytmId, y.title, y.local_playlist_id AS localPlaylistId,
            p.name AS localName, y.count, y.fetched_at AS fetchedAt
     FROM ytm_playlists y LEFT JOIN playlists p ON p.id = y.local_playlist_id
     ORDER BY (y.local_playlist_id IS NULL), y.title`).all();
}

const junkTitle = /rain sounds|YOUR POPULAR|^\s*$/i;

/** Stage fetched, linked upstream tracks for per-track review before download. */
export function stage() {
  type Candidate = {
    video_id: string; ytm_id: string; local_playlist: string;
    title: string | null; artist: string | null; source_count: number; unavailable: number;
  };
  const rows = db.query<Candidate, []>(
    `SELECT t.video_id,t.ytm_id,p.name AS local_playlist,t.title,t.artist,
            y.count AS source_count, COALESCE(t.unavailable,0) AS unavailable
     FROM ytm_playlists y
     JOIN playlists p ON p.id=y.local_playlist_id
     JOIN ytm_tracks t ON t.ytm_id=y.ytm_id
     WHERE t.video_id IS NOT NULL
       AND p.name NOT IN (${syncExcludedSql})
       AND NOT EXISTS (
         SELECT 1 FROM tracks l
         WHERE l.missing=0 AND l.video_id IS NOT NULL AND l.video_id=t.video_id
       )
     ORDER BY p.name,y.ytm_id,t.sort,t.video_id`).all();

  // A video may occur in more than one linked upstream source. The staged
  // table is intentionally keyed by video_id, so retain one deterministic
  // target and merge safety flags from all observations.
  const unique = new Map<string, Candidate & { flags: Set<string> }>();
  for (const row of rows) {
    const flags = unique.get(row.video_id);
    const rowFlags = new Set<string>();
    if (row.source_count > 300) rowFlags.add("oversized");
    if (row.title !== null && junkTitle.test(row.title)) rowFlags.add("junk");
    if (row.unavailable) rowFlags.add("unavailable");
    if (!flags) unique.set(row.video_id, { ...row, flags: rowFlags });
    else for (const flag of rowFlags) flags.flags.add(flag);
  }

  // Existing rows are review state. Never reset their status, destination, or
  // metadata when staging is rerun; only previously unseen videos are inserted.
  const insert = db.query(`
    INSERT OR IGNORE INTO ytm_staged(
      video_id,ytm_id,local_playlist,title,artist,status,flags,staged_at
    ) VALUES(?,?,?,?,?,'pending',?,?)`);
  const byPlaylist: Record<string, number> = {};
  let staged = 0;
  let skipped = 0;
  const ts = now();

  db.transaction(() => {
    for (const row of unique.values()) {
      const changed = insert.run(
        row.video_id, row.ytm_id, row.local_playlist, row.title, row.artist,
        [...row.flags].join(","), ts,
      ).changes;
      if (!changed) {
        // Review state stays, but a track that went grey upstream gets marked.
        if (row.flags.has("unavailable")) addFlag([row.video_id], "unavailable");
        skipped++;
        continue;
      }
      staged++;
      byPlaylist[row.local_playlist] = (byPlaylist[row.local_playlist] ?? 0) + 1;
    }
  })();

  return { staged, skipped, byPlaylist };
}

/** Staged rows, grouped for review by their local download destination. */
export function staged() {
  const rows = db.query<StagedRow, []>(
    `SELECT video_id AS videoId,ytm_id AS ytmId,local_playlist AS localPlaylist,
            title,artist,status,COALESCE(flags,'') AS flags,staged_at AS stagedAt
     FROM ytm_staged ORDER BY local_playlist,title,artist,video_id`).all();
  const groups = new Map<string, { localPlaylist: string; rows: StagedRow[];
    counts: Record<StagedStatus, number> }>();
  for (const row of rows) {
    let group = groups.get(row.localPlaylist);
    if (!group) {
      group = {
        localPlaylist: row.localPlaylist,
        rows: [],
        counts: { pending: 0, approved: 0, rejected: 0, downloaded: 0 },
      };
      groups.set(row.localPlaylist, group);
    }
    group.rows.push(row);
    group.counts[row.status]++;
  }
  return [...groups.values()];
}

function setStagedStatus(videoIds: string[], status: "approved" | "rejected") {
  const ids = [...new Set(videoIds)];
  const q = db.query(
    `UPDATE ytm_staged SET status=? WHERE video_id=?
     AND status ${status === "approved" ? "IN ('pending','rejected')" : "IN ('pending','approved')"}`,
  );
  let updated = 0;
  db.transaction(() => {
    for (const id of ids) updated += q.run(status, id).changes;
  })();
  return { updated, skipped: ids.length - updated };
}

/**
 * Mark staged tracks with a flag (unavailable, premium, in-library) instead of
 * deciding for the user: approved rows fall back to pending so they are not
 * retried, and stay visible in review with the flag as the reason.
 */
export function addFlag(videoIds: string[], flag: string) {
  const q = db.query(
    `UPDATE ytm_staged SET
       flags = CASE WHEN COALESCE(flags,'')='' THEN ?1
                    WHEN ','||flags||',' LIKE '%,'||?1||',%' THEN flags
                    ELSE flags||','||?1 END,
       status = CASE WHEN status='approved' THEN 'pending' ELSE status END
     WHERE video_id=?2 AND status IN ('pending','approved')`);
  let updated = 0;
  db.transaction(() => { for (const id of new Set(videoIds)) updated += q.run(flag, id).changes; })();
  return { updated };
}

export function approve(videoIds: string[]) {
  return setStagedStatus(videoIds, "approved");
}

export function reject(videoIds: string[]) {
  return setStagedStatus(videoIds, "rejected");
}

export function approved(videoIds?: string[], localPlaylist?: string) {
  const ids = videoIds === undefined ? undefined : [...new Set(videoIds)];
  const params: string[] = [];
  const filters = ["status='approved'"];
  if (ids) {
    if (!ids.length) return [] as StagedRow[];
    filters.push(`video_id IN (${ids.map(() => "?").join(",")})`);
    params.push(...ids);
  }
  if (localPlaylist !== undefined) {
    filters.push("local_playlist=?");
    params.push(localPlaylist);
  }
  return db.query<StagedRow, string[]>(
    `SELECT video_id AS videoId,ytm_id AS ytmId,local_playlist AS localPlaylist,
            title,artist,status,COALESCE(flags,'') AS flags,staged_at AS stagedAt
     FROM ytm_staged WHERE ${filters.join(" AND ")} ORDER BY local_playlist,title,artist,video_id`,
  ).all(...params);
}

type MembershipRequest = {
  playlistId: number;
  playlistName: string;
  trackId: number;
};

type AddedMemberships = Map<string, number[]>;

const linkedMembershipTargets = db.query<
  { playlistId: number; playlistName: string }, [string]
>(`SELECT DISTINCT p.id AS playlistId,p.name AS playlistName
   FROM ytm_tracks t
   JOIN ytm_playlists y ON y.ytm_id=t.ytm_id
   JOIN playlists p ON p.id=y.local_playlist_id
   WHERE t.video_id=?
   ORDER BY p.name,p.id`);

function automaticMembershipTargets(videoId: string) {
  return linkedMembershipTargets.all(videoId).filter((target) =>
    !AUTO_MEMBERSHIP_EXCLUDED_PLAYLISTS.some((name) => name === target.playlistName));
}

/** Insert memberships in playlist order and report only rows actually added. */
function insertMemberships(requests: MembershipRequest[]): AddedMemberships {
  const max = db.query<{ sort: number }, [number]>(
    "SELECT COALESCE(MAX(sort),0) sort FROM memberships WHERE playlist_id=?",
  );
  const add = db.query(
    "INSERT OR IGNORE INTO memberships(playlist_id,track_id,sort) VALUES(?,?,?)");
  const nextSort = new Map<number, number>();
  const seen = new Set<string>();
  const added: AddedMemberships = new Map();

  for (const request of requests) {
    const key = `${request.playlistId}\u0000${request.trackId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const sort = nextSort.get(request.playlistId)
      ?? max.get(request.playlistId)!.sort;
    if (!add.run(request.playlistId, request.trackId, sort + 1).changes) continue;
    nextSort.set(request.playlistId, sort + 1);
    const trackIds = added.get(request.playlistName);
    if (trackIds) trackIds.push(request.trackId);
    else added.set(request.playlistName, [request.trackId]);
  }
  return added;
}

function recordAddedMemberships(added: AddedMemberships) {
  let total = 0;
  for (const [playlist, trackIds] of added) {
    ops.recordMembership("add_to", playlist, trackIds);
    total += trackIds.length;
  }
  if (total) markDirty("changes");
  return total;
}

/** Finalize only tracks that the downloader successfully indexed. */
export function completeStaged(videoIds: string[], localPlaylist: string) {
  const playlist = db.query<{ id: number }, [string]>(
    "SELECT id FROM playlists WHERE name=?").get(localPlaylist);
  if (!playlist) throw new Error(`unknown local playlist ${localPlaylist}`);

  const ids = [...new Set(videoIds)];
  const stagedRows = db.query<{ video_id: string }, [string, string]>(
    `SELECT video_id FROM ytm_staged
     WHERE video_id=? AND local_playlist=? AND status='approved'`,
  );
  const tracks = db.query<{ id: number }, [string]>(
    "SELECT id FROM tracks WHERE video_id=? AND missing=0 ORDER BY id LIMIT 1",
  );
  const mark = db.query(
    "UPDATE ytm_staged SET status='downloaded' WHERE video_id=? AND local_playlist=? AND status='approved'",
  );
  const downloaded: string[] = [];
  const requests: MembershipRequest[] = [];
  let added: AddedMemberships = new Map();

  db.transaction(() => {
    for (const id of ids) {
      if (!stagedRows.get(id, localPlaylist)) continue;
      const track = tracks.get(id);
      if (!track) continue;
      if (mark.run(id, localPlaylist).changes) downloaded.push(id);
      // The download folder remains the primary membership even when it is one
      // of the curated playlists excluded from automatic fan-out.
      requests.push({
        playlistId: playlist.id,
        playlistName: localPlaylist,
        trackId: track.id,
      });
      for (const target of automaticMembershipTargets(id)) {
        requests.push({ ...target, trackId: track.id });
      }
    }
    added = insertMemberships(requests);
  })();

  const membershipsAdded = recordAddedMemberships(added);
  return { downloaded, membershipsAdded };
}

/** Add missing linked-playlist memberships for tracks already in the library. */
export function backfillMemberships() {
  const rows = db.query<MembershipRequest, []>(`
    WITH own AS (
      SELECT video_id,MIN(id) AS trackId
      FROM tracks
      WHERE missing=0 AND video_id IS NOT NULL
      GROUP BY video_id
    ), available AS (
      SELECT o.video_id,COALESCE(r.track_id,o.trackId) AS trackId
      FROM own o LEFT JOIN track_replacements r ON r.video_id=o.video_id
    )
    SELECT DISTINCT p.id AS playlistId,p.name AS playlistName,a.trackId
    FROM available a
    JOIN ytm_tracks t ON t.video_id=a.video_id
    JOIN ytm_playlists y ON y.ytm_id=t.ytm_id
    JOIN playlists p ON p.id=y.local_playlist_id
    ORDER BY p.name,p.id,a.trackId
  `).all().filter((row) =>
    !AUTO_MEMBERSHIP_EXCLUDED_PLAYLISTS.some((name) => name === row.playlistName));

  let added: AddedMemberships = new Map();
  db.transaction(() => { added = insertMemberships(rows); })();
  const total = recordAddedMemberships(added);
  return {
    added: total,
    byPlaylist: Object.fromEntries([...added].map(([name, ids]) => [name, ids.length])),
  };
}

export function unlink(ytmId: string) {
  db.query("UPDATE ytm_playlists SET local_playlist_id=NULL WHERE ytm_id=?").run(ytmId);
}

function getNum(key: string) {
  const r = db.query<{ value: string }, [string]>(
    "SELECT value FROM meta WHERE key=?").get(key);
  return r ? Number(r.value) : null;
}

/**
 * Create a local playlist from an upstream one and link them.
 *
 * An upstream playlist with no local counterpart is a download queue: it has
 * members and we have none of them, which is exactly what the diff is for.
 */
export function adopt(ytmId: string) {
  const y = db.query<{ title: string; local_playlist_id: number | null }, [string]>(
    "SELECT title, local_playlist_id FROM ytm_playlists WHERE ytm_id=?").get(ytmId);
  if (!y) throw new Error(`unknown upstream playlist ${ytmId}`);
  if (y.local_playlist_id) throw new Error("already linked");

  const name = y.title;
  if (db.query("SELECT 1 FROM playlists WHERE name=?").get(name)) {
    throw new Error(`a local playlist named “${name}” already exists — link to it instead`);
  }
  const sort = db.query<{ s: number }, []>(
    "SELECT COALESCE(MAX(sort),0) s FROM playlists").get()!.s;
  const { lastInsertRowid } = db.query(
    "INSERT INTO playlists(name,is_manual,sort) VALUES(?,0,?)").run(name, sort + 1);
  const id = Number(lastInsertRowid);
  link(id, ytmId);
  log("playlist_create", { name, from: ytmId }, `adopted upstream “${name}”`);
  return { playlistId: id, name };
}

export function link(localPlaylistId: number, ytmId: string) {
  db.query(
    `INSERT INTO ytm_playlists(ytm_id, local_playlist_id) VALUES(?,?)
     ON CONFLICT(ytm_id) DO UPDATE SET local_playlist_id = excluded.local_playlist_id`,
  ).run(ytmId, localPlaylistId);
}

/**
 * Fetch linked playlists by default. An explicit id list is never filtered by
 * link state; includeUnlinked is opt-in because public playlists can be huge.
 *
 * Keyed by upstream id, never by local name: several upstream playlists may
 * feed one local playlist (two “Haussss”, “techno” and “Techno”), and a
 * name-keyed map would silently drop all but one of them.
 */
export async function refresh(
  ytmIds?: string[], opts: { includeUnlinked?: boolean } = {},
) {
  const wanted = ytmIds === undefined
    ? db.query<{ ytm_id: string }, []>(
        `SELECT ytm_id FROM ytm_playlists
         ${opts.includeUnlinked ? "" : "WHERE local_playlist_id IS NOT NULL"}`,
      ).all().map((r) => r.ytm_id)
    : [...new Set(ytmIds)];
  const res: BridgeFetch = { playlists: [], errors: [] };
  const results: PromiseSettledResult<Awaited<ReturnType<typeof fetchPlaylist>>>[] = [];
  for (let i = 0; i < wanted.length; i += 6) {   // a few at a time, like the old bridge
    results.push(...await Promise.allSettled(wanted.slice(i, i + 6).map((id) => fetchPlaylist(id))));
  }
  results.forEach((r, i) => {
    if (r.status === "fulfilled") res.playlists.push({ name: wanted[i]!, ...r.value });
    else res.errors.push({ playlist: wanted[i]!, error: String(r.reason).slice(0, 200) });
  });
  return ingest(res);
}

/**
 * Ingest the dj-sync Worker's snapshot of the linked playlists (DJ_SYNC_URL,
 * DJ_SYNC_TOKEN from data/sync.env). The daemon calls this instead of reading
 * YouTube from the PC.
 */
export async function pull() {
  const url = process.env.DJ_SYNC_URL, token = process.env.DJ_SYNC_TOKEN;
  if (!url || !token) throw new Error("DJ_SYNC_URL / DJ_SYNC_TOKEN not set (data/sync.env)");
  const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  // Keep the Worker's list equal to what is linked here; a newly linked
  // playlist shows up as `pending` until the Worker's next cron run.
  const ids = db.query<{ ytm_id: string }, []>(
    `SELECT y.ytm_id FROM ytm_playlists y JOIN playlists p ON p.id=y.local_playlist_id
     WHERE p.name NOT IN (${syncExcludedSql})`).all().map((r) => r.ytm_id);
  const put = await fetch(`${url}/playlists`, { method: "PUT", headers: auth, body: JSON.stringify({ ids }) });
  if (!put.ok) throw new Error(`dj-sync playlists: HTTP ${put.status}`);
  const res = await fetch(`${url}/snapshot`, { headers: auth });
  if (!res.ok) throw new Error(`dj-sync snapshot: HTTP ${res.status}`);
  const snap = await res.json() as BridgeFetch & { pending: string[] };
  const known = new Set(db.query<{ ytm_id: string }, []>("SELECT ytm_id FROM ytm_playlists").all()
    .map((r) => r.ytm_id));
  // YouTube intermittently answers the Worker with 403 (it blocks Cloudflare's
  // egress addresses), and the snapshot then carries only stale playlists. The
  // same read works from this machine, so re-read every playlist the Worker
  // failed on locally and report an error only if that fails too.
  const failed = snap.errors.map((e) => e.playlist).filter((id) => known.has(id));
  const fromWorker = ingest({
    playlists: snap.playlists.filter((p) => known.has(p.ytmId) && !failed.includes(p.ytmId)),
    errors: [],
  });
  if (failed.length === 0) return { ...fromWorker, pending: snap.pending };
  log(`dj-sync Worker failed on ${failed.length} playlists (${snap.errors[0]!.error}); reading them locally`);
  const local = await refresh(failed);
  return {
    refreshed: [...fromWorker.refreshed, ...local.refreshed],
    errors: local.errors,
    pending: snap.pending,
  };
}

function ingest(res: BridgeFetch) {
  const upsertPl = db.query(
    `UPDATE ytm_playlists SET title=?, count=?, track_count=?, fetched_at=? WHERE ytm_id=?`);
  const clearTracks = db.query("DELETE FROM ytm_tracks WHERE ytm_id=?");
  const addTrack = db.query(
    "INSERT OR REPLACE INTO ytm_tracks(ytm_id,video_id,title,artist,sort,unavailable) VALUES(?,?,?,?,?,?)");

  const ts = now();
  db.transaction(() => {
    for (const p of res.playlists) {
      upsertPl.run(p.title, p.tracks.length, p.trackCount ?? null, ts, p.ytmId);
      clearTracks.run(p.ytmId);
      for (const t of p.tracks) {
        addTrack.run(p.ytmId, t.videoId, t.title, t.artist, t.sort, t.unavailable ? 1 : 0);
      }
    }
  })();

  setMeta("last_ytm_sync", ts);
  log("ytm_refresh", { n: res.playlists.length }, `${res.errors.length} errors`);
  return {
    refreshed: res.playlists.map((p) => ({
      playlist: p.title,
      count: p.tracks.length,
    })),
    errors: res.errors,
  };
}

/** Classify every local playlist and every discovered upstream source. */
export function classify() {
  const locals = db.query<
    { localPlaylistId: number; name: string; localCount: number }, []
  >(`SELECT p.id AS localPlaylistId,p.name,
       (SELECT COUNT(*) FROM memberships m JOIN tracks t ON t.id=m.track_id
        WHERE m.playlist_id=p.id AND t.missing=0) AS localCount
     FROM playlists p ORDER BY p.name`).all();
  const sources = db.query<
    { ytmId: string; title: string; localPlaylistId: number | null;
      count: number; fetchedAt: number }, []
  >(`SELECT ytm_id AS ytmId,title,local_playlist_id AS localPlaylistId,
            count,fetched_at AS fetchedAt
     FROM ytm_playlists ORDER BY title,ytm_id`).all();

  const byLocal = new Map<number, typeof sources>();
  for (const source of sources) {
    if (source.localPlaylistId == null) continue;
    const list = byLocal.get(source.localPlaylistId);
    if (list) list.push(source); else byLocal.set(source.localPlaylistId, [source]);
  }
  const view = (source: typeof sources[number]) => ({
    ytmId: source.ytmId,
    title: source.title,
    // A never-fetched playlist is unknown, not an empty playlist.
    count: source.fetchedAt ? source.count : null,
    fetchedAt: source.fetchedAt,
  });

  return {
    linked: locals.filter((local) => byLocal.has(local.localPlaylistId)).map((local) => ({
      localPlaylistId: local.localPlaylistId,
      localName: local.name,
      sources: byLocal.get(local.localPlaylistId)!.map(view),
      localCount: local.localCount,
    })),
    upstreamOnly: sources
      .filter((source) => source.localPlaylistId == null)
      .map(view),
    localOnly: locals.filter((local) => !byLocal.has(local.localPlaylistId)),
  };
}

/**
 * One entry per LOCAL playlist, unioning every upstream playlist linked to it.
 *
 * Grouping this way is what makes several upstream sources per local playlist
 * meaningful: “techno” and “Techno” together are the intended set, so a track
 * in either one counts as present upstream rather than as a conflict.
 */
export function diff() {
  const sources = db.query<
    { ytm_id: string; title: string; local_playlist_id: number; fetched_at: number;
      local_name: string }, []
  >(`SELECT y.ytm_id, y.title, y.local_playlist_id, y.fetched_at, p.name AS local_name
     FROM ytm_playlists y JOIN playlists p ON p.id = y.local_playlist_id
     WHERE y.fetched_at > 0 ORDER BY p.name, y.title`).all();

  const byLocal = new Map<number, typeof sources>();
  for (const s of sources) {
    const list = byLocal.get(s.local_playlist_id);
    if (list) list.push(s); else byLocal.set(s.local_playlist_id, [s]);
  }

  const upQuery = db.query<
    { video_id: string; title: string | null; artist: string | null }, [string]
  >("SELECT video_id,title,artist FROM ytm_tracks WHERE ytm_id=? ORDER BY sort");
  const localQuery = db.query<
    { id: number; title: string | null; artist: string | null;
      video_id: string | null; filename: string }, [number]
  >(`SELECT t.id,t.title,t.artist,t.video_id,t.filename FROM memberships m
     JOIN tracks t ON t.id=m.track_id
     WHERE m.playlist_id=? AND t.missing=0`);

  const out = [];
  for (const [localId, srcs] of byLocal) {
    // Union upstream, deduped by video id — overlapping sources are common.
    const up = new Map<string, { video_id: string; title: string | null; artist: string | null }>();
    for (const s of srcs) for (const r of upQuery.all(s.ytm_id)) up.set(r.video_id, r);
    const upList = [...up.values()];

    const localTracks = localQuery.all(localId);

    const upVids = new Set(upList.map((r) => r.video_id));
    const upKeys = new Set(upList.map((r) => norm(`${r.artist} ${r.title}`)));
    const locVids = new Set(localTracks.map((r) => r.video_id).filter(Boolean) as string[]);
    const locKeys = new Set(localTracks.map((r) => norm(`${r.artist} ${r.title}`)));

    const missingLocally = upList
      .filter((r) => !locVids.has(r.video_id) && !locKeys.has(norm(`${r.artist} ${r.title}`)))
      .map((r) => ({
        videoId: r.video_id, title: r.title, artist: r.artist,
        url: `https://music.youtube.com/watch?v=${r.video_id}`,
      }));

    const extraLocally = localTracks
      .filter((r) => !(r.video_id && upVids.has(r.video_id))
        && !upKeys.has(norm(`${r.artist} ${r.title}`)))
      .map((r) => ({ trackId: r.id, title: r.title, artist: r.artist, filename: r.filename }));

    out.push({
      playlist: srcs[0]!.local_name,
      localPlaylistId: localId,
      sources: srcs.map((s) => ({ ytmId: s.ytm_id, title: s.title })),
      ytmCount: upList.length,
      localCount: localTracks.length,
      matched: localTracks.length - extraLocally.length,
      missingLocally,
      extraLocally,
      fetchedAt: Math.max(...srcs.map((s) => s.fetched_at)),
    });
  }
  return out.sort((a, b) => a.playlist.localeCompare(b.playlist));
}
