import { existsSync, mkdirSync } from "node:fs";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { db, markDirty, now } from "./db";
import { scan } from "./library";
import * as ops from "./ops";
import { DATA, existingDirectoryCase, LIB, pathKey } from "./paths";
import * as ytm from "./ytm";

export const YT_DLP = process.env.DJ_YTDLP?.trim() || "yt-dlp";
const DELAY_MS = 1_000;
const MAX_JOBS = 50;

type DownloadInput = {
  ytmId?: string;
  videoIds?: string[];
  folder: string;
};

type Skipped = { videoId: string; title: string | null; reason: string };
type Failed = { videoId: string; error: string };
type DownloadedFile = { videoId: string; path: string; title: string };

export type DownloadJob = {
  jobId: string;
  folder: string;
  state: "running" | "done" | "error";
  total: number;
  completed: number;
  skipped: Skipped[];
  failed: Failed[];
  files: DownloadedFile[];
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
};

export type DownloadComplete = (job: DownloadJob) => void | Promise<void>;

type SourceTrack = { videoId: string; title: string | null };
type Probe = { id: string; title: string; filename: string };
type Result = { id: string; title: string; filepath: string };

const jobs = new Map<string, DownloadJob>();
let queue = Promise.resolve();

function destination(folder: string) {
  const name = folder.trim();
  if (!name) throw new Error("folder required");
  if (name.split(/[\\/]/).some((part) => part === "." || part === "..")) {
    throw new Error("folder must not contain . or .. path segments");
  }
  const path = resolve(LIB, name);
  const rel = relative(LIB, path);
  if (!rel || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
    throw new Error("folder must be inside the tracks directory");
  }
  return { folder: name, path: existingDirectoryCase(LIB, path) };
}

function snapshot(job: DownloadJob): DownloadJob {
  return {
    ...job,
    skipped: [...job.skipped],
    failed: [...job.failed],
    files: [...job.files],
  };
}

