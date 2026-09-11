/**
 * Cover art.
 *
 * Not one file in this library carries an embedded picture — yt-dlp was asked
 * for audio only, so the `covr` atom is absent from all 726. What every file
 * does carry is its YouTube id in `©cmt`, and YouTube serves that video's
 * thumbnail from a stable url indefinitely. So the art is one fetch away.
 *
 * The cache lives under data/ with everything else this app writes. Nothing
 * here ever touches a music file: the art is shown, never embedded.
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA } from "./paths";

const DIR = join(DATA, "art");
mkdirSync(DIR, { recursive: true });

/** maxres is a clean 16:9 frame; hq and mq are 4:3 with letterbox bars baked in. */
const QUALITIES = ["maxresdefault", "hqdefault", "mqdefault"] as const;

const jpg = (id: string) => join(DIR, `${id}.jpg`);
const miss = (id: string) => join(DIR, `${id}.miss`);

const inflight = new Map<string, Promise<string | null>>();

async function download(id: string): Promise<string | null> {
  for (const q of QUALITIES) {
    try {
      const res = await fetch(`https://i.ytimg.com/vi/${id}/${q}.jpg`);
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      // A deleted or art-less video answers with a 120x90 grey placeholder.
      if (buf.length < 2000) continue;
      writeFileSync(jpg(id), buf);
      return jpg(id);
    } catch { /* try the next size */ }
  }
  writeFileSync(miss(id), "");
  return null;
}

/** Cached path, or null if we have not fetched it yet. */
export function cached(id: string): string | null {
  return existsSync(jpg(id)) ? jpg(id) : null;
}

/** Cached path, fetching once if needed. Concurrent callers share one fetch. */
export function get(id: string): Promise<string | null> {
  const hit = cached(id);
  if (hit) return Promise.resolve(hit);
  if (existsSync(miss(id))) return Promise.resolve(null);

  let p = inflight.get(id);
  if (!p) {
    p = download(id).finally(() => inflight.delete(id));
    inflight.set(id, p);
  }
  return p;
}

/** Pull a batch in the background so scrolling never waits on the network. */
export async function warm(ids: string[], concurrency = 8) {
  const todo = ids.filter((id) => !cached(id) && !existsSync(miss(id)));
  let i = 0, ok = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, todo.length) }, async () => {
      while (i < todo.length) {
        const id = todo[i++]!;
        if (await get(id)) ok++;
      }
    }),
  );
  return { requested: ids.length, fetched: ok, alreadyHad: ids.length - todo.length };
}

export function stats() {
  const files = readdirSync(DIR);
  return {
    have: files.filter((f) => f.endsWith(".jpg")).length,
    unavailable: files.filter((f) => f.endsWith(".miss")).length,
  };
}
