import { cors } from "@elysiajs/cors";
import { Elysia, t } from "elysia";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { applyRekordbox, RekordboxBusy } from "./apply";
import * as art from "./art";
import { getTrackAnalysis } from "./analysis";
import * as changes from "./changes";
import { db, getMeta, log, markDirty, now } from "./db";
import * as download from "./download";
import * as dupes from "./dupes";
import * as learn from "./learn";
import { bootstrap, scan } from "./library";
import * as ops from "./ops";
import * as prep from "./prep";
import * as suggestions from "./suggestions";
import { aiInsightStatus, requestAiInsights, InsightsAiError } from "./insights-ai";
import { removeSavedOpenRouterKey, saveOpenRouterKey } from "./openrouter-config";
import { LIB, WEB_DIST } from "./paths";
import * as rbxml from "./rbxml";
import * as snapshots from "./snapshots";
import * as stores from "./stores";
import * as ytm from "./ytm";

const CT: Record<string, string> = {
  m4a: "audio/mp4", webm: "audio/webm", mp3: "audio/mpeg",
  wav: "audio/wav", flac: "audio/flac", aiff: "audio/aiff",
};

const labelFor = (artist: string | null, title: string | null, filename: string) =>
  [artist, title].filter(Boolean).join(" - ") || filename;

