/** Deterministic, read-only preparation signals. No metadata or playback writes. */
import { basename } from "node:path";
import { db } from "./db";
import { pathKey } from "./paths";
import {
  observeRekordbox, record, type Observation, type RekordboxTrack,
} from "./stores";

export type SuggestionEvidence = {
  kind: "measured" | "observed" | "unknown";
  signal: "tempo" | "key" | "playlist" | "analysis";
  detail: string;
};

export type SuggestionTrack = {
  trackId: number;
  sourceId: string | null;
  path: string;
  title: string;
  artist: string | null;
  bpm: number | null;
  key: string | null;
  comment: string | null;
  analysisAvailable: boolean | null;
  cueCount: number | null;
};

export type SuggestionPlaylist = {
  sourceId: string;
  name: string;
  parentSourceId: string | null;
  trackIds: number[];
};

export type SuggestionReadModel = {
  available: boolean;
  reason: string | null;
  observedAt: number | null;
  source: "rekordbox" | "cached-rekordbox" | "filesystem";
  tracks: SuggestionTrack[];
  playlists: SuggestionPlaylist[];
  coverage: {
    localTracks: number; matchedTracks: number; analysisLinkedTracks: number;
    cueTracks: number; totalCues: number; unmatchedTracks: number;
    nativeTracks: number; nativeAnalysisTracks: number;
  };
};

export type SuggestedCandidate = SuggestionTrack & {
  score: number;
  reasons: string[];
  evidence: SuggestionEvidence[];
};

export type SuggestNextRequest = {
  localPlaylistId?: number;
  trackId?: number;
  path?: string;
  playlistId?: string;
  limit?: number;
  excludeTrackIds?: number[];
  priority?: "balanced" | "tempo" | "key";
  allowHalfDouble?: boolean;
};

type LocalTrack = { id: number; path: string; title: string | null; artist: string | null };

const boundedLimit = (value: number | undefined, fallback: number, max: number) =>
  Number.isInteger(value) ? Math.max(1, Math.min(max, value!)) : fallback;

function locals(): LocalTrack[] {
  return db.query<LocalTrack, []>(
    `SELECT t.id,t.path,COALESCE(o.title,t.title) AS title,
            COALESCE(o.artist,t.artist) AS artist
     FROM tracks t LEFT JOIN track_overrides o ON o.track_hash=t.content_hash
     WHERE t.missing=0 AND NOT EXISTS(
       SELECT 1 FROM pending_deletes p WHERE p.track_id=t.id)
     ORDER BY t.id`,
  ).all();
}

function toTrack(local: LocalTrack, rb?: RekordboxTrack): SuggestionTrack {
  return {
    trackId: local.id,
    sourceId: rb?.sourceId ?? null,
    path: local.path,
    title: local.title ?? rb?.title ?? basename(local.path),
    artist: local.artist ?? rb?.artist ?? null,
    bpm: rb?.bpm ?? null,
    key: rb?.key ?? null,
    comment: rb?.comment ?? null,
    analysisAvailable: rb?.analysisDataPath === undefined ? null : Boolean(rb.analysisDataPath),
    cueCount: rb?.cues?.length ?? null,
  };
}

const nativeIndexes = new WeakMap<Observation, Map<string, RekordboxTrack>>();
function nativeByPath(observation: Observation | null) {
  if (!observation) return new Map<string, RekordboxTrack>();
  let index = nativeIndexes.get(observation);
  if (!index) {
    index = new Map((observation.tracks ?? []).map((track) => [pathKey(track.path), track]));
    nativeIndexes.set(observation, index);
  }
  return index;
}

