/**
 * Stable track identity.
 *
 * Paths are not identity: the same recording sits at several paths, gets
 * renamed, and moves between folders. Dates are not identity either — mtimes
 * change when a tool rewrites tags, and Serato rewrites crates on exit.
 *
 * So identity is resolved in this order:
 *   1. contentHash  — xxHash64 over the audio payload (tag edits don't move it)
 *   2. videoId      — the YouTube source, exact when present
 *   3. (duration rounded to 1s, normalized title) — last-resort fuzzy key
 *
 * The audio payload is hashed rather than the whole file so that rewriting
 * metadata (which yt-dlp, Serato and rekordbox all do) does not change a
 * track's identity.
 */
import { open } from "node:fs/promises";
import { norm } from "./tags";

const CHUNK = 1 << 20;

/**
 * Byte range of the `mdat` atom (the actual audio) in an MP4/M4A.
 * Returns null for non-MP4 containers, where we fall back to the whole file.
 */
async function mdatRange(path: string, size: number): Promise<[number, number] | null> {
  const fh = await open(path, "r");
  try {
    const head = Buffer.alloc(Math.min(size, 64 * 1024));
    await fh.read(head, 0, head.length, 0);
    if (head.toString("latin1", 4, 8) !== "ftyp") return null;

    let off = 0;
    // Top-level atoms only; mdat is always one of them.
    while (off + 8 <= size) {
      const hdr = Buffer.alloc(16);
      const { bytesRead } = await fh.read(hdr, 0, 16, off);
      if (bytesRead < 8) return null;
      let len = hdr.readUInt32BE(0);
      const type = hdr.toString("latin1", 4, 8);
      let body = off + 8;
      if (len === 1) {
        if (bytesRead < 16) return null;
        len = Number(hdr.readBigUInt64BE(8));
        body = off + 16;
      } else if (len === 0) {
        len = size - off;
      }
      if (len < 8) return null;
      if (type === "mdat") return [body, Math.min(off + len, size)];
      off += len;
    }
    return null;
  } finally {
    await fh.close();
  }
}

/** xxHash64 of a byte range, streamed so a 3 GB library stays cheap. */
async function hashRange(path: string, start: number, end: number): Promise<string> {
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(CHUNK);
    let pos = start;
    let acc = 0n;
    while (pos < end) {
      const want = Math.min(CHUNK, end - pos);
      const { bytesRead } = await fh.read(buf, 0, want, pos);
      if (!bytesRead) break;
      // Fold each chunk's hash into a rolling accumulator.
      acc = Bun.hash.xxHash64(buf.subarray(0, bytesRead), acc);
      pos += bytesRead;
    }
    return acc.toString(16).padStart(16, "0");
  } finally {
    await fh.close();
  }
}

export async function contentHash(path: string, size: number): Promise<{
  hash: string; scope: "mdat" | "file"; bytes: number;
}> {
  const range = await mdatRange(path, size).catch(() => null);
  const [start, end] = range ?? [0, size];
  return {
    hash: await hashRange(path, start, end),
    scope: range ? "mdat" : "file",
    bytes: end - start,
  };
}

/** Fuzzy fallback key, used only when neither hash nor video id is available. */
export function fuzzyKey(title: string | null, duration: number | null) {
  return `${Math.round(duration ?? 0)}:${norm(title)}`;
}

/**
 * Identity keys for one track, most to least authoritative. Two records are the
 * same track if they agree on the first key both of them have.
 */
export function identityKeys(t: {
  content_hash?: string | null; video_id?: string | null;
  title?: string | null; duration?: number | null;
}): string[] {
  const keys: string[] = [];
  if (t.content_hash) keys.push(`h:${t.content_hash}`);
  if (t.video_id) keys.push(`v:${t.video_id}`);
  keys.push(`f:${fuzzyKey(t.title ?? null, t.duration ?? null)}`);
  return keys;
}
