import { statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { db } from "./db";
import { py } from "./py";
import { getNativeAnalysisTrack } from "./suggestions";
import { summarizeAnalysis, type RawAnalysis } from "./analysis-summary";

const SHARE = "/mnt/c/Users/you/AppData/Roaming/Pioneer/rekordbox/share";
const ROOT = join(SHARE, "PIONEER/USBANLZ");
const cache = new Map<string, { value: RawAnalysis; expires: number }>();
const pending = new Map<string, Promise<RawAnalysis>>();
let active = 0;
const waiting: Array<() => void> = [];

async function limited<T>(work: () => Promise<T>): Promise<T> {
  if (active >= 2) await new Promise<void>((resume) => waiting.push(resume));
  else active++;
  try { return await work(); }
  finally {
    const next = waiting.shift();
    if (next) next(); else active--;
  }
}

function missing(reason: string): RawAnalysis {
  return { status: "missing", source: "rekordbox", observedAt: null,
    beats: [], phrases: [], waveform: null, bands: null, issues: [reason] };
}

const validBands = (bands: RawAnalysis["bands"] | undefined) => bands === null || (!!bands &&
  Array.isArray(bands.low) && Array.isArray(bands.mid) && Array.isArray(bands.high) &&
  bands.low.length === bands.mid.length && bands.mid.length === bands.high.length &&
  (bands.rate === null || (Number.isFinite(bands.rate) && bands.rate > 0)));

function fileSignature(path: string): string {
  // Only database-sourced paths reach here, but confine stat reads too.
  const file = resolve(SHARE, path.replace(/^[/\\]+/, ""));
  if (!file.startsWith(ROOT + sep)) throw new Error("Invalid Rekordbox analysis location");
  return [".DAT", ".EXT", ".2EX"].map((suffix) => file.replace(/\.[^.]+$/, suffix)).map((file) => {
    try { const stat = statSync(file); return `${stat.size}:${stat.mtimeMs}`; }
    catch { return "missing"; }
  }).join("|");
}

async function readAnalysis(path: string): Promise<RawAnalysis> {
  let signature: string;
  try { signature = fileSignature(path); }
  catch { return missing("Rekordbox saved an invalid analysis location for this track."); }
  const key = `${path}|${signature}`;
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) return cached.value;
  let promise = pending.get(key);
  if (!promise) {
    promise = limited(async () => {
      const value = await py<RawAnalysis>("rekordbox_analysis.py", "read", { analysisDataPath: path }, 30_000);
      if (!Array.isArray(value.beats) || !Array.isArray(value.phrases) || !Array.isArray(value.issues) ||
          !validBands(value.bands)) {
        throw new Error("Rekordbox analysis reader returned an invalid result");
      }
      if (cache.size >= 96) cache.delete(cache.keys().next().value!);
      cache.set(key, { value, expires: Date.now() + (value.status === "missing" ? 30_000 : 300_000) });
      return value;
    }).finally(() => pending.delete(key));
    pending.set(key, promise);
  }
  return promise;
}

export async function getTrackAnalysis(trackId: number) {
  const row = db.query<{ duration: number | null }, [number]>("SELECT duration FROM tracks WHERE id=? AND missing=0").get(trackId);
  if (!row) return null;
  const { native, observedAt, reason } = await getNativeAnalysisTrack(trackId);
  let raw: RawAnalysis;
  if (!native) raw = missing(reason || "This track is not matched to the saved Rekordbox library.");
  else if (native.analysisDataPath === undefined) raw = missing("Refresh Rekordbox facts to load saved analysis locations and cues.");
  else if (!native.analysisDataPath) raw = missing("No analysis location is linked in the saved Rekordbox facts. Refresh facts first; if still missing, check this track in Rekordbox.");
  else raw = await readAnalysis(native.analysisDataPath);
  const result = summarizeAnalysis(raw, native?.cues ?? [], row.duration ?? native?.length ?? 0);
  return { ...result, trackId, observedAt: raw.observedAt ?? observedAt };
}