function state() {
  const playlists = db.query<
    { id: number; name: string; is_manual: number; sort: number; count: number; last_added: number | null }, []
  >(`SELECT p.id, p.name, p.is_manual, p.sort,
       (SELECT COUNT(*) FROM memberships m JOIN tracks t ON t.id = m.track_id
        WHERE m.playlist_id = p.id AND t.missing = 0) AS count,
       (SELECT MAX(o.at) FROM ops o
        WHERE o.kind = 'add_to' AND o.playlist = p.name AND o.undone = 0) AS last_added
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
      title: string | null; artist: string | null;
      fileTitle: string | null; fileArtist: string | null; edited: number; favorite: number;
      duration: number | null; bitrate: number | null; size: number | null;
      video_id: string | null; added_at: number | null }, []
  >(`SELECT t.id, t.path, t.filename, t.folder, t.ext,
            COALESCE(o.title,t.title) AS title, COALESCE(o.artist,t.artist) AS artist,
            t.title AS fileTitle, t.artist AS fileArtist,
            (o.title IS NOT NULL OR o.artist IS NOT NULL) AS edited, t.favorite,
            t.duration, t.bitrate, t.size, t.video_id, t.added_at
     FROM tracks t LEFT JOIN track_overrides o ON o.track_hash=t.content_hash
     WHERE t.missing = 0
     ORDER BY COALESCE(o.artist,t.artist),COALESCE(o.title,t.title)`).all()
    .map((r) => ({
      ...r,
      edited: Boolean(r.edited),
      favorite: r.favorite === 1 ? 1 as const : 0 as const,
      playlists: mem.get(r.id) ?? [],
      pendingDelete: pending.has(r.id),
    }));

  const dup = dupes.find();
  const learnCounts = learn.counts();
  const chg = changes.compute().summary;
  const opStats = ops.stats();
  const rekordboxPlan = ops.plan("rekordbox");
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
      favorites: tracks.filter((t) => t.favorite === 1).length,
      learnOpen: learnCounts.open,
    },
    learn: learnCounts,
    duplicateIds: dup.redundantIds,
    reclaim: dup.reclaim,
    changes: chg,
    ops: opStats,
    plan: {
      rekordbox: {
        pending: rekordboxPlan.pending,
        satisfied: rekordboxPlan.satisfied,
        observedAt: rekordboxPlan.observedAt,
        stale: rekordboxPlan.stale,
      },
    },
    hashing: { total: hashed.n, hashed: hashed.h },
    synced: {
      scan: getMeta("last_scan"),
      ytm: getMeta("last_ytm_sync"),
    },
    lib: LIB,
  };
}

const ids = t.Object({ trackIds: t.Array(t.Number()) });
const bandAutomation = t.Object({ mode: t.Union(prep.BAND_MODES.map((mode) => t.Literal(mode))),
  at: t.Number({ minimum: 0, maximum: 1 }) });

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

      .get("/suggestions/model", ({ query }) => suggestions.getSuggestionReadModel({ refresh: query.refresh === "1", requireAnalysis: true }), {
        query: t.Object({ refresh: t.Optional(t.String()) }),
      })
      .get("/suggestions", ({ query }) => suggestions.suggestNext({ ...query, allowHalfDouble: query.allowHalfDouble === "1", excludeTrackIds: prep.getDraft(query.setId).trackIds }), {
        query: t.Object({ trackId: t.Optional(t.Numeric({ minimum: 1 })),
          localPlaylistId: t.Optional(t.Numeric({ minimum: 1 })),
          playlistId: t.Optional(t.String()), limit: t.Optional(t.Numeric({ minimum: 1, maximum: 20 })),
          priority: t.Optional(t.Union([t.Literal("balanced"), t.Literal("tempo"), t.Literal("key")])),
          setId: t.Optional(t.String()),
          allowHalfDouble: t.Optional(t.String()) }),
      })
      .get("/prep/playlist/:playlistId", ({ params, set }) => {
        const playlist = db.query<{ id: number; name: string }, [number]>("SELECT id,name FROM playlists WHERE id=?").get(params.playlistId);
        if (!playlist) { set.status = 404; return { error: "Playlist not found" }; }
        const members = db.query<{ id: number; unavailable: number }, [number]>(
          `SELECT t.id,(t.missing=1 OR EXISTS (SELECT 1 FROM pending_deletes p WHERE p.track_id=t.id)) AS unavailable
           FROM memberships m JOIN tracks t ON t.id=m.track_id WHERE m.playlist_id=? ORDER BY m.sort,t.id`,
        ).all(params.playlistId);
        return { playlist, trackIds: members.filter((row) => !row.unavailable).map((row) => row.id),
          unavailable: members.filter((row) => row.unavailable).map((row) => row.id) };
      }, { params: t.Object({ playlistId: t.Numeric({ minimum: 1 }) }) })
      .get("/prep/gaps", async ({ query }) => {
        const model = await suggestions.getSuggestionReadModel({ requireAnalysis: true });
        const draft = prep.getDraft(query.setId);
        const wanted = new Set(draft.trackIds.length ? draft.trackIds : draft.seedTrackId ? [draft.seedTrackId] : []);
        const tracks = new Map(model.tracks.map((track) => [track.trackId, track]));
        return { available: model.available, reason: model.reason, gaps: [...wanted].flatMap((trackId) => {
          const track = tracks.get(trackId);
          if (!track) return [{ id: `file-${trackId}`, kind: "file", trackId,
            label: `Track ${trackId} is unavailable`, title: `Track ${trackId}`,
            detail: "This track is missing or queued for deletion.", missing: ["available audio file"],
            action: `Restore or remove unavailable track ${trackId} before exporting` }];
          const missing = [track.bpm === null ? "BPM" : null, track.key === null ? "key" : null,
            track.analysisAvailable === false ? "saved phrase/waveform analysis" : null].filter(Boolean);
          const action = track.sourceId === null
            ? `Match ${track.title} in Rekordbox, then refresh facts`
            : `Refresh facts for ${track.title}; check ${missing.join(" and ")} in Rekordbox if still missing`;
          return missing.length ? [{ id: `analysis-${track.trackId}`, kind: "analysis", trackId: track.trackId,
            label: `Check ${missing.join(" and ")} for ${track.title}`, detail: action,
            title: track.title, missing, action }] : [];
        }) };
      }, { query: t.Object({ setId: t.Optional(t.String()), limit: t.Optional(t.Numeric()) }) })
      .get("/suggestions/ai/status", () => aiInsightStatus())
      .put("/suggestions/ai/config", ({ body, set }) => {
        try { return saveOpenRouterKey(body.apiKey); }
        catch (error) { set.status = 400; return { error: (error as Error).message }; }
      }, { body: t.Object({ apiKey: t.String({ minLength: 1, maxLength: 512 }) }) })
      .delete("/suggestions/ai/config", () => removeSavedOpenRouterKey())
      .post("/suggestions/ai", async ({ body, set }) => {
        try {
          const draft = prep.getDraft(body.setId);
          const result = await suggestions.suggestNext({ trackId: body.trackId,
            localPlaylistId: body.localPlaylistId, priority: body.priority,
            allowHalfDouble: body.allowHalfDouble, limit: 20,
            excludeTrackIds: draft.trackIds });
          return await requestAiInsights({ intent: body.intent, candidates: result.candidates
            .filter((c) => !draft.trackIds.includes(c.trackId))
            .map((c) => ({ id: String(c.trackId), title: c.title, artist: c.artist,
              evidence: c.evidence.map((e) => `${e.kind}: ${e.detail}`) })) });
        } catch (error) {
          if (!(error instanceof InsightsAiError)) throw error;
          set.status = error.code === "invalid_request" ? 400 : error.code === "not_configured" ? 503 : 502;
          return { error: error.message, code: error.code };
        }
      }, { body: t.Object({ trackId: t.Integer({ minimum: 1 }), localPlaylistId: t.Optional(t.Integer({ minimum: 1 })),
        setId: t.Optional(t.String({ minLength: 1, maxLength: 160 })),
        priority: t.Optional(t.Union([t.Literal("balanced"), t.Literal("tempo"), t.Literal("key")])),
        allowHalfDouble: t.Optional(t.Boolean()), intent: t.String({ minLength: 1, maxLength: 500 }) }) })

      .get("/prep/draft", ({ query }) => prep.getDraft(query.setId), {
        query: t.Object({ setId: t.Optional(t.String()) }),
      })
      .get("/prep/sets", () => prep.getSets())
      .post("/prep/sets", ({ body, set }) => {
        if (body.revision !== undefined && body.revision !== prep.getDraft(body.setId).revision) {
          set.status = 409;
          return { error: "This set changed in another tab. Reload before switching.", draft: prep.getDraft(body.setId) };
        }
        return prep.createSet(body.name, body.fromCurrent ?? false, body.setId);
      }, { body: t.Object({ name: t.String({ minLength: 1, maxLength: 120 }),
        fromCurrent: t.Optional(t.Boolean()), revision: t.Optional(t.Integer({ minimum: 0 })),
        setId: t.Optional(t.String()) }) })
      .post("/prep/sets/:id/open", ({ params, body, set }) => {
        if (body?.revision !== undefined && body.revision !== prep.getDraft(body.setId).revision) {
          set.status = 409;
          return { error: "This set changed in another tab. Reload before switching.", draft: prep.getDraft(body.setId) };
        }
        return prep.openSet(params.id);
      }, { params: t.Object({ id: t.String() }),
        body: t.Optional(t.Object({ revision: t.Optional(t.Integer({ minimum: 0 })),
          setId: t.Optional(t.String()) })) })
      .patch("/prep/sets/:id", ({ params, body }) => prep.renameSet(params.id, body.name), {
        params: t.Object({ id: t.String() }),
        body: t.Object({ name: t.String({ minLength: 1, maxLength: 120 }) }),
      })
      .delete("/prep/sets/:id", ({ params }) => prep.deleteSet(params.id), {
        params: t.Object({ id: t.String() }),
      })
      .get("/prep/analysis/:trackId", async ({ params, set }) => {
        const result = await getTrackAnalysis(params.trackId);
        if (!result) { set.status = 404; return { error: "Track unavailable in the local library" }; }
        return result;
      }, { params: t.Object({ trackId: t.Numeric({ minimum: 1 }) }) })
      .get("/prep/run-sheet", ({ query }) => new Response(prep.runSheet(query.setId), {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
      }), { query: t.Object({ setId: t.Optional(t.String()) }) })
      .put("/prep/draft", ({ body, set }) => {
        const result = prep.saveDraft(body);
        if (result.conflict) {
          set.status = 409;
          return { error: "This set changed in another tab. Reload before saving.", draft: result.draft };
        }
        return result.draft;
      }, {
        body: t.Object({
          revision: t.Integer({ minimum: 0 }),
          setId: t.Optional(t.String()),
          trackIds: t.Array(t.Integer({ minimum: 1 }), { maxItems: 500 }),
          notes: t.String({ maxLength: 20000 }),
          seedTrackId: t.Union([t.Integer({ minimum: 1 }), t.Null()]),
          transitions: t.Optional(t.Record(t.String({ pattern: "^[0-9]+:[0-9]+$" }),
            t.Object({ notes: t.String({ maxLength: 2000 }), practiced: t.Boolean(),
              rehearsal: t.Optional(t.Union([t.Literal("not-tried"), t.Literal("needs-work"), t.Literal("works")])),
              mixOut: t.Optional(t.Nullable(t.Object({ time: t.Number({ minimum: 0 }),
                label: t.String({ maxLength: 120 }), kind: t.Union([t.Literal("cue"), t.Literal("phrase")]) }))),
              mixIn: t.Optional(t.Nullable(t.Object({ time: t.Number({ minimum: 0 }),
                label: t.String({ maxLength: 120 }), kind: t.Union([t.Literal("cue"), t.Literal("phrase")]) }))),
              bars: t.Optional(t.Union(prep.TRANSITION_BARS.map((bars) => t.Literal(bars)))),
              preset: t.Optional(t.Union(prep.TRANSITION_PRESETS.map((preset) => t.Literal(preset)))),
              eq: t.Optional(t.Object({ volume: bandAutomation, bass: bandAutomation,
                mid: bandAutomation, high: bandAutomation })),
              fx: t.Optional(t.Nullable(t.Literal("echo"))),
              offsetBeats: t.Optional(t.Number({ minimum: -64, maximum: 64 })),
            }), { maxProperties: 1000 })),
          trackNotes: t.Optional(t.Record(t.String({ pattern: "^[0-9]+$" }),
            t.String({ maxLength: 2000 }), { maxProperties: 500 })),
        }),
      })
      .get("/prep/export.m3u8", ({ query }) => new Response(prep.exportDraft(query.setId), {
        headers: {
          "Content-Type": "audio/x-mpegurl; charset=utf-8",
          "Content-Disposition": prep.exportContentDisposition(query.setId),
        },
      }), { query: t.Object({ setId: t.Optional(t.String()) }) })

      // ---- learn: videos to watch and work through ----
      .get("/learn", () => ({ videos: learn.list(), counts: learn.counts() }))
      .post("/learn", async ({ body, set }) => {
        try { return await learn.add(body); }
        catch (error) { set.status = 400; return { error: (error as Error).message }; }
      }, { body: t.Object({ url: t.String({ minLength: 1, maxLength: 400 }),
        kind: t.Optional(t.Union([t.Literal("tutorial"), t.Literal("set")])),
        topic: t.Optional(t.Nullable(t.String({ maxLength: 80 }))) }) })
      .patch("/learn/:videoId", ({ params, body, set }) => {
        try { return learn.update(params.videoId, body); }
        catch (error) { set.status = 404; return { error: (error as Error).message }; }
      }, { params: t.Object({ videoId: t.String() }),
        body: t.Object({
          title: t.Optional(t.String({ minLength: 1, maxLength: 300 })),
          kind: t.Optional(t.Union([t.Literal("tutorial"), t.Literal("set")])),
          topic: t.Optional(t.Nullable(t.String({ maxLength: 80 }))),
          status: t.Optional(t.Union([t.Literal("queued"), t.Literal("watching"),
            t.Literal("done"), t.Literal("skipped")])),
          notes: t.Optional(t.String({ maxLength: 20000 })),
          position: t.Optional(t.Integer({ minimum: 0 })),
          sort: t.Optional(t.Integer({ minimum: 0 })),
        }) })
      // Same on-disk thumbnail cache the library uses, keyed by video id rather
      // than track id — a watchlist video has no row in `tracks`.
      .get("/learn/:videoId/thumb", async ({ params, set }) => {
        const path = await art.get(params.videoId);
        if (!path) { set.status = 404; return { error: "no art" }; }
        set.headers["content-type"] = "image/jpeg";
        set.headers["cache-control"] = "public, max-age=31536000, immutable";
        return new Response(Bun.file(path));
      })
      .post("/learn/:videoId/refresh", async ({ params, set }) => {
        try { return await learn.refresh(params.videoId); }
        catch (error) { set.status = 400; return { error: (error as Error).message }; }
      }, { params: t.Object({ videoId: t.String() }) })
      .delete("/learn/:videoId", ({ params, set }) => {
        try { return learn.remove(params.videoId); }
        catch (error) { set.status = 404; return { error: (error as Error).message }; }
      }, { params: t.Object({ videoId: t.String() }) })

      .post("/rescan", ({ body }) => scan(body?.full ?? false), {
        body: t.Optional(t.Object({ full: t.Optional(t.Boolean()) })),
      })

      // ---- tracks ----
      .post("/track/:id/favorite", ({ params, body, set }) => {
        const row = db.query<{ id: number; favorite: number }, [number, number]>(
          "UPDATE tracks SET favorite=? WHERE id=? RETURNING id,favorite",
        ).get(body.on ? 1 : 0, params.id);
        if (!row) { set.status = 404; return { error: "track not found" }; }
        return { id: row.id, favorite: row.favorite === 1 ? 1 as const : 0 as const };
      }, {
        params: t.Object({ id: t.Number() }),
        body: t.Object({ on: t.Boolean() }),
      })

      .patch("/track/:id", ({ params, body, set }) => {
        const track = db.query<{
          id: number; filename: string; content_hash: string | null;
          fileTitle: string | null; fileArtist: string | null;
          overrideTitle: string | null; overrideArtist: string | null;
        }, [number]>(`SELECT t.id,t.filename,t.content_hash,
              t.title AS fileTitle,t.artist AS fileArtist,
              o.title AS overrideTitle,o.artist AS overrideArtist
           FROM tracks t LEFT JOIN track_overrides o ON o.track_hash=t.content_hash
           WHERE t.id=?`).get(params.id);
        if (!track) { set.status = 404; return { error: "track not found" }; }
        if (!track.content_hash) {
          set.status = 409;
          return { error: "track has no content_hash" };
        }

        const hasTitle = Object.prototype.hasOwnProperty.call(body, "title");
        const hasArtist = Object.prototype.hasOwnProperty.call(body, "artist");
        const requestedTitle = hasTitle ? (body.title ?? null) : track.overrideTitle;
        const requestedArtist = hasArtist ? (body.artist ?? null) : track.overrideArtist;
        const title = requestedTitle === track.fileTitle ? null : requestedTitle;
        const artist = requestedArtist === track.fileArtist ? null : requestedArtist;
        const from = {
          title: track.overrideTitle ?? track.fileTitle,
          artist: track.overrideArtist ?? track.fileArtist,
        };
        const to = { title: title ?? track.fileTitle, artist: artist ?? track.fileArtist };
        const clearsOverride = to.title === track.fileTitle && to.artist === track.fileArtist;

        if (title !== track.overrideTitle || artist !== track.overrideArtist) {
          db.transaction(() => {
            if (clearsOverride) {
              db.query("DELETE FROM track_overrides WHERE track_hash=?").run(track.content_hash!);
              const withdrawn = ops.withdrawPendingMetadataEdits(track.content_hash!);
              if (!withdrawn.applied) return;
            } else {
              db.query(`INSERT INTO track_overrides(track_hash,title,artist,at) VALUES(?,?,?,?)
                ON CONFLICT(track_hash) DO UPDATE SET
                  title=excluded.title,artist=excluded.artist,at=excluded.at`,
              ).run(track.content_hash!, title, artist, now());
            }
            ops.recordMetadataEdit({
              trackHash: track.content_hash!,
              trackLabel: labelFor(to.artist, to.title, track.filename),
              from,
              to,
            });
          })();
        }

        return {
          id: track.id,
          title: to.title,
          artist: to.artist,
          fileTitle: track.fileTitle,
          fileArtist: track.fileArtist,
          edited: title !== null || artist !== null,
        };
      }, {
        params: t.Object({ id: t.Number() }),
        body: t.Object({
          title: t.Optional(t.Nullable(t.String())),
          artist: t.Optional(t.Nullable(t.String())),
        }),
      })

      .get("/track/:id/history", ({ params, set }) => {
        const track = db.query<{ path: string; content_hash: string | null }, [number]>(
          "SELECT path,content_hash FROM tracks WHERE id=?",
        ).get(params.id);
        if (!track) { set.status = 404; return { error: "track not found" }; }

        const rows = db.query<{
          id: number; at: number; kind: ops.OpKind; playlist: string | null;
          toPlaylist: string | null; label: string | null; payload: string | null;
          undone: number; appliedRekordbox: number; appliedFs: number;
        }, [string | null, string | null, string | null, string]>(`SELECT id,at,kind,playlist,
              to_playlist AS toPlaylist,track_label AS label,payload,undone,
              applied_rekordbox AS appliedRekordbox,applied_fs AS appliedFs
           FROM ops
           WHERE (? IS NOT NULL AND track_hash=?)
              OR ((? IS NULL OR track_hash IS NULL) AND track_path=? COLLATE NOCASE)
           ORDER BY at DESC,id DESC`,
        ).all(track.content_hash, track.content_hash, track.content_hash, track.path);
        return rows.map((row) => ({
          ...row,
          payload: row.payload === null ? null : JSON.parse(row.payload),
        }));
      }, { params: t.Object({ id: t.Number() }) })

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

      // Sidebar order. Local only: rekordbox keeps its own playlist order.
      .post("/playlists/order", ({ body }) => {
        const q = db.query("UPDATE playlists SET sort=? WHERE id=?");
        db.transaction(() => { body.ids.forEach((id, i) => q.run(i + 1, id)); })();
        return { ok: true };
      }, { body: t.Object({ ids: t.Array(t.Number()) }) })

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
      .post("/delete/stage", ({ body }) => {
        type PendingDelete = {
          id: number; content_hash: string | null; path: string;
          title: string | null; artist: string | null;
        };
        const all = db.query<PendingDelete, []>(`SELECT t.id,t.content_hash,t.path,t.title,t.artist
          FROM pending_deletes p JOIN tracks t ON t.id=p.track_id`);
        const byId = db.query<PendingDelete, [number]>(`SELECT t.id,t.content_hash,t.path,t.title,t.artist
          FROM pending_deletes p JOIN tracks t ON t.id=p.track_id WHERE p.track_id=?`);
        const openDelete = db.query<{ found: number }, [string]>(`SELECT 1 AS found FROM ops
          WHERE kind='delete_track' AND track_hash=? AND undone=0 LIMIT 1`);
        const requested = body?.trackIds;
        let skipped = 0;
        let staged = 0;

        db.transaction(() => {
          const ids = requested === undefined ? null : [...new Set(requested)];
          skipped += requested === undefined ? 0 : requested.length - ids!.length;
          const rows = ids === null
            ? all.all()
            : ids.flatMap((id) => {
                const row = byId.get(id);
                if (!row) skipped++;
                return row ? [row] : [];
              });
          for (const r of rows) {
            // One open hash intent covers the replay plan even if its path changed.
            if (r.content_hash && openDelete.get(r.content_hash)) {
              skipped++;
              continue;
            }
            ops.record("delete_track", {
              trackHash: r.content_hash, trackPath: r.path,
              trackLabel: [r.artist, r.title].filter(Boolean).join(" - "),
            });
            staged++;
          }
        })();

        return { staged, skipped, plan: "/api/plan/fs/text" };
      }, {
        body: t.Optional(t.Object({ trackIds: t.Optional(t.Array(t.Number())) })),
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
          store: t.Union([t.Literal("rekordbox"), t.Literal("fs")]),
          ids: t.Array(t.Number()),
        }),
      })
      .get("/plan/:store", ({ params }) => ops.plan(params.store), {
        params: t.Object({
          store: t.Union([t.Literal("rekordbox"), t.Literal("fs")]),
        }),
      })
      .get("/plan/:store/text", ({ params }) => new Response(ops.planText(params.store), {
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "content-disposition": `attachment; filename="plan-${params.store}.txt"`,
        },
      }), {
        params: t.Object({
          store: t.Union([t.Literal("rekordbox"), t.Literal("fs")]),
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

      // ---- changeset (read-only; applied by hand) ----
      .get("/changes", () => changes.compute())
      .post("/apply/rekordbox", async ({ set }) => {
        try { return await applyRekordbox(); }
        catch (e) {
          if (!(e instanceof RekordboxBusy)) throw e;
          set.status = 409;
          return { error: e.message };
        }
      })
      .get("/changes.txt", () => new Response(changes.asText(), {
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "content-disposition": 'attachment; filename="changeset.txt"',
        },
      }))

      // ---- upstream ----
      .get("/ytm/status", () => ytm.status())
      .get("/ytm/diff", () => ytm.diff())
      .get("/ytm/classify", () => ytm.classify())
      .get("/ytm/candidates", () => ytm.candidates())
      .post("/ytm/discover", () => ytm.discover())
      .post("/ytm/unlink", ({ body }) => {
        ytm.unlink(body.ytmId);
        return { ok: true };
      }, { body: t.Object({ ytmId: t.String() }) })
      .post("/ytm/refresh", ({ body }) =>
        ytm.refresh(body?.ytmIds, {
          includeUnlinked: body?.includeUnlinked,
        }), {
        body: t.Optional(t.Object({
          ytmIds: t.Optional(t.Array(t.String())),
          includeUnlinked: t.Optional(t.Boolean()),
        })),
      })
      .post("/ytm/pull", () => ytm.pull())
      .post("/ytm/adopt", ({ body }) => ytm.adopt(body.ytmId), {
        body: t.Object({ ytmId: t.String() }),
      })
      .post("/ytm/link", ({ body }) => {
        ytm.link(body.localPlaylistId, body.ytmId);
        return { ok: true };
      }, { body: t.Object({ localPlaylistId: t.Number(), ytmId: t.String() }) })
      .post("/ytm/backfill-memberships", () => ytm.backfillMemberships())

      // ---- staged upstream downloads ----
      .post("/ytm/stage", () => ytm.stage())
      .get("/ytm/staged", () => ytm.staged())
      .post("/ytm/staged/approve", ({ body }) => ytm.approve(body.videoIds), {
        body: t.Object({ videoIds: t.Array(t.String()) }),
      })
      .post("/ytm/staged/flag", ({ body }) => ytm.addFlag(body.videoIds, body.flag), {
        body: t.Object({ videoIds: t.Array(t.String()),
          flag: t.Union([t.Literal("unavailable"), t.Literal("premium"), t.Literal("in-library")]) }),
      })
      .post("/ytm/staged/reject", ({ body }) => ytm.reject(body.videoIds), {
        body: t.Object({ videoIds: t.Array(t.String()) }),
      })
      .post("/ytm/staged/download", ({ body, set }) => {
        const rows = ytm.approved(body?.videoIds, body?.localPlaylist);
        if (!rows.length) {
          set.status = 400;
          return { error: "no approved staged tracks" };
        }
        const playlists = [...new Set(rows.map((row) => row.localPlaylist))];
        if (playlists.length !== 1) {
          set.status = 409;
          return {
            error: "approved staged tracks span multiple local playlists",
            localPlaylists: playlists,
          };
        }
        const localPlaylist = playlists[0]!;
        const videoIds = rows.map((row) => row.videoId);
        const job = download.create(
          { videoIds, folder: localPlaylist },
          () => { ytm.completeStaged(videoIds, localPlaylist); },
        );
        return { jobId: job.jobId, localPlaylist, videoIds };
      }, {
        body: t.Optional(t.Object({
          videoIds: t.Optional(t.Array(t.String())),
          localPlaylist: t.Optional(t.String()),
        })),
      })

      // ---- additive downloads ----
      .post("/download", ({ body }) => download.create(body), {
        body: t.Object({
          ytmId: t.Optional(t.String()),
          videoIds: t.Optional(t.Array(t.String())),
          folder: t.String(),
        }),
      })
      .get("/download/:jobId", ({ params, set }) => {
        const job = download.get(params.jobId);
        if (!job) { set.status = 404; return { error: "download job not found" }; }
        return job;
      }, { params: t.Object({ jobId: t.String() }) })
      .get("/download", () => download.list())

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
  if (boot.seed.seeded) console.log(`  seeded from rekordbox: ${JSON.stringify(boot.seed)}`);
}