function buildModel(observation: Observation | null, fresh: boolean): SuggestionReadModel {
  const local = locals();
  const rbByPath = nativeByPath(observation);
  const tracks = local.map((t) => toTrack(t, rbByPath.get(pathKey(t.path))));
  const idBySource = new Map(tracks.flatMap((t) => t.sourceId ? [[t.sourceId, t.trackId] as const] : []));
  const playlists = (observation?.playlists ?? []).map((p) => ({
    sourceId: p.sourceId, name: p.name, parentSourceId: p.parentSourceId,
    trackIds: p.members.flatMap((m) => {
      const id = idBySource.get(m.trackSourceId);
      return id === undefined ? [] : [id];
    }),
  }));
  const rich = Boolean(observation?.available && observation.tracks?.length);
  return {
    available: tracks.length > 0,
    reason: rich ? null : observation?.reason ?? "Rekordbox metadata unavailable; showing local preparation gaps",
    observedAt: observation?.observedAt ?? null,
    source: rich ? (fresh ? "rekordbox" : "cached-rekordbox") : "filesystem",
    tracks,
    playlists,
    coverage: {
      localTracks: tracks.length,
      matchedTracks: tracks.filter((track) => track.sourceId !== null).length,
      analysisLinkedTracks: tracks.filter((track) => track.analysisAvailable === true).length,
      cueTracks: tracks.filter((track) => (track.cueCount ?? 0) > 0).length,
      totalCues: tracks.reduce((sum, track) => sum + (track.cueCount ?? 0), 0),
      unmatchedTracks: tracks.filter((track) => track.sourceId === null).length,
      nativeTracks: observation?.tracks?.length ?? 0,
      nativeAnalysisTracks: observation?.tracks?.filter((track) => Boolean(track.analysisDataPath)).length ?? 0,
    },
  };
}

let snapshotCache: { key: string; observation: Observation | null; latestObservation: Observation | null } | null = null;
function cachedObservations() {
  // A waveform request must not reparse every full-library snapshot. IDs also
  // invalidate correctly when two observations share a timestamp.
  const latestId = db.query<{ id: number }, []>(
    "SELECT id FROM observations WHERE store='rekordbox' ORDER BY observed_at DESC,id DESC LIMIT 1",
  ).get()?.id;
  const key = String(latestId ?? "empty");
  if (snapshotCache?.key === key) return snapshotCache;
  const rows = db.query<{ id: number }, []>(
    "SELECT id FROM observations WHERE store='rekordbox' ORDER BY observed_at DESC,id DESC",
  ).all();
  let observation: Observation | null = null;
  let latestObservation: Observation | null = null;
  const payload = db.query<{ payload: string }, [number]>("SELECT payload FROM observations WHERE id=?");
  for (const [index, row] of rows.entries()) {
    try {
      const value = JSON.parse(payload.get(row.id)!.payload) as Observation;
      if (index === 0) latestObservation = value;
      if (value.available && value.tracks) { observation = value; break; }
    } catch { /* an invalid historical snapshot is skipped */ }
  }
  snapshotCache = { key, observation, latestObservation };
  return snapshotCache;
}

let analysisUpgradeAttempt = 0;
type ReadOptions = { refresh?: boolean; requireAnalysis?: boolean };
async function readSnapshot(options: ReadOptions) {
  let { observation, latestObservation } = cachedObservations();
  let fresh = false;
  // Old cached observations lack rich records. Refresh automatically on first use.
  const lacksAnalysis = options.requireAnalysis && observation?.tracks?.some((track) => track.analysisDataPath === undefined);
  const needsAnalysisUpgrade = lacksAnalysis && (refreshPromise !== null || Date.now() - analysisUpgradeAttempt > 60_000);
  if (options.refresh || !observation || needsAnalysisUpgrade) {
    if (needsAnalysisUpgrade) analysisUpgradeAttempt = Date.now();
    const attempted = await refreshObservation();
    latestObservation = attempted;
    if (attempted.available && attempted.tracks) {
      observation = attempted;
      fresh = true;
    } else if (!observation) {
      observation = attempted;
    }
  }
  return { observation, fresh, latestObservation };
}

export async function getSuggestionReadModel(options: ReadOptions = {}): Promise<SuggestionReadModel> {
  const { observation, fresh, latestObservation } = await readSnapshot(options);
  const model = buildModel(observation, fresh);
  if (!fresh && observation && latestObservation && latestObservation !== observation && !latestObservation.available) {
    model.reason = `Using cached Rekordbox metadata: ${latestObservation.reason ?? "latest refresh unavailable"}`;
  }
  return model;
}

