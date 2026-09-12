import { cors } from "@elysiajs/cors";
import { Elysia, t } from "elysia";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import * as art from "./art";
import * as changes from "./changes";
import { db, getMeta, log, markDirty, now } from "./db";
import * as dupes from "./dupes";
import { bootstrap, scan } from "./library";
import * as ops from "./ops";
import { LIB, WEB_DIST } from "./paths";
import * as rbxml from "./rbxml";
import * as serato from "./serato";
import * as snapshots from "./snapshots";
import * as stores from "./stores";
import * as ytm from "./ytm";

const CT: Record<string, string> = {
  m4a: "audio/mp4", webm: "audio/webm", mp3: "audio/mpeg",
  wav: "audio/wav", flac: "audio/flac", aiff: "audio/aiff",
};

function state() {
  const playlists = db.query<
    { id: number; name: string; is_manual: number; sort: number; count: number }, []
  >(`SELECT p.id, p.name, p.is_manual, p.sort,
       (SELECT COUNT(*) FROM memberships m JOIN tracks t ON t.id = m.track_id
        WHERE m.playlist_id = p.id AND t.missing = 0) AS count
     FROM playlists p ORDER BY p.sort, p.name`).all();

  const mem = new Map<number, number[]>();
  for (const r of db.query<{ playlist_id: number; track_id: number }, []>(
    "SELECT playlist_id, track_id FROM memberships").all()) {
    const list = mem.get(r.track_id);
    if (list) list.push(r.playlist_id); else mem.set(r.track_id, [r.playlist_id]);
  }

  const pending = new Set(
    db.query<{ track_id: number }, []>("SELECT track_id FROM pending_deletes")
      .all().map((r) => r.track_id));

  const tracks = db.query<
    { id: number; path: string; filename: string; folder: string; ext: string;
      title: string | null; artist: string | null; duration: number | null;
      bitrate: number | null; size: number | null; video_id: string | null;
      added_at: number | null }, []
  >(`SELECT id, path, filename, folder, ext, title, artist, duration, bitrate, size,
            video_id, added_at
     FROM tracks WHERE missing = 0 ORDER BY artist, title`).all()
    .map((r) => ({
      ...r,
      playlists: mem.get(r.id) ?? [],
      pendingDelete: pending.has(r.id),
    }));

  const dup = dupes.find();
  const chg = changes.compute().summary;
  const opStats = ops.stats();
  const hashed = db.query<{ n: number; h: number }, []>(
    "SELECT COUNT(*) n, COUNT(content_hash) h FROM tracks WHERE missing=0").get()!;

  return {
    playlists,
    tracks,
    counts: {
      tracks: tracks.length,
      unfiled: tracks.filter((t) => t.playlists.length === 0).length,
      pendingDeletes: pending.size,
      duplicates: dup.count,
    },
    duplicateIds: dup.redundantIds,
    reclaim: dup.reclaim,
    changes: chg,
    ops: opStats,
    hashing: { total: hashed.n, hashed: hashed.h },
    synced: {
      scan: getMeta("last_scan"),
      ytm: getMeta("last_ytm_sync"),
    },
    lib: LIB,
  };
}

const ids = t.Object({ trackIds: t.Array(t.Number()) });

