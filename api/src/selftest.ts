/**
 * Correctness guards.
 *
 *   bun api/src/selftest.ts
 *
 * 1. Every video id the parser reports is actually present in that file's bytes.
 *    This is the check that caught cross-file buffer contamination: an id that
 *    does not appear anywhere in the file it was read from is fabricated.
 * 2. Metadata edits that return to the file tags withdraw unapplied work but
 *    preserve history that an external store has acted on.
 * 3. Selective delete staging leaves unrelated queued tracks alone and does
 *    not create a second open delete intent for the same content hash.
 * 4. YouTube Music staging is non-destructive, completion fans memberships
 *    out, and the existing-library backfill is idempotent.
 * 5. No module destructively mutates anything outside data/. Downloads are the
 *    sole exception and must remain additive.
 * 6. Windows-backed track paths and existing folder names reconcile without
 *    treating case-only differences as different files or directories.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { db } from "./db";
import { app } from "./index";
import { existingDirectoryCase, LIB, pathKey } from "./paths";
import { read } from "./tags";
import * as ytm from "./ytm";

const AUDIO = new Set([".m4a", ".webm"]);
const SKIP = new Set(["_TRASH", "PioneerDJ", "rekordbox"]);

function* walk(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP.has(e.name) || e.name.startsWith(".")) continue;
      yield* walk(full);
    } else if (AUDIO.has(extname(e.name).toLowerCase())) yield full;
  }
}

let failures = 0;
const fail = (msg: string) => { failures++; console.log(`  FAIL  ${msg}`); };

// ---- 1. video ids must exist in their own file ----
{
  const files = [...walk(LIB)];
  let checked = 0, withId = 0, bogus = 0;
  const dupIds = new Map<string, string[]>();

  for (const f of files) {
    const size = statSync(f).size;
    const md = await read(f, size);
    checked++;
    if (!md.videoId) continue;
    withId++;
    const list = dupIds.get(md.videoId);
    if (list) list.push(f); else dupIds.set(md.videoId, [f]);

    if (f.toLowerCase().endsWith(".m4a")) {
      const head = readFileSync(f).subarray(0, Math.min(size, 1_500_000));
      if (!head.includes(Buffer.from(md.videoId, "latin1"))) {
        bogus++;
        if (bogus <= 5) fail(`id ${md.videoId} not present in ${f.split("/").pop()}`);
      }
    }
  }

  if (bogus) fail(`${bogus}/${withId} files carry a video id not found in their own bytes`);
  else console.log(`  ok    ${withId}/${checked} video ids verified against file bytes`);

  const shared = [...dupIds.entries()].filter(([, v]) => v.length > 1);
  console.log(`  info  ${shared.length} video ids appear in more than one file` +
    ` (real duplicates, expected to be small)`);
  for (const [id, paths] of shared.slice(0, 6)) {
    console.log(`        ${id}  x${paths.length}  ${paths.map((p) => p.split("/").pop()!.slice(0, 44)).join(" | ")}`);
  }
}

// ---- 2. metadata revert accounting ----
{
  const hash = `selftest-metadata-${process.pid}`;
  const path = `/dj-organizer-selftest/${hash}.m4a`;
  db.exec("SAVEPOINT metadata_revert_selftest");
  try {
    const track = db.query<{ id: number }, [string, string, string, string, string]>(
      `INSERT INTO tracks(path,filename,title,artist,content_hash)
       VALUES(?,?,?,?,?) RETURNING id`,
    ).get(path, `${hash}.m4a`, "File title", "File artist", hash)!;
    const patch = (body: { title?: string | null; artist?: string | null }) =>
      app.handle(new Request(`http://localhost/api/track/${track.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }));
    const rows = () => db.query<{
      id: number; undone: number; applied_rekordbox: number;
    }, [string]>(`SELECT id,undone,applied_rekordbox FROM ops
      WHERE kind='edit_metadata' AND track_hash=? ORDER BY id`).all(hash);
    const overrides = () => db.query<{ n: number }, [string]>(
      "SELECT COUNT(*) AS n FROM track_overrides WHERE track_hash=?",
    ).get(hash)!.n;

    await patch({ title: null });
    if (rows().length !== 0) fail("clearing untouched metadata recorded an op");

    await patch({ title: "Edited title" });
    await patch({ artist: "Edited artist" });
    await patch({ title: null });
    if (rows().filter((r) => r.undone === 0).length !== 3) {
      fail("partial metadata revert did not remain pending");
    }
    await patch({ artist: null });
    const withdrawn = rows();
    if (withdrawn.length !== 3 || withdrawn.some((r) => r.undone !== 1)) {
      fail("full metadata revert did not withdraw every unapplied edit");
    }
    if (overrides() !== 0) fail("full metadata revert left an override row");

    await patch({ title: "Applied title" });
    const applied = rows().at(-1)!;
    db.query("UPDATE ops SET applied_rekordbox=123 WHERE id=?").run(applied.id);
    await patch({ title: null });
    const preserved = rows().slice(-2);
    if (preserved.length !== 2
      || preserved[0]!.id !== applied.id
      || preserved[0]!.undone !== 0
      || preserved[0]!.applied_rekordbox !== 123
      || preserved[1]!.id === applied.id
      || preserved[1]!.undone !== 0) {
      fail("applied metadata edit was not preserved with a new revert op");
    }
    const count = rows().length;
    await patch({ title: null });
    if (rows().length !== count) fail("clearing untouched metadata changed op history");
    if (overrides() !== 0) fail("applied metadata revert left an override row");

    if (failures === 0) console.log("  ok    metadata revert accounting");
  } finally {
    db.exec("ROLLBACK TO metadata_revert_selftest");
    db.exec("RELEASE metadata_revert_selftest");
  }
}

// ---- 3. selective delete staging ----
{
  const key = `selftest-delete-${process.pid}`;
  db.exec("SAVEPOINT selective_delete_selftest");
  try {
    const addTrack = db.query<{ id: number }, [string, string, string]>(
      `INSERT INTO tracks(path,filename,content_hash) VALUES(?,?,?) RETURNING id`,
    );
    const first = addTrack.get(`/dj-organizer-selftest/${key}-1.m4a`, `${key}-1.m4a`, `${key}-1`)!;
    const second = addTrack.get(`/dj-organizer-selftest/${key}-2.m4a`, `${key}-2.m4a`, `${key}-2`)!;
    const notQueued = db.query<{ id: number }, [number, number]>(`SELECT t.id FROM tracks t
      WHERE NOT EXISTS (SELECT 1 FROM pending_deletes p WHERE p.track_id=t.id)
        AND t.id NOT IN (?,?) LIMIT 1`).get(first.id, second.id)!;
    const post = (path: string, body: unknown) => app.handle(new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }));
    const result = async (response: Promise<Response>) =>
      await (await response).json() as { staged: number; skipped: number };
    const openDeletes = (hash: string) => db.query<{ n: number }, [string]>(`SELECT COUNT(*) AS n
      FROM ops WHERE kind='delete_track' AND track_hash=? AND undone=0`,
    ).get(hash)!.n;

    await post("/api/delete", { trackIds: [first.id, second.id], reason: "selftest" });
    const selective = await result(post("/api/delete/stage", {
      trackIds: [first.id, notQueued.id],
    }));
    const secondQueued = db.query<{ n: number }, [number]>(
      "SELECT COUNT(*) AS n FROM pending_deletes WHERE track_id=?",
    ).get(second.id)!.n;
    if (selective.staged !== 1 || selective.skipped !== 1
      || openDeletes(`${key}-1`) !== 1 || openDeletes(`${key}-2`) !== 0
      || secondQueued !== 1) {
      fail("selective delete staging changed or promoted the wrong queued track");
    }

    const duplicate = await result(post("/api/delete/stage", { trackIds: [first.id] }));
    if (duplicate.staged !== 0 || duplicate.skipped !== 1 || openDeletes(`${key}-1`) !== 1) {
      fail("selective delete staging created a duplicate open delete intent");
    }
    if (failures === 0) console.log("  ok    selective delete staging and duplicate guard");
  } finally {
    db.exec("ROLLBACK TO selective_delete_selftest");
    db.exec("RELEASE selective_delete_selftest");
  }
}

// ---- 4. YTM staging and multi-membership accounting ----
{
  const key = `selftest-ytm-${process.pid}`;
  db.exec("SAVEPOINT ytm_membership_selftest");
  try {
    const addPlaylist = db.query<{ id: number }, [string]>(
      "INSERT INTO playlists(name) VALUES(?) RETURNING id",
    );
    const playlistId = (name: string) => db.query<{ id: number }, [string]>(
      "SELECT id FROM playlists WHERE name=?",
    ).get(name)?.id ?? addPlaylist.get(name)!.id;
    const primaryName = `${key}-primary`;
    const automaticName = `${key}-automatic`;
    const backfillName = `${key}-backfill`;
    const manualName = `${key}-manual-choice`;
    if (!ytm.AUTO_MEMBERSHIP_EXCLUDED_PLAYLISTS.length) ytm.AUTO_MEMBERSHIP_EXCLUDED_PLAYLISTS.push(`${key}-excluded`);
    const excludedName = ytm.AUTO_MEMBERSHIP_EXCLUDED_PLAYLISTS[0]!;
    const primaryId = playlistId(primaryName);
    const automaticId = playlistId(automaticName);
    const backfillId = playlistId(backfillName);
    playlistId(manualName);
    const excludedId = playlistId(excludedName);
    const addSource = db.query(
      `INSERT INTO ytm_playlists(ytm_id,title,count,local_playlist_id,fetched_at)
       VALUES(?,?,?,?,1)`,
    );
    const addUpstreamTrack = db.query(
      "INSERT INTO ytm_tracks(ytm_id,video_id,title,artist,sort) VALUES(?,?,?,?,?)",
    );
    const source = (suffix: string, localId: number) => {
      const id = `${key}-${suffix}`;
      addSource.run(id, id, 2, localId);
      return id;
    };

    const stageSource = source("stage-source", primaryId);
    const preservedVideo = `${key}-preserved-video`;
    const newVideo = `${key}-new-video`;
    addUpstreamTrack.run(stageSource, preservedVideo, "Upstream title", "Upstream artist", 1);
    addUpstreamTrack.run(stageSource, newVideo, "New title", "New artist", 2);
    db.query(`INSERT INTO ytm_staged(
      video_id,ytm_id,local_playlist,title,artist,status,flags,staged_at
    ) VALUES(?,?,?,?,?,'approved','manual-flag',7)`).run(
      preservedVideo, "manual-source", manualName, "Manual title", "Manual artist",
    );

    const stagedOnce = ytm.stage();
    const preserved = db.query<{
      ytm_id: string; local_playlist: string; title: string; artist: string;
      status: string; flags: string; staged_at: number;
    }, [string]>("SELECT * FROM ytm_staged WHERE video_id=?").get(preservedVideo)!;
    const inserted = db.query<{ status: string; local_playlist: string }, [string]>(
      "SELECT status,local_playlist FROM ytm_staged WHERE video_id=?",
    ).get(newVideo)!;
    const stagedTwice = ytm.stage();
    if (stagedOnce.staged < 1 || stagedOnce.skipped < 1
      || preserved.ytm_id !== "manual-source"
      || preserved.local_playlist !== manualName
      || preserved.title !== "Manual title"
      || preserved.artist !== "Manual artist"
      || preserved.status !== "approved"
      || preserved.flags !== "manual-flag"
      || preserved.staged_at !== 7
      || inserted.status !== "pending"
      || inserted.local_playlist !== primaryName
      || stagedTwice.staged !== 0) {
      fail("YTM stage rerun changed existing review state or failed to insert only new videos");
    }

    const completeVideo = `${key}-complete-video`;
    const primarySource = source("complete-primary", primaryId);
    const automaticSource = source("complete-automatic", automaticId);
    const excludedSource = source("complete-excluded", excludedId);
    for (const upstream of [primarySource, automaticSource, excludedSource]) {
      addUpstreamTrack.run(upstream, completeVideo, "Complete title", "Artist", 1);
    }
    const completeTrack = db.query<{ id: number }, [string, string, string]>(
      `INSERT INTO tracks(path,filename,video_id) VALUES(?,?,?) RETURNING id`,
    ).get(`/dj-organizer-selftest/${completeVideo}.m4a`, `${completeVideo}.m4a`, completeVideo)!;
    db.query(`INSERT INTO ytm_staged(
      video_id,ytm_id,local_playlist,title,artist,status,flags,staged_at
    ) VALUES(?,?,?,?,?,'approved','',1)`).run(
      completeVideo, primarySource, primaryName, "Complete title", "Artist",
    );

    const completed = ytm.completeStaged([completeVideo], primaryName);
    const memberships = db.query<{ name: string }, [number]>(`SELECT p.name
      FROM memberships m JOIN playlists p ON p.id=m.playlist_id
      WHERE m.track_id=? ORDER BY p.name`).all(completeTrack.id).map((row) => row.name);
    const completeOps = () => db.query<{ playlist: string }, [string]>(`SELECT playlist
      FROM ops WHERE kind='add_to' AND track_path=? ORDER BY playlist`,
    ).all(`/dj-organizer-selftest/${completeVideo}.m4a`).map((row) => row.playlist);
    const completedAgain = ytm.completeStaged([completeVideo], primaryName);
    if (completed.downloaded.length !== 1 || completed.membershipsAdded !== 2
      || memberships.join("|") !== [automaticName, primaryName].sort().join("|")
      || completeOps().join("|") !== [automaticName, primaryName].sort().join("|")
      || completedAgain.downloaded.length !== 0 || completedAgain.membershipsAdded !== 0
      || completeOps().length !== 2) {
      fail("YTM completion did not fan out eligible memberships idempotently");
    }

    const backfillVideo = `${key}-backfill-video`;
    const backfillSource = source("backfill-automatic", backfillId);
    const backfillExcludedSource = source("backfill-excluded", excludedId);
    addUpstreamTrack.run(backfillSource, backfillVideo, "Backfill title", "Artist", 1);
    addUpstreamTrack.run(backfillExcludedSource, backfillVideo, "Backfill title", "Artist", 1);
    const backfillTrack = db.query<{ id: number }, [string, string, string]>(
      `INSERT INTO tracks(path,filename,video_id) VALUES(?,?,?) RETURNING id`,
    ).get(`/dj-organizer-selftest/${backfillVideo}.m4a`, `${backfillVideo}.m4a`, backfillVideo)!;
    const postBackfill = () => app.handle(new Request(
      "http://localhost/api/ytm/backfill-memberships", { method: "POST" },
    ));
    const firstBackfill = await (await postBackfill()).json() as {
      added: number; byPlaylist: Record<string, number>;
    };
    const secondBackfill = await (await postBackfill()).json() as {
      added: number; byPlaylist: Record<string, number>;
    };
    const backfillMemberships = db.query<{ name: string }, [number]>(`SELECT p.name
      FROM memberships m JOIN playlists p ON p.id=m.playlist_id
      WHERE m.track_id=? ORDER BY p.name`).all(backfillTrack.id).map((row) => row.name);
    if (firstBackfill.byPlaylist[backfillName] !== 1
      || backfillMemberships.join("|") !== backfillName
      || secondBackfill.added !== 0
      || Object.keys(secondBackfill.byPlaylist).length !== 0) {
      fail("YTM membership backfill ignored exclusions or was not idempotent");
    }

    if (failures === 0) {
      console.log("  ok    YTM staging preservation, membership fan-out, and backfill");
    }
  } finally {
    db.exec("ROLLBACK TO ytm_membership_selftest");
    db.exec("RELEASE ytm_membership_selftest");
  }
}

// ---- 5. no destructive writer may point at the library or rekordbox ----
{
  const MUTATORS =
    /\b(writeFileSync|writeFile|renameSync|unlinkSync|rmSync|rmdirSync|copyFileSync|Bun\.write)\s*\(/;
  // These write inside data/ only: op log, sqlite snapshots, cover-art cache.
  const DATA_ONLY = new Set(["db.ts", "snapshots.ts", "art.ts"]);
  const offenders: string[] = [];
  const testOffenders: string[] = [];
  for (const fn of readdirSync(import.meta.dir)) {
    if (!fn.endsWith(".ts") || DATA_ONLY.has(fn)) continue;
    const source = readFileSync(join(import.meta.dir, fn), "utf8");

    // Suites build and tear down their own fixtures, so mutation is expected
    // there. What they must never do is aim at the real library: the rule being
    // defended is "the user's music is never touched", not "nothing writes".
    if (fn.endsWith(".test.ts")) {
      if (source.includes(LIB)) testOffenders.push(`${fn} references the real library root`);
      continue;
    }

    source.split("\n").forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, "");
      if (/^\s*\*/.test(line)) return;
      if (MUTATORS.test(code)) offenders.push(`${fn}:${i + 1}  ${line.trim()}`);
    });
  }
  const downloader = readFileSync(join(import.meta.dir, "download.ts"), "utf8");
  if (!downloader.includes('"--no-overwrites"')) {
    fail("download.ts does not enforce yt-dlp --no-overwrites");
  }
  if (offenders.length) {
    fail(`destructive filesystem mutation outside data/:\n        ${offenders.join("\n        ")}`);
  } else {
    console.log("  ok    library writes are additive downloads with --no-overwrites");
  }
  if (testOffenders.length) {
    fail(`test suite points at the real library:\n        ${testOffenders.join("\n        ")}`);
  } else {
    console.log("  ok    test suites keep their fixtures away from the real library");
  }
}

// ---- 6. case-insensitive Windows path identity and real directory casing ----
{
  const lower = `${LIB}/vibe/example.m4a`;
  const upper = `${LIB}/Vibe/Example.m4a`;
  if (pathKey(lower) !== pathKey(upper)) {
    fail("case-only track paths did not reconcile to one identity");
  }

  const existing = readdirSync(LIB, { withFileTypes: true }).find(
    (entry) => entry.isDirectory() && /[a-z]/i.test(entry.name),
  );
  if (existing) {
    const requested = existing.name.replace(/[a-z]/i, (letter) =>
      letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase());
    const resolved = existingDirectoryCase(LIB, join(LIB, requested));
    if (resolved !== join(LIB, existing.name)) {
      fail(`existing directory casing was not preserved: ${resolved}`);
    }
  }
  if (failures === 0) console.log("  ok    case-insensitive path reconciliation");
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nall checks passed");
process.exit(failures ? 1 : 0);
