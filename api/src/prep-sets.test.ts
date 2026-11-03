import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const testData = mkdtempSync(join(tmpdir(), "dj-organizer-sets-"));
const testAudio = mkdtempSync(join(process.env.DJ_TEST_WIN_DIR || "/mnt/c/Users/Public", ".dj-organizer-sets-"));
const isolated = process.env.DJ_ORGANIZER_NAMED_SET_CHILD === "1";
let db!: typeof import("./db")["db"];
let app!: typeof import("./index")["app"];
let trackId = 0;
if (isolated) {
  process.env.NODE_ENV = "test";
  process.env.DJ_ORGANIZER_TEST_DATA = testData;
  const database = await import("./db");
  db = database.db;
  const path = join(testAudio, "set-track.m4a");
  writeFileSync(path, "test audio");
  trackId = db.query<{ id: number }, [string, string, string]>(
    "INSERT INTO tracks(path,filename,title) VALUES(?,?,?) RETURNING id",
  ).get(path, "set-track.m4a", "Set Track")!.id;
  database.setMeta("prep_draft_v1", JSON.stringify({ revision: 7, trackIds: [trackId],
    notes: "legacy content", seedTrackId: trackId,
    transitions: {}, trackNotes: { [trackId]: "legacy track note" } }));
  app = (await import("./index")).app;
}

const request = (route: string, method = "GET", body?: unknown) => app.handle(new Request(
  `http://localhost${route}`, { method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body) }));

afterAll(() => {
  if (isolated) db.close();
  rmSync(testData, { recursive: true, force: true });
  rmSync(testAudio, { recursive: true, force: true });
});