/** Match the local row through the same read model; never guess from basename. */
export async function getNativeAnalysisTrack(trackId: number) {
  const { observation } = await readSnapshot({ requireAnalysis: true });
  const local = db.query<LocalTrack, [number]>(
    `SELECT id,path,title,artist FROM tracks WHERE id=? AND missing=0
     AND NOT EXISTS (SELECT 1 FROM pending_deletes p WHERE p.track_id=tracks.id)`,
  ).get(trackId);
  const native = local ? nativeByPath(observation).get(pathKey(local.path)) : undefined;
  return { track: local ? toTrack(local, native) : undefined, native,
    observedAt: observation?.observedAt ?? null, reason: observation?.reason ?? null };
}

let refreshPromise: Promise<Observation> | null = null;
function refreshObservation(): Promise<Observation> {
  if (!refreshPromise) refreshPromise = observeRekordbox().then((observation) => {
    record(observation);
    return observation;
  }).finally(() => { refreshPromise = null; });
  return refreshPromise;
}

const CAMELOT: Record<string, string> = {
  "abm": "1A", "g#m": "1A", "ebm": "2A", "d#m": "2A", "bbm": "3A", "a#m": "3A",
  "fm": "4A", "cm": "5A", "gm": "6A", "dm": "7A", "am": "8A", "em": "9A",
  "bm": "10A", "f#m": "11A", "gbm": "11A", "c#m": "12A", "dbm": "12A",
  "b": "1B", "f#": "2B", "gb": "2B", "db": "3B", "c#": "3B", "ab": "4B", "g#": "4B",
  "eb": "5B", "d#": "5B", "bb": "6B", "a#": "6B", "f": "7B", "c": "8B",
  "g": "9B", "d": "10B", "a": "11B", "e": "12B",
};

function asCamelot(value: string): string {
  const compact = value.trim().toLowerCase().replace("♭", "b").replace("♯", "#").replace(/\s+/g, "");
  return CAMELOT[compact] ?? value.trim().toUpperCase();
}

export function keyRelationshipDistance(a: string, b: string): number | null {
  const parse = (value: string) => /^\s*(1[0-2]|[1-9])\s*([AB])\s*$/i.exec(asCamelot(value));
  const left = parse(a), right = parse(b);
  if (!left || !right) return null;
  const n1 = Number(left[1]), n2 = Number(right[1]);
  const wheel = Math.min(Math.abs(n1 - n2), 12 - Math.abs(n1 - n2));
  return wheel + (left[2]!.toUpperCase() === right[2]!.toUpperCase() ? 0 : 0.5);
}

