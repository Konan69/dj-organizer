/**
 * MP4/M4A atom parsing — no external deps.
 * yt-dlp writes the source URL into the `©cmt` atom, which gives us an exact
 * YouTube video id per file. That's what makes the upstream diff exact
 * rather than fuzzy title matching.
 */
import { spawnSync } from "node:child_process";

export type Meta = {
  title: string | null;
  artist: string | null;
  album: string | null;
  genre: string | null;
  duration: number | null;
  bitrate: number | null;
  videoId: string | null;
};

const EMPTY = (): Meta => ({
  title: null, artist: null, album: null, genre: null,
  duration: null, bitrate: null, videoId: null,
});

const YT = /(?:youtube\.com\/watch\?v=|youtu\.be\/)([A-Za-z0-9_-]{11})/;

type Atom = { type: string; body: number; end: number };

function* atoms(buf: Buffer, start: number, end: number): Generator<Atom> {
  let i = start;
  while (i + 8 <= end) {
    let size = buf.readUInt32BE(i);
    const type = buf.toString("latin1", i + 4, i + 8);
    let body = i + 8;
    if (size === 1) {
      if (i + 16 > end) return;
      size = Number(buf.readBigUInt64BE(i + 8));
      body = i + 16;
    } else if (size === 0) {
      size = end - i;
    }
    if (size < 8) return;
    yield { type, body, end: Math.min(i + size, end) };
    i += size;
  }
}

/** Walk a path of atom types. `meta` carries 4 bytes of version/flags first. */
function find(buf: Buffer, start: number, end: number, path: string[]) {
  let cur: [number, number] = [start, end];
  for (const want of path) {
    let hit: [number, number] | null = null;
    for (const a of atoms(buf, cur[0], cur[1])) {
      if (a.type === want) { hit = [a.body, a.end]; break; }
    }
    if (!hit) return null;
    cur = want === "meta" ? [hit[0] + 4, hit[1]] : hit;
  }
  return cur;
}

function ilstValue(buf: Buffer, start: number, end: number): string | null {
  for (const a of atoms(buf, start, end)) {
    if (a.type === "data") {
      // 4 bytes type indicator + 4 bytes locale, then the payload.
      // Clamp to the atom's own end: a malformed length must not let us read
      // into the next atom (or, worse, past the buffer).
      const from = Math.min(a.body + 8, end);
      const to = Math.min(a.end, end);
      if (to <= from) return null;
      return buf.toString("utf8", from, to).replace(/\0/g, "").trim() || null;
    }
  }
  return null;
}

/**
 * `©cmt` is where yt-dlp writes the source URL, and it is the ONLY field we
 * trust for the video id. `desc` holds the uploader's description, which
 * routinely links other people's videos — reading an id out of it attributes
 * the wrong source to the file and makes distinct songs look like duplicates.
 */
const TAGS: Record<string, keyof Meta | "comment"> = {
  "\u00a9nam": "title", "\u00a9ART": "artist", "\u00a9alb": "album",
  "\u00a9gen": "genre", "\u00a9cmt": "comment",
};

/** Parse the first ~1.5 MB, which is where moov/udta/ilst lives. */
export function parseM4aBuffer(head: Buffer, size: number): Meta {
  const out = EMPTY();
  const moov = find(head, 0, head.length, ["moov"]);
  if (!moov) return out;

  const mvhd = find(head, moov[0], moov[1], ["mvhd"]);
  if (mvhd) {
    const b = head.subarray(mvhd[0], mvhd[1]);
    try {
      let ts = 0, dur = 0;
      if (b[0] === 0 && b.length >= 20) {
        ts = b.readUInt32BE(12); dur = b.readUInt32BE(16);
      } else if (b.length >= 32) {
        ts = b.readUInt32BE(20); dur = Number(b.readBigUInt64BE(24));
      }
      if (ts) out.duration = Math.round((dur / ts) * 100) / 100;
    } catch { /* malformed header — leave duration null */ }
  }

  const ilst = find(head, moov[0], moov[1], ["udta", "meta", "ilst"]);
  let comment = "";
  if (ilst) {
    for (const a of atoms(head, ilst[0], ilst[1])) {
      const key = TAGS[a.type];
      if (!key) continue;
      const val = ilstValue(head, a.body, a.end);
      if (!val) continue;
      if (key === "comment") comment = val;
      else (out as Record<string, unknown>)[key] = val;
    }
  }
  const m = YT.exec(comment);
  if (m) out.videoId = m[1]!;
  if (out.duration && size) out.bitrate = Math.round((size * 8) / out.duration / 1000);
  return out;
}