if (isolated) describe("named preparation sets", () => {
  let firstId = "";
  let copyId = "";

  test("migrates the existing draft exactly once without resetting its revision", async () => {
    const draft = await (await request("/api/prep/draft")).json();
    firstId = draft.setId;
    expect(draft.name).toBe("My first set");
    expect(draft.revision).toBe(7);
    expect(draft.trackIds).toEqual([trackId]);
    expect(draft.notes).toBe("legacy content");
    expect(draft.trackNotes[String(trackId)]).toBe("legacy track note");
    const list = await (await request("/api/prep/sets")).json();
    expect(list.activeSetId).toBe(firstId);
    expect(list.sets).toHaveLength(1);
  });

  test("duplicates, independently edits, and reopens versions", async () => {
    const createdResponse = await request("/api/prep/sets", "POST",
      { name: "Club version", fromCurrent: true, revision: 7 });
    expect(createdResponse.status).toBe(200);
    const created = await createdResponse.json();
    copyId = created.activeSetId;
    expect(created.draft.revision).toBe(0);
    expect(created.draft.trackIds).toEqual([trackId]);
    expect(created.draft.trackNotes[String(trackId)]).toBe("legacy track note");

    const saved = await (await request("/api/prep/draft", "PUT", {
      ...created.draft, trackIds: [trackId, trackId], notes: "club edit",
      transitions: { [`${trackId}:${trackId}`]: { notes: "loop it", practiced: true,
        rehearsal: "works", mixOut: { time: 12.5, label: "Hot cue A", kind: "cue" },
        mixIn: { time: 20, label: "Verse 1", kind: "phrase" } } },
    })).json();
    expect(saved.revision).toBe(1);

    const reopenedFirst = await (await request(`/api/prep/sets/${firstId}/open`, "POST",
      { revision: 1 })).json();
    expect(reopenedFirst.draft.revision).toBe(7);
    expect(reopenedFirst.draft.notes).toBe("legacy content");
    const reopenedCopy = await (await request(`/api/prep/sets/${copyId}/open`, "POST",
      { revision: 7 })).json();
    expect(reopenedCopy.draft.notes).toBe("club edit");
    expect(reopenedCopy.draft.trackIds).toEqual([trackId, trackId]);
    expect(reopenedCopy.draft.transitions[`${trackId}:${trackId}`].mixOut.time).toBe(12.5);
  });

  test("rejects switching from a stale visible revision", async () => {
    const response = await request(`/api/prep/sets/${firstId}/open`, "POST", { revision: 0 });
    expect(response.status).toBe(409);
    expect((await response.json()).draft.setId).toBe(copyId);
  });

  test("explicit set ids prevent equal-revision tabs from writing into each other", async () => {
    const b = await (await request(`/api/prep/draft?setId=${copyId}`)).json();
    const peerCreated = await (await request("/api/prep/sets", "POST", {
      name: "Equal revision peer", fromCurrent: true, setId: copyId, revision: b.revision,
    })).json();
    const peerId = peerCreated.activeSetId as string;
    const peer = await (await request("/api/prep/draft", "PUT", {
      ...peerCreated.draft, notes: "peer tab content",
    })).json();
    expect(peer.revision).toBe(b.revision);

    const savedB = await (await request("/api/prep/draft", "PUT", {
      ...b, notes: "correct B content",
    })).json();
    expect(savedB.setId).toBe(copyId);
    expect(savedB.revision).toBe(b.revision + 1);
    expect((await (await request(`/api/prep/draft?setId=${peerId}`)).json()).notes)
      .toBe("peer tab content");
    const staleB = await request("/api/prep/draft", "PUT", { ...b, notes: "stale overwrite" });
    expect(staleB.status).toBe(409);
    expect((await staleB.json()).draft.notes).toBe("correct B content");

    await request(`/api/prep/sets/${copyId}/open`, "POST", { setId: peerId, revision: peer.revision });
    await request(`/api/prep/sets/${peerId}`, "DELETE");
  });

  test("renames without changing draft revision and uses the title in exports", async () => {
    const before = await (await request("/api/prep/draft")).json();
    const renamed = await (await request(`/api/prep/sets/${copyId}`, "PATCH",
      { name: "Festival / Final" })).json();
    expect(renamed.set.name).toBe("Festival / Final");
    const after = await (await request("/api/prep/draft")).json();
    expect(after.revision).toBe(before.revision);
    expect(after.name).toBe("Festival / Final");
    const sheet = await (await request("/api/prep/run-sheet")).text();
    expect(sheet).toContain("Festival / Final — practice sheet");
    expect(sheet).toContain("Mix out: Hot cue A at 12.5s (cue)");
    expect(sheet).toContain("Mix in: Verse 1 at 20.0s (phrase)");
    expect(sheet).toContain("Rehearsal: works");
    const exported = await request("/api/prep/export.m3u8");
    expect(exported.headers.get("content-disposition")).toContain('filename="Festival Final.m3u8"');
  });

  test("exports Unicode set names with an ASCII fallback and UTF-8 filename", async () => {
    const renamed = await request(`/api/prep/sets/${copyId}`, "PATCH", { name: "生日 🎧" });
    expect(renamed.status).toBe(200);
    const exported = await request(`/api/prep/export.m3u8?setId=${copyId}`);
    expect(exported.status).toBe(200);
    expect(exported.headers.get("content-disposition")).toBe(
      "attachment; filename=\"My DJ set.m3u8\"; filename*=UTF-8''%E7%94%9F%E6%97%A5%20%F0%9F%8E%A7.m3u8",
    );
  });

  test("deleting the active alternative safely returns to the original", async () => {
    const deleted = await (await request(`/api/prep/sets/${copyId}`, "DELETE")).json();
    expect(deleted.activeSetId).toBe(firstId);
    expect(deleted.draft.notes).toBe("legacy content");
    expect(deleted.sets).toHaveLength(1);
  });
});

if (!isolated) test("named preparation sets run in an isolated module process", async () => {
  const child = Bun.spawn(["bun", "test", import.meta.path], {
    cwd: import.meta.dir + "/../..",
    env: { ...process.env, DJ_ORGANIZER_NAMED_SET_CHILD: "1" },
    stdout: "pipe", stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
});
