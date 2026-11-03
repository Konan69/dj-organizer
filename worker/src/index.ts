/**
 * dj-sync: keeps a fresh snapshot of the linked YouTube Music playlists in D1,
 * so the app (POST /api/ytm/pull) reads one cheap endpoint instead of
 * scraping YouTube itself.
 *
 *   PUT /playlists {ids}  the app declares which playlists are linked
 *   GET /snapshot         every tracked playlist, in the ytm_bridge fetch shape
 *
 * Cron refreshes the stalest playlists first within a subrequest budget, so a
 * large library rotates through a few runs instead of blowing one run's limit.
 */
import { fetchPlaylist } from "./ytm";

type Env = { DB: D1Database; SYNC_TOKEN: string };
const BUDGET = 40;          // subrequests per cron run (free plan allows 50)
const PAGE = 100;           // tracks per innertube page, for budgeting

async function refresh(env: Env) {
  const rows = await env.DB.prepare(
    "SELECT ytm_id, track_count FROM playlists ORDER BY COALESCE(fetched_at,0) ASC",
  ).all<{ ytm_id: string; track_count: number | null }>();
  let spent = 0;
  for (const row of rows.results) {
    const cost = Math.max(1, Math.ceil((row.track_count ?? PAGE) / PAGE));
    if (spent > 0 && spent + cost > BUDGET) break;
    spent += cost;
    try {
      const p = await fetchPlaylist(row.ytm_id);
      await env.DB.prepare(
        "UPDATE playlists SET title=?, track_count=?, tracks=?, fetched_at=?, error=NULL WHERE ytm_id=?",
      ).bind(p.title, p.trackCount, JSON.stringify(p.tracks), Date.now(), row.ytm_id).run();
    } catch (e) {
      await env.DB.prepare("UPDATE playlists SET error=?, fetched_at=? WHERE ytm_id=?")
        .bind(String(e).slice(0, 300), Date.now(), row.ytm_id).run();
    }
  }
}

export default {
  async scheduled(_: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(refresh(env));
  },

  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.headers.get("authorization") !== `Bearer ${env.SYNC_TOKEN}`) {
      return new Response("unauthorized", { status: 401 });
    }
    const url = new URL(req.url);

    if (req.method === "PUT" && url.pathname === "/playlists") {
      const { ids } = await req.json<{ ids: string[] }>();
      const stmts = [
        env.DB.prepare(`DELETE FROM playlists WHERE ytm_id NOT IN (SELECT value FROM json_each(?))`)
          .bind(JSON.stringify(ids)),
        ...ids.map((id) => env.DB.prepare("INSERT OR IGNORE INTO playlists(ytm_id) VALUES(?)").bind(id)),
      ];
      await env.DB.batch(stmts);
      return Response.json({ tracked: ids.length });
    }

    if (req.method === "GET" && url.pathname === "/snapshot") {
      const rows = await env.DB.prepare(
        "SELECT ytm_id, title, track_count, tracks, fetched_at, error FROM playlists",
      ).all<{ ytm_id: string; title: string | null; track_count: number | null;
        tracks: string | null; fetched_at: number | null; error: string | null }>();
      const fetched = rows.results.filter((r) => r.tracks);
      return Response.json({
        playlists: fetched.map((r) => ({
          name: r.ytm_id, ytmId: r.ytm_id, title: r.title ?? r.ytm_id,
          trackCount: r.track_count, tracks: JSON.parse(r.tracks!), fetchedAt: r.fetched_at,
        })),
        errors: rows.results.filter((r) => r.error).map((r) => ({ playlist: r.ytm_id, error: r.error })),
        pending: rows.results.filter((r) => !r.tracks).map((r) => r.ytm_id),
      });
    }

    if (req.method === "POST" && url.pathname === "/refresh") {
      await refresh(env);
      return Response.json({ ok: true });
    }
    return new Response("not found", { status: 404 });
  },
};