let ffprobe: string | null | undefined;
function findFfprobe() {
  if (ffprobe !== undefined) return ffprobe;
  const r = spawnSync("which", ["ffprobe"], { encoding: "utf8" });
  ffprobe = r.status === 0 ? r.stdout.trim() : null;
  return ffprobe;
}

export function readTaggedAudio(path: string, size: number): Meta {
  const out = EMPTY();
  const bin = findFfprobe();
  if (!bin) return out;
  const r = spawnSync(bin, [
    "-v", "quiet", "-show_entries",
    "format=duration:format_tags=title,artist,comment,PURL",
    "-of", "default=nw=1", path,
  ], { encoding: "utf8", timeout: 25_000 });
  for (const line of (r.stdout || "").split("\n")) {
    const [rawK, ...rest] = line.split("=");
    const v = rest.join("=").trim();
    if (!v || !rawK) continue;
    const k = rawK.toLowerCase();
    if (k === "duration") out.duration = Math.round(parseFloat(v) * 100) / 100;
    else if (k.endsWith("title")) out.title = v;
    else if (k.endsWith("artist")) out.artist = v;
    else if (k.endsWith("comment") || k.endsWith("purl")) {
      const m = YT.exec(v);
      if (m) out.videoId = m[1]!;
    }
  }
  if (out.duration && size) out.bitrate = Math.round((size * 8) / out.duration / 1000);
  return out;
}

export async function read(path: string, size: number): Promise<Meta> {
  if (/\.(webm|flac)$/i.test(path)) return readTaggedAudio(path, size);
  const want = Math.min(size, 1_500_000);
  const ab = await Bun.file(path).slice(0, want).arrayBuffer();
  // Copy, don't view: Buffer.from(ArrayBuffer) aliases the underlying memory,
  // and a pooled/over-long allocation let the atom walk read another file's
  // bytes — which silently attached the wrong video id to ~12 tracks.
  const buf = Buffer.alloc(Math.min(want, ab.byteLength));
  buf.set(new Uint8Array(ab, 0, buf.length));
  return parseM4aBuffer(buf, size);
}

const NOISE =
  /\s*[([]\s*(official\s*(music\s*)?(video|audio|visualizer)|lyrics?(\s*video)?|4k|hd|hq|free\s*download|out\s*now|extended\s*mix|radio\s*edit)\s*[)\]]/gi;

export function fromFilename(filename: string): { artist: string | null; title: string } {
  let stem = filename.replace(/\.[^.]+$/, "").replace(/\s*\[[A-Za-z0-9_-]{11}\]$/, "");
  stem = stem.replace(NOISE, "").replace(/^[\s\-–—]+|[\s\-–—]+$/g, "");
  const i = stem.indexOf(" - ");
  if (i > 0) {
    const a = stem.slice(0, i).trim();
    const t = stem.slice(i + 3).trim();
    if (a.length <= 45 && t) return { artist: a, title: t };
  }
  return { artist: null, title: stem };
}

/** Normalized key for fuzzy upstream matching when a video id is absent. */
export function norm(s: string | null | undefined): string {
  return (s ?? "")
    .toLowerCase()
    .replace(NOISE, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
