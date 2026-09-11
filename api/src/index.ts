import { cors } from "@elysiajs/cors";
import { Elysia, t } from "elysia";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import * as changes from "./changes";
import { db, getMeta, log, markDirty, now } from "./db";
import * as dupes from "./dupes";
import { applyDeletes, bootstrap, scan } from "./library";
import { LIB, TRASH, WEB_DIST } from "./paths";
import * as snapshots from "./snapshots";
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
    { id: number; filename: string; folder: string; ext: string; title: string | null;
      artist: string | null; duration: number | null; bitrate: number | null;
      size: number | null; video_id: string | null }, []
  >(`SELECT id, filename, folder, ext, title, artist, duration, bitrate, size, video_id
     FROM tracks WHERE missing = 0 ORDER BY artist, title`).all()
    .map((r) => ({
      ...r,
      playlists: mem.get(r.id) ?? [],
      pendingDelete: pending.has(r.id),
    }));

  const dup = dupes.find();
  const chg = changes.compute().summary;

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
    synced: {
      scan: getMeta("last_scan"),
      ytm: getMeta("last_ytm_sync"),
    },
    lib: LIB,
    trash: TRASH,
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
        markDirty("changes");
        log("create_playlist", { name });
        return { id: row.id, name };
      }, { body: t.Object({ name: t.String() }) })

      .patch("/playlist/:id", ({ params, body }) => {
        db.query("UPDATE playlists SET name=? WHERE id=?").run(body.name, params.id);
        markDirty("changes");
        log("rename_playlist", { id: params.id, name: body.name });
        return { ok: true };
      }, { params: t.Object({ id: t.Number() }), body: t.Object({ name: t.String() }) })

      .delete("/playlist/:id", ({ params }) => {
        const row = db.query<{ name: string }, [number]>(
          "SELECT name FROM playlists WHERE id=?").get(params.id);
        db.query("DELETE FROM playlists WHERE id=?").run(params.id);
        markDirty("changes");
        log("delete_playlist", { id: params.id, name: row?.name });
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
        if (changed) { markDirty("changes"); log("membership", { op: body.op, n: changed }); }
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
        if (added || removed) markDirty("changes");
        log("move", { n: body.trackIds.length }, `+${added} -${removed}`);
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

      .post("/delete/apply", () => {
        snapshots.snapshot("before-apply-deletes");
        return applyDeletes();
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
      .post("/ytm/refresh", ({ body }) => ytm.refresh(body?.names), {
        body: t.Optional(t.Object({ names: t.Optional(t.Array(t.String())) })),
      })
      .post("/ytm/link", ({ body }) => {
        ytm.link(body.localPlaylistId, body.ytmId);
        return { ok: true };
      }, { body: t.Object({ localPlaylistId: t.Number(), ytmId: t.String() }) })

      // ---- audio streaming with Range ----
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
