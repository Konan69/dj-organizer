/**
 * The learning queue: videos to watch and work through.
 *
 * Deliberately not a playlist of tracks. A tutorial is worked through once and
 * then it is done; a filmed set is re-opened whenever a transition needs
 * farming. Both carry notes written while watching, and both remember where
 * you stopped — that is the whole difference from a list of links in a file.
 *
 * Details come from yt-dlp, the same binary the downloader already uses. There
 * is no second-guessing route: if yt-dlp cannot read the video, adding it fails
 * loudly rather than storing a row with a URL for a title.
 */
import { db, log, now } from "./db";
import { NODE, YT_DLP } from "./download";

export type LearnKind = "tutorial" | "set";
export type LearnStatus = "queued" | "watching" | "done" | "skipped";
export type Chapter = { start: number; title: string };

export type LearnVideo = {
  videoId: string; title: string; channel: string | null; duration: number | null;
  kind: LearnKind; topic: string | null; status: LearnStatus; notes: string;
  chapters: Chapter[]; position: number; sort: number;
  addedAt: number | null; watchedAt: number | null;
};

type Row = {
  video_id: string; title: string; channel: string | null; duration: number | null;
  kind: LearnKind; topic: string | null; status: LearnStatus; notes: string;
  chapters: string | null; position: number; sort: number;
  added_at: number | null; watched_at: number | null;
};

const shape = (r: Row): LearnVideo => ({
  videoId: r.video_id, title: r.title, channel: r.channel, duration: r.duration,
  kind: r.kind, topic: r.topic, status: r.status, notes: r.notes,
  chapters: r.chapters ? (JSON.parse(r.chapters) as Chapter[]) : [],
  position: r.position, sort: r.sort, addedAt: r.added_at, watchedAt: r.watched_at,
});

/**
 * Every shape YouTube hands out, plus a bare id pasted on its own. Anything
 * else is rejected rather than guessed at — a wrong id caches a wrong video.
 */
export function videoIdOf(input: string): string {
  const raw = input.trim();
  if (/^[\w-]{11}$/.test(raw)) return raw;
  let url: URL;
  try { url = new URL(raw.startsWith("http") ? raw : `https://${raw}`); }
  catch { throw new Error(`Not a YouTube link: ${raw.slice(0, 80)}`); }

  const host = url.hostname.replace(/^www\./, "");
  const id = host === "youtu.be"
    ? url.pathname.slice(1)
    : url.searchParams.get("v")
      ?? url.pathname.match(/^\/(?:shorts|embed|live|v)\/([\w-]{11})/)?.[1]
      ?? "";
  if (!/^[\w-]{11}$/.test(id)) throw new Error(`No video id in ${raw.slice(0, 80)}`);
  return id;
}

type Probe = {
  title?: string; channel?: string; uploader?: string; duration?: number;
  chapters?: { start_time?: number; title?: string }[] | null;
};

