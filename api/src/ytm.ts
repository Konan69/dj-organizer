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
  // localId -> the upstream id already holding it, so re-running discovery
  // does not report an existing link as a conflict with itself.
  const heldBy = new Map<number, string>(
    db.query<{ ytm_id: string; local_playlist_id: number }, []>(
      "SELECT ytm_id, local_playlist_id FROM ytm_playlists WHERE local_playlist_id IS NOT NULL")
      .all().map((r) => [r.local_playlist_id, r.ytm_id]));

  const claims = new Map<number, string[]>();   // localId -> ytmIds wanting it
  const wants = new Map<string, number>();      // ytmId  -> localId

  for (const p of d.playlists) {
    const k = key(p.title);
    const exact = locals.filter((l) => key(l.name) === k);
    const loose = exact.length ? exact
      : locals.filter((l) => key(l.name).includes(k) || k.includes(key(l.name)));
    if (loose.length !== 1) continue;
    const localId = loose[0]!.id;
    wants.set(p.ytmId, localId);
    claims.set(localId, [...(claims.get(localId) ?? []), p.ytmId]);
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
      const held = localId != null ? heldBy.get(localId) : undefined;
      const contested = localId != null
        && (claims.get(localId)!.length > 1 || (held != null && held !== p.ytmId));
      if (localId != null && contested) ambiguous++;
      const link = localId != null && !contested ? localId : null;
      if (link != null) linked++;
      upsert.run(p.ytmId, p.title, link);
    }
  })();

  log("ytm_discover", { channel: d.channel }, `${d.playlists.length} upstream, ${linked} linked`);
  return {
    owner: d.owner, channel: d.channel,
    found: d.playlists.length, linked, ambiguous,
    unlinkedLocal: locals
      .filter((l) => ![...wants.values()].includes(l.id) && !heldBy.has(l.id))
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

/** Local playlist name -> upstream id, for every link that exists. */
function mapping() {
  const m: Record<string, string> = {};
  for (const r of db.query<{ name: string; ytm_id: string }, []>(
    `SELECT p.name, y.ytm_id FROM ytm_playlists y
     JOIN playlists p ON p.id = y.local_playlist_id`).all()) {
    m[r.name] = r.ytm_id;
  }
  return m;
}

export function link(localPlaylistId: number, ytmId: string) {
  db.query(
    `INSERT INTO ytm_playlists(ytm_id, local_playlist_id) VALUES(?,?)
     ON CONFLICT(ytm_id) DO UPDATE SET local_playlist_id = excluded.local_playlist_id`,
  ).run(ytmId, localPlaylistId);
}

export async function refresh(names?: string[]) {
  let targets = mapping();
  if (names?.length) {
    targets = Object.fromEntries(Object.entries(targets).filter(([k]) => names.includes(k)));
  }

  const res = await py<BridgeFetch>("ytm_bridge.py", "fetch", { playlists: targets }, 600_000);

  const upsertPl = db.query(
    `INSERT INTO ytm_playlists(ytm_id,title,count,local_playlist_id,fetched_at)
     VALUES(?,?,?,?,?) ON CONFLICT(ytm_id) DO UPDATE SET
       title=excluded.title, count=excluded.count, fetched_at=excluded.fetched_at,
       local_playlist_id=COALESCE(excluded.local_playlist_id, ytm_playlists.local_playlist_id)`);
  const clearTracks = db.query("DELETE FROM ytm_tracks WHERE ytm_id=?");
  const addTrack = db.query(
    "INSERT OR REPLACE INTO ytm_tracks(ytm_id,video_id,title,artist,sort) VALUES(?,?,?,?,?)");
  const findLocal = db.query<{ id: number }, [string]>(
    "SELECT id FROM playlists WHERE name=?");

  const ts = now();
  db.transaction(() => {
    for (const p of res.playlists) {
      const local = findLocal.get(p.name);
      upsertPl.run(p.ytmId, p.title, p.tracks.length, local?.id ?? null, ts);
      clearTracks.run(p.ytmId);
      for (const t of p.tracks) addTrack.run(p.ytmId, t.videoId, t.title, t.artist, t.sort);
    }
  })();

  setMeta("last_ytm_sync", ts);
  log("ytm_refresh", { n: res.playlists.length }, `${res.errors.length} errors`);
  return {
    refreshed: res.playlists.map((p) => ({ playlist: p.name, count: p.tracks.length })),
    errors: res.errors,
  };
}

export function diff() {
  const out = [];
  for (const y of db.query<
    { ytm_id: string; title: string; local_playlist_id: number | null; fetched_at: number },
    []
  >(`SELECT ytm_id,title,local_playlist_id,fetched_at FROM ytm_playlists
     WHERE fetched_at > 0 ORDER BY title`).all()) {
    const local =
      (y.local_playlist_id
        ? db.query<{ id: number; name: string }, [number]>(
            "SELECT id,name FROM playlists WHERE id=?").get(y.local_playlist_id)
        : null) ??
      db.query<{ id: number; name: string }, [string]>(
        "SELECT id,name FROM playlists WHERE name=?").get(y.title);

    const up = db.query<
      { video_id: string; title: string | null; artist: string | null }, [string]
    >("SELECT video_id,title,artist FROM ytm_tracks WHERE ytm_id=? ORDER BY sort").all(y.ytm_id);

    const localTracks = local
      ? db.query<
          { id: number; title: string | null; artist: string | null;
            video_id: string | null; filename: string }, [number]
        >(`SELECT t.id,t.title,t.artist,t.video_id,t.filename FROM memberships m
           JOIN tracks t ON t.id=m.track_id
           WHERE m.playlist_id=? AND t.missing=0`).all(local.id)
      : [];

    const upVids = new Set(up.map((r) => r.video_id));
    const upKeys = new Set(up.map((r) => norm(`${r.artist} ${r.title}`)));
    const locVids = new Set(localTracks.map((r) => r.video_id).filter(Boolean) as string[]);
    const locKeys = new Set(localTracks.map((r) => norm(`${r.artist} ${r.title}`)));

    const missingLocally = up
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
      playlist: local?.name ?? y.title,
      ytmId: y.ytm_id,
      localPlaylistId: local?.id ?? null,
      ytmCount: up.length,
      localCount: localTracks.length,
      matched: localTracks.length - extraLocally.length,
      missingLocally,
      extraLocally,
      fetchedAt: y.fetched_at,
    });
  }
  return out;
}