export const app = new Elysia({ prefix: "" })
  .use(cors())
  .onError(({ error, code, path, set }) => {
    // Unknown non-/api paths are client routes: hand back the SPA shell.
    const index = join(WEB_DIST, "index.html");
    if (code === "NOT_FOUND" && !path.startsWith("/api") && existsSync(index)) {
      set.status = 200;
      return new Response(Bun.file(index), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    const message = error instanceof Error ? error.message : String(error);
    set.status = code === "NOT_FOUND" ? 404 : 500;
    console.error(`[api] ${code}: ${message}`);
    return { error: message };
  })

  .group("/api", (api) =>
    api
      .get("/state", () => state())

      .post("/rescan", ({ body }) => scan(body?.full ?? false), {
        body: t.Optional(t.Object({ full: t.Optional(t.Boolean()) })),
      })

      // ---- playlists ----
      .post("/playlist", ({ body, set }) => {
        const name = body.name.trim();
        if (!name) { set.status = 400; return { error: "name required" }; }
        const clash = db.query("SELECT 1 FROM playlists WHERE name=?").get(name);
        if (clash) { set.status = 409; return { error: "playlist exists" }; }
        const max = db.query<{ s: number }, []>(
          "SELECT COALESCE(MAX(sort),0) s FROM playlists").get()!.s;
        const row = db.query<{ id: number }, [string, number, number]>(
          "INSERT INTO playlists(name,sort,is_manual,created_at) VALUES(?,?,0,?) RETURNING id",
        ).get(name, max + 1, now())!;
        ops.record("create_playlist", { playlist: name });
        markDirty("changes");
        return { id: row.id, name };
      }, { body: t.Object({ name: t.String() }) })

      .patch("/playlist/:id", ({ params, body }) => {
        const row = db.query<{ name: string }, [number]>(
          "SELECT name FROM playlists WHERE id=?").get(params.id);
        db.query("UPDATE playlists SET name=? WHERE id=?").run(body.name, params.id);
        ops.record("rename_playlist", { playlist: row?.name ?? null, toPlaylist: body.name });
        markDirty("changes");
        return { ok: true };
      }, { params: t.Object({ id: t.Number() }), body: t.Object({ name: t.String() }) })

      .delete("/playlist/:id", ({ params }) => {
        const row = db.query<{ name: string }, [number]>(
          "SELECT name FROM playlists WHERE id=?").get(params.id);
        db.query("DELETE FROM playlists WHERE id=?").run(params.id);
        if (row) ops.record("delete_playlist", { playlist: row.name });
        markDirty("changes");
        return { ok: true };
      }, { params: t.Object({ id: t.Number() }) })

      // ---- membership ----
      .post("/membership", ({ body }) => {
        let changed = 0;
        if (body.op === "add") {
          const max = db.query<{ s: number }, [number]>(
            "SELECT COALESCE(MAX(sort),0) s FROM memberships WHERE playlist_id=?",
          ).get(body.playlistId)!.s;
          const q = db.query(
            "INSERT OR IGNORE INTO memberships(playlist_id,track_id,sort) VALUES(?,?,?)");
          db.transaction(() => {
            body.trackIds.forEach((tid, i) => {
              changed += q.run(body.playlistId, tid, max + i + 1).changes;
            });
          })();
        } else {
          const q = db.query("DELETE FROM memberships WHERE playlist_id=? AND track_id=?");
          db.transaction(() => {
            for (const tid of body.trackIds) changed += q.run(body.playlistId, tid).changes;
          })();
        }
        if (changed) {
          const pl = db.query<{ name: string }, [number]>(
            "SELECT name FROM playlists WHERE id=?").get(body.playlistId);
          if (pl) {
            ops.recordMembership(body.op === "add" ? "add_to" : "remove_from",
              pl.name, body.trackIds);
          }
          markDirty("changes");
        }
        return { changed };
      }, {
        body: t.Object({
          trackIds: t.Array(t.Number()),
          playlistId: t.Number(),
          op: t.Union([t.Literal("add"), t.Literal("remove")]),
        }),
      })

      .post("/move", ({ body }) => {
        let added = 0, removed = 0;
        db.transaction(() => {
          const max = db.query<{ s: number }, [number]>(
            "SELECT COALESCE(MAX(sort),0) s FROM memberships WHERE playlist_id=?",
          ).get(body.toPlaylistId)!.s;
          const add = db.query(
            "INSERT OR IGNORE INTO memberships(playlist_id,track_id,sort) VALUES(?,?,?)");
          body.trackIds.forEach((tid, i) => {
            added += add.run(body.toPlaylistId, tid, max + i + 1).changes;
          });
          if (body.fromPlaylistId != null && body.fromPlaylistId !== body.toPlaylistId) {
            const rm = db.query("DELETE FROM memberships WHERE playlist_id=? AND track_id=?");
            for (const tid of body.trackIds) removed += rm.run(body.fromPlaylistId, tid).changes;
          }
        })();
        if (added || removed) {
          const name = (id: number) => db.query<{ name: string }, [number]>(
            "SELECT name FROM playlists WHERE id=?").get(id)?.name;
          const to = name(body.toPlaylistId);
          if (to) ops.recordMembership("add_to", to, body.trackIds);
          if (removed && body.fromPlaylistId != null) {
            const from = name(body.fromPlaylistId);
            if (from) ops.recordMembership("remove_from", from, body.trackIds);
          }
          markDirty("changes");
        }
        return { added, removed };
      }, {
        body: t.Object({
          trackIds: t.Array(t.Number()),
          fromPlaylistId: t.Optional(t.Nullable(t.Number())),
          toPlaylistId: t.Number(),
        }),
      })

      // ---- staged deletes ----
      .get("/delete/pending", () =>
        db.query<
          { id: number; title: string | null; artist: string | null;
            filename: string; folder: string; reason: string }, []
        >(`SELECT t.id,t.title,t.artist,t.filename,t.folder,p.reason
           FROM pending_deletes p JOIN tracks t ON t.id = p.track_id`).all())

      .post("/delete", ({ body }) => {
        const q = db.query(
          "INSERT OR IGNORE INTO pending_deletes(track_id,queued_at,reason) VALUES(?,?,?)");
        const ts = now();
        db.transaction(() => {
          for (const tid of body.trackIds) q.run(tid, ts, body.reason ?? "");
        })();
        return { queued: body.trackIds.length };
      }, { body: t.Object({ trackIds: t.Array(t.Number()), reason: t.Optional(t.String()) }) })

      .post("/delete/undo", ({ body }) => {
        const q = db.query("DELETE FROM pending_deletes WHERE track_id=?");
        db.transaction(() => { for (const tid of body.trackIds) q.run(tid); })();
        return { ok: true };
      }, { body: ids })

      // Staged deletes become ops on the fs plan and nothing else. There is no
      // route that moves a file: the app is read-only against the real library.
      .post("/delete/stage", () => {
        const rows = db.query<
          { content_hash: string | null; path: string; title: string | null; artist: string | null },
          []
        >(`SELECT t.content_hash,t.path,t.title,t.artist
           FROM pending_deletes p JOIN tracks t ON t.id=p.track_id`).all();
        for (const r of rows) {
          ops.record("delete_track", {
            trackHash: r.content_hash, trackPath: r.path,
            trackLabel: [r.artist, r.title].filter(Boolean).join(" - "),
          });
        }
        return { staged: rows.length, plan: "/api/plan/fs/text" };
      })

      // ---- stores: observe, compare, and replay plans ----
      .get("/stores", async () => {
        const obs = await stores.observeAll();
        return { comparison: stores.compare(obs), observations: obs };
      })
      .get("/stores/history", () => stores.history())
      .get("/ops", ({ query }) => ops.list(Number(query.limit ?? 500), query.all === "1"))
      .get("/ops/stats", () => ops.stats())
      .post("/ops/undo", ({ body }) => ops.undo(body.ids), {
        body: t.Object({ ids: t.Array(t.Number()) }),
      })
      .post("/ops/applied", ({ body }) => ops.markApplied(body.store, body.ids), {
        body: t.Object({
          store: t.Union([t.Literal("serato"), t.Literal("rekordbox"), t.Literal("fs")]),
          ids: t.Array(t.Number()),
        }),
      })
      .get("/plan/:store", ({ params }) => ops.plan(params.store), {
        params: t.Object({
          store: t.Union([t.Literal("serato"), t.Literal("rekordbox"), t.Literal("fs")]),
        }),
      })
      .get("/plan/:store/text", ({ params }) => new Response(ops.planText(params.store), {
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "content-disposition": `attachment; filename="plan-${params.store}.txt"`,
        },
      }), {
        params: t.Object({
          store: t.Union([t.Literal("serato"), t.Literal("rekordbox"), t.Literal("fs")]),
        }),
      })

      // ---- duplicates ----
      .get("/duplicates", () => dupes.find())
      .post("/duplicates/resolve", () => {
        snapshots.snapshot("before-dedupe");
        return dupes.resolveAll();
      })

      // ---- staging snapshots ----
      .get("/snapshots", () => snapshots.list())
      .post("/snapshots", ({ body }) => snapshots.snapshot(body?.reason ?? "manual"), {
        body: t.Optional(t.Object({ reason: t.Optional(t.String()) })),
      })

      // ---- rekordbox XML: the officially documented, non-destructive path ----
      .get("/export/rekordbox.xml", ({ query }) => {
        const { xml } = rbxml.build({
          playlists: query.playlists ? String(query.playlists).split(",") : undefined,
          includeUnfiled: query.unfiled === "1",
        });
        return new Response(xml, {
          headers: {
            "content-type": "application/xml; charset=utf-8",
            "content-disposition": 'attachment; filename="dj-organizer.xml"',
          },
        });
      })
      .get("/export/rekordbox/info", () => ({
        ...rbxml.build().stats,
        steps: rbxml.IMPORT_STEPS,
        sample: rbxml.build().xml.split("\n").slice(0, 8).join("\n"),
      }))

      // ---- what a crate rewrite would preserve vs. drop ----
      .get("/serato/inspect", () => {
        const names = db.query<{ name: string }, []>(
          "SELECT name FROM playlists ORDER BY sort,name").all().map((r) => r.name);
        return names.map((n) => serato.describe(n)).filter(Boolean);
      })

      // ---- changeset (read-only; applied by hand) ----
      .get("/changes", () => changes.compute())
      .get("/changes.txt", () => new Response(changes.asText(), {
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "content-disposition": 'attachment; filename="changeset.txt"',
        },
      }))

      // ---- upstream ----
      .get("/ytm/status", () => ytm.status())
      .get("/ytm/diff", () => ytm.diff())
      .get("/ytm/candidates", () => ytm.candidates())
      .post("/ytm/discover", () => ytm.discover())
      .post("/ytm/unlink", ({ body }) => {
        ytm.unlink(body.ytmId);
        return { ok: true };
      }, { body: t.Object({ ytmId: t.String() }) })
      .post("/ytm/refresh", ({ body }) => ytm.refresh(body?.ytmIds), {
        body: t.Optional(t.Object({ ytmIds: t.Optional(t.Array(t.String())) })),
      })
      .post("/ytm/adopt", ({ body }) => ytm.adopt(body.ytmId), {
        body: t.Object({ ytmId: t.String() }),
      })
      .post("/ytm/link", ({ body }) => {
        ytm.link(body.localPlaylistId, body.ytmId);
        return { ok: true };
      }, { body: t.Object({ localPlaylistId: t.Number(), ytmId: t.String() }) })

      // ---- audio streaming with Range ----
      // ---- cover art ----
      .get("/art/:id", async ({ params, set }) => {
        const row = db.query<{ video_id: string | null }, [number]>(
          "SELECT video_id FROM tracks WHERE id=?").get(Number(params.id));
        const path = row?.video_id ? await art.get(row.video_id) : null;
        if (!path) { set.status = 404; return { error: "no art" }; }
        set.headers["content-type"] = "image/jpeg";
        set.headers["cache-control"] = "public, max-age=31536000, immutable";
        return new Response(Bun.file(path));
      })
      .get("/art", () => art.stats())
      .post("/art/warm", async () => {
        const ids = db.query<{ video_id: string }, []>(
          "SELECT DISTINCT video_id FROM tracks WHERE video_id IS NOT NULL").all()
          .map((r) => r.video_id);
        return art.warm(ids);
      })

      .get("/audio/:id", ({ params, headers, set }) => {
        const row = db.query<{ path: string; ext: string }, [number]>(
          "SELECT path,ext FROM tracks WHERE id=?").get(params.id);
        if (!row || !existsSync(row.path)) { set.status = 404; return { error: "gone" }; }

        const size = statSync(row.path).size;
        const type = CT[row.ext] ?? "application/octet-stream";
        const file = Bun.file(row.path);
        const range = headers.range;

        if (!range) {
          set.headers["content-type"] = type;
          set.headers["accept-ranges"] = "bytes";
          set.headers["content-length"] = String(size);
          return new Response(file);
        }
        const m = /bytes=(\d*)-(\d*)/.exec(range);
        let start = 0, end = size - 1;
        if (m) {
          if (m[1]) { start = Number(m[1]); if (m[2]) end = Number(m[2]); }
          else if (m[2]) start = Math.max(0, size - Number(m[2]));
        }
        start = Math.min(start, size - 1);
        end = Math.min(end, size - 1);
        return new Response(file.slice(start, end + 1), {
          status: 206,
          headers: {
            "content-type": type,
            "accept-ranges": "bytes",
            "content-range": `bytes ${start}-${end}/${size}`,
            "content-length": String(end - start + 1),
            "cache-control": "no-store",
          },
        });
      }, { params: t.Object({ id: t.Number() }) }),
  );

export type App = typeof app;

if (import.meta.main) {
  const port = Number(process.argv[2] ?? process.env.PORT ?? 8765);

  // In production serve the built SPA; in dev Vite owns the frontend.
  if (existsSync(WEB_DIST)) {
    const { staticPlugin } = await import("@elysiajs/static");
    const index = join(WEB_DIST, "index.html");
    app
      .use(staticPlugin({ assets: WEB_DIST, prefix: "/" }))
      // staticPlugin doesn't map bare "/"; deeper client routes fall through
      // to the SPA shell via the NOT_FOUND branch in onError above.
      .get("/", () => new Response(Bun.file(index), {
        headers: { "content-type": "text/html; charset=utf-8" },
      }));
  }

  const boot = await bootstrap();
  snapshots.snapshot("startup");
  app.listen(port);
  const s = state();
  console.log(`  dj-organizer  http://localhost:${port}`);
  console.log(
    `  ${s.counts.tracks} tracks · ${s.playlists.length} playlists · ` +
    `${s.counts.unfiled} unfiled · ${s.counts.duplicates} duplicates`,
  );
  if (boot.seed.seeded) console.log(`  seeded from crates: ${JSON.stringify(boot.seed)}`);
}
