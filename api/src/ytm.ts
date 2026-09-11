/**
 * Upstream diff against YouTube Music.
 *
 * ytmusicapi's library/liked endpoints are broken server-side, so the Python
 * bridge only ever calls get_playlist(id). Fetching lives in Python; caching,
 * matching and diffing live here.
 */
import { db, log, now, setMeta } from "./db";
import { py } from "./py";
import { norm } from "./tags";

type BridgeStatus = { authed: boolean; error: string | null; known: Record<string, string> };
type BridgeFetch = {
  playlists: {
    name: string; ytmId: string; title: string;
    tracks: { videoId: string; title: string | null; artist: string; sort: number }[];
  }[];
  errors: { playlist: string; error: string }[];
};

export async function status() {
  const s = await py<BridgeStatus>("ytm_bridge.py", "status", {}, 90_000);
  const known = db.query<{ n: number }, []>(
    "SELECT COUNT(*) n FROM ytm_playlists").get()!.n;
  return {
    authed: s.authed,
    error: s.error,
    lastSync: getNum("last_ytm_sync"),
    playlistsKnown: known,
    mapped: Object.keys(mapping(s.known)).length,
  };
}

function getNum(key: string) {
  const r = db.query<{ value: string }, [string]>(
    "SELECT value FROM meta WHERE key=?").get(key);
  return r ? Number(r.value) : null;
}

/** Known ids from the bridge, plus anything the user has linked by hand. */
function mapping(known: Record<string, string> = {}) {
  const m: Record<string, string> = { ...known };
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
  const s = await py<BridgeStatus>("ytm_bridge.py", "status", {}, 90_000);
  let targets = mapping(s.known);
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
  >("SELECT ytm_id,title,local_playlist_id,fetched_at FROM ytm_playlists ORDER BY title").all()) {
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