export async function suggestNext(request: SuggestNextRequest = {}) {
  const model = await getSuggestionReadModel();
  const seed = request.trackId !== undefined
    ? model.tracks.find((t) => t.trackId === request.trackId)
    : request.path ? model.tracks.find((t) => pathKey(t.path) === pathKey(request.path!)) : undefined;
  if (!seed) return { available: false, reason: "Select a local track first", seed: null,
    candidates: [] as SuggestedCandidate[], unknowns: [] as string[] };
  const playlist = request.playlistId
    ? model.playlists.find((p) => p.sourceId === request.playlistId) : undefined;
  const allowed = request.localPlaylistId !== undefined
    ? new Set(db.query<{ track_id: number }, [number]>("SELECT track_id FROM memberships WHERE playlist_id=?").all(request.localPlaylistId).map((m) => m.track_id))
    : playlist ? new Set(playlist.trackIds) : null;
  const excluded = new Set(request.excludeTrackIds ?? []);
  const hashes = new Map(db.query<{ id: number; content_hash: string | null }, []>("SELECT id,content_hash FROM tracks WHERE missing=0").all().map((t) => [t.id, t.content_hash]));
  const seenHashes = new Set([seed.trackId, ...excluded].flatMap((id) => hashes.get(id) ? [hashes.get(id)!] : []));
  const candidates = model.tracks
    .filter((t) => t.trackId !== seed.trackId && !excluded.has(t.trackId) && (!allowed || allowed.has(t.trackId)))
    .map((track): SuggestedCandidate => {
      const evidence: SuggestionEvidence[] = [];
      let score = 0;
      if (seed.bpm !== null && track.bpm !== null) {
        const factors = request.allowHalfDouble ? [1, 0.5, 2] : [1];
        const factor = factors.reduce((best, value) => Math.abs(seed.bpm! - track.bpm! * value) < Math.abs(seed.bpm! - track.bpm! * best) ? value : best, 1);
        const delta = Math.abs(seed.bpm - track.bpm * factor);
        const weight = request.priority === "tempo" ? 1.75 : request.priority === "key" ? 0.5 : 1;
        score += Math.max(0, 24 - delta * 3) * weight;
        evidence.push({ kind: "measured", signal: "tempo", detail: `${delta.toFixed(1)} BPM difference${factor === 1 ? "" : ` with ${factor === 2 ? "double" : "half"}-tempo counting (${track.bpm} → ${track.bpm * factor})`}` });
      } else evidence.push({ kind: "unknown", signal: "tempo", detail: "BPM unavailable for one or both tracks" });
      if (seed.key && track.key) {
        const distance = keyRelationshipDistance(seed.key, track.key);
        if (distance !== null) {
          const weight = request.priority === "key" ? 2.5 : request.priority === "tempo" ? 0.5 : 1;
          score += Math.max(0, 8 - distance * 3) * weight;
          evidence.push({ kind: "observed", signal: "key", detail: distance === 0
            ? `same Rekordbox key (${track.key})` : `Rekordbox keys ${seed.key} → ${track.key}` });
        } else evidence.push({ kind: "observed", signal: "key", detail: `Rekordbox keys ${seed.key} → ${track.key}; relationship not interpreted` });
      } else evidence.push({ kind: "unknown", signal: "key", detail: "Key unavailable for one or both tracks" });
      if (playlist) {
        score += 2;
        evidence.push({ kind: "observed", signal: "playlist", detail: `in Rekordbox playlist ${playlist.name}` });
      }
      if (track.cueCount) evidence.push({ kind: "observed", signal: "analysis",
        detail: `${track.cueCount} saved Rekordbox cues to audition` });
      const reasons = evidence.filter((e) => e.kind !== "unknown").map((e) => e.detail);
      return { ...track, score: Math.round(score * 10) / 10, reasons, evidence };
    })
    // An alphabetical list with no supporting signal is not a recommendation.
    .filter((candidate) => candidate.evidence.some((e) => e.kind !== "unknown" && (e.signal === "tempo" || e.signal === "key")))
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title) || a.trackId - b.trackId)
    .filter((candidate) => {
      const hash = hashes.get(candidate.trackId);
      if (!hash) return true;
      if (seenHashes.has(hash)) return false;
      seenHashes.add(hash);
      return true;
    })
    .slice(0, boundedLimit(request.limit, 3, 20));
  const unknowns = [...new Set(candidates.flatMap((c) => c.evidence
    .filter((e) => e.kind === "unknown").map((e) => e.detail)))];
  return { available: candidates.length > 0, reason: candidates.length ? model.reason : "No other local tracks match this scope",
    seed, candidates, unknowns };
}

export async function getPrepGaps(request: { playlistId?: string; limit?: number } = {}) {
  const model = await getSuggestionReadModel();
  const playlist = request.playlistId
    ? model.playlists.find((p) => p.sourceId === request.playlistId) : undefined;
  const allowed = playlist ? new Set(playlist.trackIds) : null;
  const gaps = model.tracks.flatMap((track) => {
    if (allowed && !allowed.has(track.trackId)) return [];
    const missing = [track.bpm === null ? "BPM" : null, track.key === null ? "key" : null]
      .filter((x): x is string => x !== null);
    return missing.length ? [{ trackId: track.trackId, path: track.path, title: track.title,
      artist: track.artist, missing, action: `Analyze ${missing.join(" and ")} in Rekordbox` }] : [];
  }).slice(0, boundedLimit(request.limit, 20, 100));
  return { available: model.available, reason: model.reason, gaps };
}