/** Title, channel, length and chapters straight from yt-dlp. */
export async function probe(videoId: string) {
  const proc = Bun.spawn([
    YT_DLP, "--no-warnings", "--skip-download", "--no-playlist",
    "--js-runtimes", `node:${NODE}`, "--dump-single-json",
    `https://www.youtube.com/watch?v=${videoId}`,
  ], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(stderr.trim().split("\n").at(-1) || `yt-dlp exited ${code}`);

  const line = stdout.split("\n").findLast((s) => s.trim().startsWith("{"));
  if (!line) throw new Error(`yt-dlp returned no details for ${videoId}`);
  const info = JSON.parse(line) as Probe;
  return {
    title: info.title ?? videoId,
    channel: info.channel ?? info.uploader ?? null,
    duration: typeof info.duration === "number" ? Math.round(info.duration) : null,
    chapters: (info.chapters ?? [])
      .map((c) => ({ start: Math.round(c.start_time ?? 0), title: c.title ?? "" }))
      .filter((c) => c.title),
  };
}

export function list(): LearnVideo[] {
  return db.query<Row, []>(
    `SELECT * FROM learn_videos
     ORDER BY CASE status WHEN 'watching' THEN 0 WHEN 'queued' THEN 1
                          WHEN 'done' THEN 2 ELSE 3 END,
              sort, added_at`).all().map(shape);
}

export function get(videoId: string): LearnVideo | null {
  const row = db.query<Row, [string]>("SELECT * FROM learn_videos WHERE video_id=?").get(videoId);
  return row ? shape(row) : null;
}

/**
 * Counts for the sidebar. `open` is what is actually owed — skipped videos were
 * a decision, not a backlog, so they never nag.
 */
export function counts() {
  const rows = db.query<{ status: LearnStatus; kind: LearnKind; n: number }, []>(
    "SELECT status, kind, COUNT(*) n FROM learn_videos GROUP BY status, kind").all();
  const at = (status: LearnStatus, kind?: LearnKind) => rows
    .filter((r) => r.status === status && (!kind || r.kind === kind))
    .reduce((sum, r) => sum + r.n, 0);
  return {
    total: rows.reduce((sum, r) => sum + r.n, 0),
    open: at("queued") + at("watching"),
    watching: at("watching"), queued: at("queued"),
    done: at("done"), skipped: at("skipped"),
    tutorials: { done: at("done", "tutorial"), open: at("queued", "tutorial") + at("watching", "tutorial") },
    sets: { done: at("done", "set"), open: at("queued", "set") + at("watching", "set") },
  };
}

export async function add(input: { url: string; kind?: LearnKind; topic?: string | null }) {
  const videoId = videoIdOf(input.url);
  const existing = get(videoId);
  if (existing) return { video: existing, alreadyHad: true as const };

  const details = await probe(videoId);
  const maxSort = db.query<{ s: number | null }, []>(
    "SELECT MAX(sort) s FROM learn_videos").get()?.s ?? 0;
  db.query(
    `INSERT INTO learn_videos(video_id,title,channel,duration,kind,topic,chapters,sort,added_at)
     VALUES(?,?,?,?,?,?,?,?,?)`,
  ).run(videoId, details.title, details.channel, details.duration,
    input.kind ?? "tutorial", input.topic ?? null,
    JSON.stringify(details.chapters), maxSort + 1, now());
  log("learn.add", { videoId, title: details.title });
  return { video: get(videoId)!, alreadyHad: false as const };
}

const FIELDS = {
  title: "title", kind: "kind", topic: "topic", status: "status",
  notes: "notes", position: "position", sort: "sort",
} as const;

export function update(videoId: string, patch: Partial<Record<keyof typeof FIELDS, unknown>>) {
  if (!get(videoId)) throw new Error(`Not in the watchlist: ${videoId}`);
  const sets: string[] = [], values: unknown[] = [];
  for (const key of Object.keys(FIELDS) as (keyof typeof FIELDS)[]) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
    sets.push(`${FIELDS[key]}=?`);
    values.push(patch[key]);
  }
  // Finishing stamps the date once. Re-opening a finished video clears it, so
  // "when did I watch this" never answers with the time it was last reopened.
  if (patch.status === "done") { sets.push("watched_at=?"); values.push(now()); }
  else if (patch.status !== undefined) { sets.push("watched_at=NULL"); }
  if (!sets.length) return get(videoId)!;

  db.query(`UPDATE learn_videos SET ${sets.join(",")} WHERE video_id=?`).run(...values as never[], videoId);
  return get(videoId)!;
}

export async function refresh(videoId: string) {
  if (!get(videoId)) throw new Error(`Not in the watchlist: ${videoId}`);
  const details = await probe(videoId);
  db.query(
    "UPDATE learn_videos SET title=?,channel=?,duration=?,chapters=? WHERE video_id=?",
  ).run(details.title, details.channel, details.duration,
    JSON.stringify(details.chapters), videoId);
  return get(videoId)!;
}

export function remove(videoId: string) {
  const video = get(videoId);
  if (!video) throw new Error(`Not in the watchlist: ${videoId}`);
  db.query("DELETE FROM learn_videos WHERE video_id=?").run(videoId);
  log("learn.remove", { videoId, title: video.title });
  return { removed: videoId };
}
