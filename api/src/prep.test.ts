import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Select an isolated database before application modules load. No user DB or
// music scan participates in this suite.
const testData = mkdtempSync(join(tmpdir(), "dj-organizer-prep-"));
const testAudio = mkdtempSync(join(process.env.DJ_TEST_WIN_DIR || "/mnt/c/Users/Public", ".dj-organizer-test-"));
process.env.NODE_ENV = "test";
process.env.DJ_ORGANIZER_TEST_DATA = testData;
const [{ db }, { app }] = await Promise.all([import("./db"), import("./index")]);
const { keyRelationshipDistance } = await import("./suggestions");

type Draft = { revision: number; trackIds: number[]; notes: string; seedTrackId: number | null;
  transitions?: Record<string, { notes: string; practiced: boolean }>;
  trackNotes?: Record<string, string> };
type TestTrack = { id: number; path: string };
const request = (path: string, init?: RequestInit) => app.handle(new Request(`http://localhost${path}`, init));
const json = (path: string, method = "GET", body?: unknown) => request(path, { method,
  headers: body === undefined ? undefined : { "content-type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body) });
let tracks: TestTrack[] = [];
let playlistId = 0;

beforeAll(() => {
  const add = db.query<{ id: number }, [string, string, string, string, string]>(
    "INSERT INTO tracks(path,filename,title,artist,content_hash) VALUES(?,?,?,?,?) RETURNING id");
  tracks = ["first.m4a", "second.m4a", "deleted.m4a", "duplicate.m4a", "outside.m4a"]
    .map((filename, index) => {
    const path = join(testAudio, filename);
    writeFileSync(path, `test audio ${index}`);
    const title = index === 1 ? "<script>alert('title')</script>" : `Track ${index + 1}`;
    const hash = index === 3 ? "same-audio" : index === 0 ? "same-audio" : `hash-${index}`;
    return { id: add.get(path, filename, title, "Test Artist", hash)!.id, path };
  });
  db.query("INSERT INTO pending_deletes(track_id,queued_at,reason) VALUES(?,?,?)")
    .run(tracks[2]!.id, 1, "test");
  playlistId = db.query<{ id: number }, []>(
    "INSERT INTO playlists(name,sort,is_manual,created_at) VALUES('Scoped set',1,1,1) RETURNING id",
  ).get()!.id;
  const membership = db.query("INSERT INTO memberships(playlist_id,track_id,sort) VALUES(?,?,?)");
  [tracks[0]!, tracks[1]!, tracks[3]!].forEach((track, index) =>
    membership.run(playlistId, track.id, index));
  const observedAt = Math.floor(Date.now() / 1000);
  const payload = { store: "rekordbox", observedAt, available: true, groups: {},
    paths: tracks.map((track) => track.path), dangling: [], playlists: [],
    tracks: tracks.map((track, index) => ({ sourceId: `rb-${index}`, path: track.path,
      title: `Track ${index + 1}`, artist: "Test Artist", bpm: 120 + index, key: `${8 + index}A`,
      comment: null, analysisDataPath: index === 4 ? "/../../outside-analysis.DAT" : null, cues: index === 1 ? [{ id: "native-cue", time: 12.345,
        endTime: null, kind: "memory", index: null, label: "Saved entry", comment: null }] : [],
      trackNo: index + 1, fileSize: 12, bitRate: 320, length: 180 })) };
  db.query("INSERT INTO observations(store,observed_at,tracks,playlists,digest,payload) VALUES(?,?,?,?,?,?)")
    .run("rekordbox", observedAt, tracks.length, 0, "test-observation", JSON.stringify(payload));
});

afterAll(() => {
  db.close();
  rmSync(testData, { recursive: true, force: true });
  rmSync(testAudio, { recursive: true, force: true });
});

describe("preparation API on an isolated catalog", () => {
  test("analysis API distinguishes unknown tracks, absent files, and usable native cues", async () => {
    expect((await json("/api/prep/analysis/2147483647")).status).toBe(404);
    const missing = await (await json(`/api/prep/analysis/${tracks[0]!.id}`)).json();
    expect(missing.status).toBe("missing");
    expect(missing.summary.beatCount).toBe(0);
    const cuesOnly = await (await json(`/api/prep/analysis/${tracks[1]!.id}`)).json();
    expect(cuesOnly.status).toBe("partial");
    expect(cuesOnly.cues[0].time).toBe(12.345);
    expect(cuesOnly.anchors[0].kind).toBe("cue");
    expect(cuesOnly.waveform).toBeNull();
    const invalidPath = await (await json(`/api/prep/analysis/${tracks[4]!.id}`)).json();
    expect(invalidPath.status).toBe("missing");
    expect(invalidPath.issues[0]).toContain("invalid analysis location");
  });

  test("normalizes conventional and Camelot keys", () => {
    expect(keyRelationshipDistance("Am", "8A")).toBe(0);
    expect(keyRelationshipDistance("F#m", "11A")).toBe(0);
    expect(keyRelationshipDistance("C", "9B")).toBe(1);
    expect(keyRelationshipDistance("unknown", "8A")).toBeNull();
  });

  test("preserves repeated order, notes, and transition prep; rejects stale revisions", async () => {
    const current = await (await json("/api/prep/draft")).json() as Draft;
    const pair = `${tracks[0]!.id}:${tracks[1]!.id}`;
    const body: Draft = { revision: current.revision,
      trackIds: [tracks[0]!.id, tracks[1]!.id, tracks[0]!.id],
      notes: "Birthday set: preserve this exact order.", seedTrackId: tracks[0]!.id,
      transitions: { [pair]: { notes: "Swap bass after 16 bars", practiced: true } },
      trackNotes: { [tracks[0]!.id]: "Start after the spoken intro" } };
    const response = await json("/api/prep/draft", "PUT", body);
    expect(response.status).toBe(200);
    const saved = await response.json() as Draft;
    expect(saved.revision).toBe(current.revision + 1);
    expect(saved.trackIds).toEqual(body.trackIds);
    expect(saved.notes).toBe(body.notes);
    expect(saved.transitions).toEqual(body.transitions);
    expect(saved.trackNotes).toEqual(body.trackNotes);
    expect(await (await json("/api/prep/draft")).json()).toEqual(saved);
    const conflict = await json("/api/prep/draft", "PUT", body);
    expect(conflict.status).toBe(409);
    expect((await conflict.json() as { draft: Draft }).draft).toEqual(saved);
  });

  test("accepts old drafts without track notes and preserves notes through reorder", async () => {
    const current = await (await json("/api/prep/draft")).json() as Draft;
    const legacy = await json("/api/prep/draft", "PUT", { revision: current.revision,
      trackIds: [tracks[0]!.id, tracks[1]!.id], notes: "legacy shape",
      seedTrackId: tracks[0]!.id, transitions: {} });
    expect(legacy.status).toBe(200);
    const legacyDraft = await legacy.json() as Draft;
    expect(legacyDraft.trackNotes).toBeUndefined();

    const trackNotes = { [tracks[0]!.id]: "Opener note", [tracks[1]!.id]: "Closer note" };
    const withNotes = await json("/api/prep/draft", "PUT", { ...legacyDraft, trackNotes });
    expect(withNotes.status).toBe(200);
    const noted = await withNotes.json() as Draft;
    const reordered = await json("/api/prep/draft", "PUT", { ...noted,
      trackIds: [...noted.trackIds].reverse() });
    expect(reordered.status).toBe(200);
    expect((await reordered.json() as Draft).trackNotes).toEqual(trackNotes);
  });

  test("renders an escaped, read-only run sheet with practiced pair notes", async () => {
    const current = await (await json("/api/prep/draft")).json() as Draft;
    const pair = `${tracks[0]!.id}:${tracks[1]!.id}`;
    const notes = "Plan <script>alert('notes')</script> & finish strong";
    const transitionNotes = "Mix <img src=x onerror=alert(1)> after 16 bars";
    const trackNote = "Cue <svg onload=alert('track-note')> after intro";
    const save = await json("/api/prep/draft", "PUT", { ...current,
      trackIds: [tracks[0]!.id, tracks[1]!.id], notes, seedTrackId: tracks[0]!.id,
      transitions: { [pair]: { notes: transitionNotes, practiced: true } },
      trackNotes: { [tracks[0]!.id]: trackNote } });
    expect(save.status).toBe(200);
    const before = await (await json("/api/prep/draft")).json() as Draft;
    const response = await request("/api/prep/run-sheet");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const html = await response.text();
    expect(html).toContain("Practiced on decks");
    expect(html).toContain("Mix &lt;img src=x onerror=alert(1)&gt; after 16 bars");
    expect(html).toContain("&lt;script&gt;alert(&#39;title&#39;)&lt;/script&gt;");
    expect(html).toContain("Plan &lt;script&gt;alert(&#39;notes&#39;)&lt;/script&gt; &amp; finish strong");
    expect(html).toContain("Cue &lt;svg onload=alert(&#39;track-note&#39;)&gt; after intro");
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<svg onload");
    expect(await (await json("/api/prep/draft")).json()).toEqual(before);
  });

  const richTransition = { notes: "Swap on the drop", practiced: false, rehearsal: "needs-work",
    mixOut: { time: 96.5, label: "Outro 1", kind: "phrase" },
    mixIn: { time: 12.345, label: "Saved entry", kind: "cue" },
    bars: 16, preset: "bass-swap",
    eq: { volume: { mode: "crossfade", at: 0.5 }, bass: { mode: "swap", at: 0.75 },
      mid: { mode: "fade-in", at: 0 }, high: { mode: "none", at: 1 } },
    fx: "echo", offsetBeats: -2.5 };

  test("round-trips richer transition data and prints preset + bars on the run sheet", async () => {
    const current = await (await json("/api/prep/draft")).json() as Draft;
    const pair = `${tracks[0]!.id}:${tracks[1]!.id}`;
    const response = await json("/api/prep/draft", "PUT", { ...current,
      trackIds: [tracks[0]!.id, tracks[1]!.id], seedTrackId: tracks[0]!.id,
      transitions: { [pair]: richTransition } });
    expect(response.status).toBe(200);
    expect((await response.json() as Draft).transitions?.[pair]).toEqual(richTransition);
    expect((await (await json("/api/prep/draft")).json() as Draft).transitions?.[pair])
      .toEqual(richTransition);
    expect(await (await request("/api/prep/run-sheet")).text()).toContain("Bass swap · 16 bars");

    const cleared = { ...richTransition, fx: null, offsetBeats: 64, bars: 1, preset: "cut" };
    const latest = await (await json("/api/prep/draft")).json() as Draft;
    const second = await json("/api/prep/draft", "PUT", { ...latest, transitions: { [pair]: cleared } });
    expect(second.status).toBe(200);
    expect((await second.json() as Draft).transitions?.[pair]).toEqual(cleared);
    expect(await (await request("/api/prep/run-sheet")).text()).toContain("Cut · 1 bar<");
  });

  test("old-shape transitions save and load unchanged, without a transition line", async () => {
    const current = await (await json("/api/prep/draft")).json() as Draft;
    const pair = `${tracks[0]!.id}:${tracks[1]!.id}`;
    const legacy = { notes: "Old reminder", practiced: true, rehearsal: "works",
      mixOut: { time: 30, label: "Chorus", kind: "phrase" }, mixIn: null };
    const response = await json("/api/prep/draft", "PUT", { ...current,
      trackIds: [tracks[0]!.id, tracks[1]!.id], seedTrackId: tracks[0]!.id,
      transitions: { [pair]: legacy } });
    expect(response.status).toBe(200);
    const saved = (await response.json() as Draft).transitions?.[pair];
    expect(saved).toEqual(legacy);
    expect(Object.keys(saved!).sort()).toEqual(Object.keys(legacy).sort());
    expect(await (await request("/api/prep/run-sheet")).text()).not.toContain('class="transition"');
  });

  test("rejects out-of-range or unknown transition values without saving", async () => {
    const current = await (await json("/api/prep/draft")).json() as Draft;
    const pair = `${tracks[0]!.id}:${tracks[1]!.id}`;
    const eq = richTransition.eq;
    const invalid: Array<[string, Record<string, unknown>]> = [
      ["bars", { bars: 3 }], ["bars", { bars: 64 }], ["preset", { preset: "spinback" }],
      ["offsetBeats", { offsetBeats: 64.5 }], ["offsetBeats", { offsetBeats: -65 }],
      ["fx", { fx: "reverb" }],
      ["bass", { eq: { ...eq, bass: { mode: "swap", at: 1.5 } } }],
      ["volume", { eq: { ...eq, volume: { mode: "swap", at: -0.1 } } }],
      ["mid", { eq: { ...eq, mid: { mode: "wobble", at: 0 } } }],
      ["high", { eq: { volume: eq.volume, bass: eq.bass, mid: eq.mid } }],
    ];
    for (const [property, change] of invalid) {
      const response = await json("/api/prep/draft", "PUT", { ...current,
        transitions: { [pair]: { ...richTransition, ...change } } });
      expect(response.ok).toBe(false);
      const { error } = await response.json() as { error: string };
      expect(error).toContain('"validation"');
      expect(error).toContain(property);
    }
    expect(await (await json("/api/prep/draft")).json()).toEqual(current);
  });

  test("rejects a draft containing an unknown track", async () => {
    const current = await (await json("/api/prep/draft")).json() as Draft;
    const response = await json("/api/prep/draft", "PUT", { ...current,
      trackIds: [2_147_483_647], seedTrackId: null });
    expect(response.status).toBe(500);
    expect((await response.json() as { error: string }).error).toContain("no longer exists");
  });

  test("exports repeated tracks in order with Windows paths", async () => {
    const current = await (await json("/api/prep/draft")).json() as Draft;
    const order = [tracks[1]!.id, tracks[0]!.id, tracks[1]!.id];
    expect((await json("/api/prep/draft", "PUT", { ...current,
      trackIds: order, seedTrackId: tracks[0]!.id })).status).toBe(200);
    const response = await request("/api/prep/export.m3u8");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("audio/x-mpegurl");
    expect((await response.text()).trim().split("\n")).toEqual(["#EXTM3U",
      `C:${tracks[1]!.path.slice("/mnt/c".length)}`, `C:${tracks[0]!.path.slice("/mnt/c".length)}`,
      `C:${tracks[1]!.path.slice("/mnt/c".length)}`]);
  });

  test("refuses export when a selected track is marked missing", async () => {
    const current = await (await json("/api/prep/draft")).json() as Draft;
    expect((await json("/api/prep/draft", "PUT", { ...current,
      trackIds: [tracks[0]!.id], seedTrackId: tracks[0]!.id })).status).toBe(200);
    db.query("UPDATE tracks SET missing=1 WHERE id=?").run(tracks[0]!.id);
    const response = await request("/api/prep/export.m3u8");
    expect(response.status).toBe(500);
    expect((await response.json() as { error: string }).error).toContain("missing");
    db.query("UPDATE tracks SET missing=0 WHERE id=?").run(tracks[0]!.id);
  });

  test("suggestions expose numeric ids and omit deleted tracks", async () => {
    const response = await request(`/api/suggestions?trackId=${tracks[0]!.id}&limit=20`);
    expect(response.status).toBe(200);
    const payload = await response.json() as { candidates: { trackId: number }[] };
    expect(payload.candidates.length).toBeGreaterThan(0);
    expect(payload.candidates.every((candidate) => Number.isInteger(candidate.trackId))).toBe(true);
    expect(payload.candidates.some((candidate) => candidate.trackId === tracks[2]!.id)).toBe(false);
  });

  test("suggestion model and coverage span the full library, not the selected playlist", async () => {
    const response = await request("/api/suggestions/model");
    expect(response.status).toBe(200);
    const payload = await response.json() as {
      tracks: { trackId: number }[];
      coverage: {
        localTracks: number; matchedTracks: number; analysisLinkedTracks: number;
        cueTracks: number; totalCues: number; unmatchedTracks: number;
        nativeTracks: number; nativeAnalysisTracks: number;
      };
    };
    const ids = payload.tracks.map((track) => track.trackId);

    expect(ids).toContain(tracks[4]!.id); // deliberately outside Scoped set
    expect(ids).not.toContain(tracks[2]!.id); // pending deletion is not usable library scope
    expect(payload.coverage).toEqual({
      localTracks: 4,
      matchedTracks: 4,
      analysisLinkedTracks: 1,
      cueTracks: 1,
      totalCues: 1,
      unmatchedTracks: 0,
      nativeTracks: 5,
      nativeAnalysisTracks: 1,
    });
  });

  test("scopes candidates to a local playlist and suppresses duplicate audio", async () => {
    const current = await (await json("/api/prep/draft")).json() as Draft;
    // Keep only the seed in the draft: route-level exclusions must not hide the
    // expected second playlist member.
    expect((await json("/api/prep/draft", "PUT", { ...current,
      trackIds: [tracks[0]!.id], seedTrackId: tracks[0]!.id, transitions: {} })).status).toBe(200);
    const response = await request(
      `/api/suggestions?trackId=${tracks[0]!.id}&localPlaylistId=${playlistId}&limit=20`,
    );
    expect(response.status).toBe(200);
    const payload = await response.json() as { candidates: { trackId: number }[] };
    const candidateIds = payload.candidates.map((candidate) => candidate.trackId);
    expect(candidateIds).toContain(tracks[1]!.id);
    expect(candidateIds).not.toContain(tracks[3]!.id); // same content_hash as seed
    expect(candidateIds).not.toContain(tracks[4]!.id); // outside playlist
    expect(candidateIds).not.toContain(tracks[2]!.id); // pending deletion
  });

  test("imports playlist members in saved order, excluding unavailable rows", async () => {
    const membership = db.query(
      "INSERT OR IGNORE INTO memberships(playlist_id,track_id,sort) VALUES(?,?,?)");
    membership.run(playlistId, tracks[2]!.id, 1);
    db.query("UPDATE memberships SET sort=? WHERE playlist_id=? AND track_id=?")
      .run(10, playlistId, tracks[0]!.id);
    db.query("UPDATE memberships SET sort=? WHERE playlist_id=? AND track_id=?")
      .run(5, playlistId, tracks[1]!.id);
    db.query("UPDATE memberships SET sort=? WHERE playlist_id=? AND track_id=?")
      .run(20, playlistId, tracks[3]!.id);
    try {
      const response = await request(`/api/prep/playlist/${playlistId}`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        playlist: { id: playlistId, name: "Scoped set" },
        trackIds: [tracks[1]!.id, tracks[0]!.id, tracks[3]!.id],
        unavailable: [tracks[2]!.id],
      });
      expect((await request("/api/prep/playlist/2147483647")).status).toBe(404);
    } finally {
      db.query("DELETE FROM memberships WHERE playlist_id=? AND track_id=?")
        .run(playlistId, tracks[2]!.id);
    }
  });

  test("priority and half-double controls use explicit native evidence deterministically", async () => {
    const latest = db.query<{ payload: string; observed_at: number }, []>(
      "SELECT payload,observed_at FROM observations WHERE store='rekordbox' ORDER BY id DESC LIMIT 1",
    ).get()!;
    const payload = JSON.parse(latest.payload);
    const add = db.query<{ id: number }, [string, string, string, string]>(
      "INSERT INTO tracks(path,filename,title,content_hash) VALUES(?,?,?,?) RETURNING id");
    const facts = [
      { file: "rank-seed.m4a", title: "Rank Seed", bpm: 70, key: "8A" },
      { file: "rank-tempo.m4a", title: "Tempo Match", bpm: 71, key: "2B" },
      { file: "rank-key.m4a", title: "Key Match", bpm: 75, key: "8A" },
      { file: "rank-double.m4a", title: "Double Tempo", bpm: 140, key: "8A" },
    ];
    const added = facts.map((fact, index) => {
      const path = join(testAudio, fact.file);
      writeFileSync(path, `ranking audio ${index}`);
      const id = add.get(path, fact.file, fact.title, `rank-${index}`)!.id;
      payload.paths.push(path);
      payload.tracks.push({ sourceId: `rank-rb-${index}`, path, title: fact.title,
        artist: "Ranking Artist", bpm: fact.bpm, key: fact.key, comment: null,
        analysisDataPath: null, cues: [], trackNo: index + 1, fileSize: 12,
        bitRate: 320, length: 180 });
      return { id, ...fact };
    });
    const record = db.query(
      "INSERT INTO observations(store,observed_at,tracks,playlists,digest,payload) VALUES(?,?,?,?,?,?)");
    record.run("rekordbox", latest.observed_at + 1, payload.tracks.length, 0,
      "ranking-observation", JSON.stringify(payload));
    try {
      const query = async (suffix: string) => (await (await request(
        `/api/suggestions?trackId=${added[0]!.id}&limit=20&${suffix}`)).json()) as {
          candidates: Array<{ trackId: number; bpm: number; score: number;
            evidence: Array<{ signal: string; detail: string }> }> };
      const tempo = await query("priority=tempo");
      const key = await query("priority=key");
      expect(tempo.candidates[0]!.trackId).toBe(added[1]!.id);
      expect(key.candidates[0]!.trackId).toBe(added[2]!.id);
      expect((await query("priority=key")).candidates.map((item) => item.trackId))
        .toEqual(key.candidates.map((item) => item.trackId));

      const ordinary = await query("priority=balanced&allowHalfDouble=0");
      const enabled = await query("priority=balanced&allowHalfDouble=1");
      const before = ordinary.candidates.find((item) => item.trackId === added[3]!.id)!;
      const after = enabled.candidates.find((item) => item.trackId === added[3]!.id)!;
      expect(after.bpm).toBe(140);
      expect(after.score).toBeGreaterThan(before.score);
      expect(after.evidence).toEqual(expect.arrayContaining([expect.objectContaining({
        signal: "tempo", detail: expect.stringMatching(/half-tempo counting \(140 → 70\)/),
      })]));
    } finally {
      db.query("DELETE FROM tracks WHERE content_hash LIKE 'rank-%'").run();
      record.run("rekordbox", latest.observed_at + 2, payload.tracks.length - added.length,
        0, "ranking-restore", latest.payload);
    }
  });

  test("AI receives only grounded candidates from the requested local playlist scope", async () => {
    const current = await (await json("/api/prep/draft")).json() as Draft;
    expect((await json("/api/prep/draft", "PUT", { ...current,
      trackIds: [tracks[0]!.id], seedTrackId: tracks[0]!.id, transitions: {} })).status).toBe(200);

    const originalFetch = globalThis.fetch;
    const originalKey = process.env.OPENROUTER_API_KEY;
    let suppliedCandidates: unknown[] = [];
    process.env.OPENROUTER_API_KEY = "test-only-key";
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const requestBody = JSON.parse(String(init?.body)) as {
        messages: { role: string; content: string }[];
      };
      const userMessage = requestBody.messages.find((message) => message.role === "user");
      const supplied = JSON.parse(userMessage?.content ?? "{}") as { candidates?: unknown[] };
      suppliedCandidates = supplied.candidates ?? [];
      return Response.json({ choices: [{ message: { content: JSON.stringify({
        summary: "Grounded playlist option.",
        suggestions: [{ candidateId: String(tracks[1]!.id), reason: "Tempo and key evidence." }],
      }) } }] });
    }) as typeof fetch;
    try {
      const response = await json("/api/suggestions/ai", "POST", {
        trackId: tracks[0]!.id,
        localPlaylistId: playlistId,
        intent: "Keep the flow smooth",
      });
      expect(response.status).toBe(200);
      expect((await response.json() as { suggestions: { candidateId: string; reason: string }[] }).suggestions)
        .toEqual([{ candidateId: String(tracks[1]!.id), reason: "Tempo and key evidence." }]);
      expect(suppliedCandidates).toHaveLength(1);
      expect(suppliedCandidates[0]).toMatchObject({
        id: String(tracks[1]!.id),
        evidence: expect.arrayContaining([
          expect.stringMatching(/measured: .*BPM difference/),
          expect.stringMatching(/observed: Rekordbox keys/),
        ]),
      });
      expect(JSON.stringify(suppliedCandidates)).not.toContain(String(tracks[4]!.id));
    } finally {
      globalThis.fetch = originalFetch;
      if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = originalKey;
    }
  });

  test("reports a draft track that becomes unavailable as an actionable file gap", async () => {
    const current = await (await json("/api/prep/draft")).json() as Draft;
    expect((await json("/api/prep/draft", "PUT", { ...current,
      trackIds: [tracks[1]!.id], seedTrackId: tracks[1]!.id, transitions: {} })).status).toBe(200);
    db.query("UPDATE tracks SET missing=1 WHERE id=?").run(tracks[1]!.id);
    try {
      const response = await request("/api/prep/gaps");
      expect(response.status).toBe(200);
      const payload = await response.json() as { gaps: Array<{
        id: string; kind: string; trackId: number; missing: string[]; action: string;
      }> };
      expect(payload.gaps).toEqual([expect.objectContaining({
        id: `file-${tracks[1]!.id}`,
        kind: "file",
        trackId: tracks[1]!.id,
        missing: ["available audio file"],
        action: expect.stringMatching(/Restore or remove/),
      })]);
    } finally {
      db.query("UPDATE tracks SET missing=0 WHERE id=?").run(tracks[1]!.id);
    }
  });

  test("invalidates the observation cache when a newer row shares the same timestamp", async () => {
    const before = await (await request("/api/suggestions/model")).json() as {
      coverage: { totalCues: number; cueTracks: number };
    };
    const latest = db.query<{ observed_at: number; payload: string }, []>(
      "SELECT observed_at,payload FROM observations WHERE store='rekordbox' ORDER BY observed_at DESC,id DESC LIMIT 1",
    ).get()!;
    const next = JSON.parse(latest.payload) as {
      tracks: Array<{ sourceId: string; cues: unknown[] }>;
      [key: string]: unknown;
    };
    const outside = next.tracks.find((track) => track.sourceId === "rb-4")!;
    outside.cues = [{ id: "new-same-second-cue", time: 22, endTime: null,
      kind: "hot", index: 1, rawKind: 1, label: "Hot cue A", comment: null }];
    db.query(
      "INSERT INTO observations(store,observed_at,tracks,playlists,digest,payload) VALUES(?,?,?,?,?,?)",
    ).run("rekordbox", latest.observed_at, next.tracks.length, 0,
      "same-second-newer-observation", JSON.stringify(next));

    const after = await (await request("/api/suggestions/model")).json() as {
      coverage: { totalCues: number; cueTracks: number };
    };
    expect(after.coverage.totalCues).toBe(before.coverage.totalCues + 1);
    expect(after.coverage.cueTracks).toBe(before.coverage.cueTracks + 1);
  });

  test("keeps the last rich full-library snapshot after more than twenty failed refreshes", async () => {
    const latest = db.query<{ observed_at: number }, []>(
      "SELECT observed_at FROM observations WHERE store='rekordbox' ORDER BY observed_at DESC,id DESC LIMIT 1",
    ).get()!;
    const insert = db.query(
      "INSERT INTO observations(store,observed_at,tracks,playlists,digest,payload) VALUES(?,?,?,?,?,?)",
    );
    for (let index = 1; index <= 25; index++) {
      const observedAt = latest.observed_at + index;
      insert.run("rekordbox", observedAt, 0, 0, `failed-refresh-${index}`, JSON.stringify({
        store: "rekordbox", observedAt, available: false, reason: "Rekordbox is running",
        groups: {}, paths: [], dangling: [],
      }));
    }

    const response = await request("/api/suggestions/model");
    expect(response.status).toBe(200);
    const payload = await response.json() as {
      reason: string | null; tracks: { trackId: number }[];
      coverage: { localTracks: number; matchedTracks: number; totalCues: number };
    };
    expect(payload.reason).toContain("Using cached Rekordbox metadata");
    expect(payload.tracks.map((track) => track.trackId)).toContain(tracks[4]!.id);
    expect(payload.coverage).toMatchObject({ localTracks: 4, matchedTracks: 4, totalCues: 2 });
  });
});