async function command(args: string[]) {
  const proc = Bun.spawn([YT_DLP, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(stderr.trim() || stdout.trim() || `yt-dlp exited ${code}`);
  return stdout.trim();
}

function jsonLine<T>(output: string): T {
  const line = output.split("\n").findLast((s) => s.trim().startsWith("{"));
  if (!line) throw new Error(`yt-dlp returned no file details${output ? `: ${output}` : ""}`);
  return JSON.parse(line) as T;
}

// `bestaudio` is opus on YouTube, and remuxing that to m4a re-encodes one lossy
// codec into another at the same bitrate — ask for the native AAC stream first.
// Both name parts are truncated because `artist` lists every credited composer
// on some tracks, which overran the filesystem's name limit outright.
// YouTube now gates some formats behind a JS challenge. yt-dlp only enables
// deno by default, which isn't installed, so those downloads fail outright with
// "No supported JavaScript runtime could be found". node solves the same
// challenge. Set DJ_NODE when another `node` shim shadows the real one on PATH.
export const NODE = process.env.DJ_NODE?.trim() || "node";

// A signed-in Premium session unlocks format 141 (256k AAC); without it YouTube
// serves 140 (128k). Export the jar from your own signed-in browser; a missing
// jar is a setup fault, so fail rather than quietly download at 128k.
// The PO token comes from the bgutil server on :4416 via the yt-dlp plugin.
export const COOKIES = resolve(process.env.DJ_YTM_COOKIES?.trim() || resolve(DATA, "cookies/ytm-premium.txt"));

function cookieArgs() {
  if (!existsSync(COOKIES)) throw new Error(`YouTube Premium cookies missing: ${COOKIES}`);
  return ["--cookies", COOKIES, "--extractor-args", "youtube:player_client=web_music"];
}

const outputArgs = (dir: string) => [
  "--no-playlist",
  "--js-runtimes", `node:${NODE}`,
  ...cookieArgs(),
  // 141 is Premium-only; plain uploads (not on YouTube Music) only have 140.
  "--format", "141/bestaudio[ext=m4a]/bestaudio",
  "--output", `${dir}/%(artist,uploader).60s - %(title).80s.%(ext)s`,
];

async function probe(videoId: string, dir: string) {
  const output = await command([
    ...outputArgs(dir),
    "--skip-download",
    "--extract-audio", "--audio-format", "m4a",
    "--print", "%(.{id,title,filename})j",
    `https://www.youtube.com/watch?v=${videoId}`,
  ]);
  const info = jsonLine<Probe>(output);
  const ext = extname(info.filename);
  return { ...info, target: ext ? info.filename.slice(0, -ext.length) + ".m4a" : `${info.filename}.m4a` };
}

async function downloadOne(videoId: string, dir: string) {
  const info = await probe(videoId, dir);
  if (existsSync(info.target)) {
    return { skipped: { videoId, title: info.title, reason: "target exists" } } as const;
  }

  const output = await command([
    ...outputArgs(dir),
    "--no-overwrites",
    "--extract-audio", "--audio-format", "m4a", "--audio-quality", "0",
    "--embed-metadata",
    // Artist stays whatever the track metadata says. Mapping uploader onto it
    // writes the channel name, and YouTube Music's auto-channels are called
    // “<Artist> - Topic”, which the rest of the library would then match against.
    // yt-dlp otherwise writes the URL as PURL; tags.ts deliberately trusts ©cmt only.
    "--parse-metadata", "webpage_url:%(meta_comment)s",
    "--print", "after_move:%(.{id,title,filepath})j",
    `https://www.youtube.com/watch?v=${videoId}`,
  ]);
  const result = jsonLine<Result>(output);
  const rel = relative(dir, result.filepath);
  if (!rel || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
    throw new Error(`yt-dlp produced a path outside the destination: ${result.filepath}`);
  }
  if (!existsSync(result.filepath)) throw new Error(`yt-dlp reported a missing file: ${result.filepath}`);
  return { file: { videoId, path: result.filepath, title: result.title } } as const;
}

async function source(input: DownloadInput): Promise<SourceTrack[]> {
  if (input.videoIds) return input.videoIds.map((videoId) => ({ videoId, title: null }));

  const playlist = db.query<{ fetched_at: number }, [string]>(
    "SELECT fetched_at FROM ytm_playlists WHERE ytm_id=?").get(input.ytmId!);
  if (!playlist) throw new Error(`unknown upstream playlist ${input.ytmId}`);
  if (!playlist.fetched_at) {
    const refreshed = await ytm.refresh([input.ytmId!]);
    const failure = refreshed.errors.find((e) => e.playlist === input.ytmId);
    if (failure) throw new Error(failure.error);
  }
  return db.query<{ videoId: string; title: string | null }, [string]>(
    `SELECT video_id AS videoId,title FROM ytm_tracks WHERE ytm_id=? ORDER BY sort`,
  ).all(input.ytmId!);
}

type IndexedTrack = { id: number; path: string; content_hash: string | null };

function indexedTracks() {
  const indexed = new Map<string, IndexedTrack>();
  for (const row of db.query<IndexedTrack, []>(
    `SELECT id,path,content_hash FROM tracks WHERE missing=0
     ORDER BY content_hash IS NULL,id`,
  ).all()) {
    const key = pathKey(row.path);
    if (!indexed.has(key)) indexed.set(key, row);
  }
  return indexed;
}

function recordDownloads(job: DownloadJob) {
  const indexed = indexedTracks();
  for (const file of job.files) {
    const row = indexed.get(pathKey(file.path));
    if (!row?.content_hash) throw new Error(`download was not indexed: ${file.path}`);
    // The scanner walked the filesystem, so its spelling is the real on-disk casing.
    file.path = row.path;
    ops.recordDownload({
      playlist: job.folder,
      path: row.path,
      title: file.title,
      videoId: file.videoId,
      trackHash: row.content_hash,
    });
  }
}

function addMemberships(job: DownloadJob) {
  const playlist = db.query<{ id: number }, [string]>(
    "SELECT id FROM playlists WHERE name=?").get(job.folder);
  if (!playlist) return;

  const max = db.query<{ sort: number }, [number]>(
    "SELECT COALESCE(MAX(sort),0) sort FROM memberships WHERE playlist_id=?",
  ).get(playlist.id)!.sort;
  const tracks = indexedTracks();
  const add = db.query(
    "INSERT OR IGNORE INTO memberships(playlist_id,track_id,sort) VALUES(?,?,?)");
  const added: number[] = [];
  db.transaction(() => {
    for (const file of job.files) {
      const row = tracks.get(pathKey(file.path));
      if (row && add.run(playlist.id, row.id, max + added.length + 1).changes) added.push(row.id);
    }
  })();
  if (added.length) {
    ops.recordMembership("add_to", job.folder, added);
    markDirty("changes");
  }
}

async function run(job: DownloadJob, input: DownloadInput, dir: string,
  onComplete?: DownloadComplete) {
  try {
    const tracks = await source(input);
    job.total = tracks.length;
    mkdirSync(dir, { recursive: true });
    const seen = new Set<string>();
    const local = db.query<{ title: string | null; filename: string }, [string]>(
      `SELECT title,filename FROM tracks WHERE video_id=?
       ORDER BY missing ASC,id ASC LIMIT 1`);
    let attempted = false;

    for (const track of tracks) {
      if (seen.has(track.videoId)) {
        job.skipped.push({ videoId: track.videoId, title: track.title, reason: "duplicate request" });
        job.completed++;
        continue;
      }
      seen.add(track.videoId);

      const existing = local.get(track.videoId);
      if (existing) {
        job.skipped.push({
          videoId: track.videoId,
          title: existing.title ?? existing.filename,
          reason: "already in library",
        });
        job.completed++;
        continue;
      }

      if (attempted) await Bun.sleep(DELAY_MS);
      attempted = true;
      try {
        const result = await downloadOne(track.videoId, dir);
        if (result.skipped) job.skipped.push(result.skipped);
        else job.files.push(result.file);
      } catch (error) {
        job.failed.push({
          videoId: track.videoId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      job.completed++;
    }

    if (job.files.length) {
      await scan(false);
      recordDownloads(job);
      addMemberships(job);
    }
    job.state = "done";
    if (onComplete) await onComplete(snapshot(job));
  } catch (error) {
    job.state = "error";
    job.error = error instanceof Error ? error.message : String(error);
  } finally {
    job.finishedAt = now();
  }
}

export function create(input: DownloadInput, onComplete?: DownloadComplete) {
  const hasYtm = input.ytmId !== undefined;
  const hasVideos = input.videoIds !== undefined;
  if (hasYtm === hasVideos) throw new Error("provide exactly one of ytmId or videoIds");
  if (input.ytmId !== undefined && !input.ytmId.trim()) throw new Error("ytmId required");
  if (input.videoIds !== undefined && !input.videoIds.length) throw new Error("videoIds required");
  const dest = destination(input.folder);

  const job: DownloadJob = {
    jobId: crypto.randomUUID(),
    folder: dest.folder,
    state: "running",
    total: input.videoIds?.length ?? 0,
    completed: 0,
    skipped: [],
    failed: [],
    files: [],
    startedAt: now(),
    finishedAt: null,
    error: null,
  };
  jobs.set(job.jobId, job);
  while (jobs.size > MAX_JOBS) jobs.delete(jobs.keys().next().value!);

  queue = queue.then(() => run(job, input, dest.path, onComplete));
  return { jobId: job.jobId };
}

export function get(jobId: string) {
  const job = jobs.get(jobId);
  return job ? snapshot(job) : null;
}

export function list() {
  return [...jobs.values()].reverse().map(snapshot);
}
