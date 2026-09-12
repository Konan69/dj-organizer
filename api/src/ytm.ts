/**
 * Upstream diff against YouTube Music.
 *
 * Unauthenticated by design — see api/py/ytm_bridge.py for why the signed-in
 * path is unavailable and why it does not matter. Fetching lives in Python;
 * discovery, name matching, caching and diffing live here.
 */
import { db, log, now, setMeta } from "./db";
import { py } from "./py";
import { norm } from "./tags";

type BridgeStatus = { reachable: boolean; reason: string | null; owner: string | null };
type BridgeDiscover = {
  channel: string; owner: string | null;
  playlists: { ytmId: string; title: string }[];
};
type BridgeFetch = {
  playlists: {
    name: string; ytmId: string; title: string;
    tracks: { videoId: string; title: string | null; artist: string; sort: number }[];
  }[];
  errors: { playlist: string; error: string }[];
};

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
 * Fetch every linked upstream playlist.
 *
 * Keyed by upstream id, never by local name: several upstream playlists may
 * feed one local playlist (two “Haussss”, “techno” and “Techno”), and a
 * name-keyed map would silently drop all but one of them.
 */
export async function refresh(ytmIds?: string[]) {
  const rows = db.query<{ ytm_id: string }, []>(
    "SELECT ytm_id FROM ytm_playlists WHERE local_playlist_id IS NOT NULL").all();
  const wanted = rows
    .map((r) => r.ytm_id)
    .filter((id) => !ytmIds?.length || ytmIds.includes(id));
  const targets = Object.fromEntries(wanted.map((id) => [id, id]));

  const res = await py<BridgeFetch>("ytm_bridge.py", "fetch", { playlists: targets }, 600_000);

  const upsertPl = db.query(
    `UPDATE ytm_playlists SET title=?, count=?, fetched_at=? WHERE ytm_id=?`);
  const clearTracks = db.query("DELETE FROM ytm_tracks WHERE ytm_id=?");
  const addTrack = db.query(
    "INSERT OR REPLACE INTO ytm_tracks(ytm_id,video_id,title,artist,sort) VALUES(?,?,?,?,?)");

  const ts = now();
  db.transaction(() => {
    for (const p of res.playlists) {
      upsertPl.run(p.title, p.tracks.length, ts, p.ytmId);
      clearTracks.run(p.ytmId);
      for (const t of p.tracks) addTrack.run(p.ytmId, t.videoId, t.title, t.artist, t.sort);
    }
  })();

  setMeta("last_ytm_sync", ts);
  log("ytm_refresh", { n: res.playlists.length }, `${res.errors.length} errors`);
  return {
    refreshed: res.playlists.map((p) => ({ playlist: p.title, count: p.tracks.length })),
    errors: res.errors,
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
