import { useCallback, useEffect, useState } from "react";
export { mixPointChoices } from "./mix-point-choices";

export type TrackAnalysisData = {
  trackId: number;
  source: "rekordbox";
  status: "ready" | "partial" | "missing";
  observedAt: number | null;
  beats: { time: number; beat: number; bpm: number }[];
  phrases: { start: number; end: number; label: string; kind: string | number; mood: string | number }[];
  cues: { id: string; time: number; endTime: number | null; kind: "hot" | "memory"; index: number | null; label: string; comment: string | null }[];
  waveform: { samples: number[]; source: "PWAV" } | null;
  /** Rekordbox 3-band colour waveform; values 0..100, `rate` columns per second. */
  bands: { rate: number; low: number[]; mid: number[]; high: number[] } | null;
  issues: string[];
  duration: number;
  summary: { cueCount: number; phraseCount: number; beatCount: number };
  anchors: { time: number; label: string; reason: string; kind: "cue" | "phrase" }[];
};

type Cached = { refreshKey: number; data: TrackAnalysisData };
const cache = new Map<number, Cached>();
const pending = new Map<string, Promise<TrackAnalysisData>>();
const latestRequest = new Map<number, number>();



function load(trackId: number, refreshKey: number) {
  const known = cache.get(trackId);
  if (known?.refreshKey === refreshKey) return Promise.resolve(known.data);
  const requestKey = `${trackId}:${refreshKey}`;
  const active = pending.get(requestKey);
  if (active) return active;
  latestRequest.set(trackId, refreshKey);
  const request = fetch(`/api/prep/analysis/${trackId}`).then(async (response) => {
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? `Analysis request failed (${response.status})`);
    if (latestRequest.get(trackId) === refreshKey) {
      if (!cache.has(trackId) && cache.size >= 192) {
        const oldest = cache.keys().next().value!;
        cache.delete(oldest); latestRequest.delete(oldest);
      }
      cache.set(trackId, { refreshKey, data: body as TrackAnalysisData });
    }
    pending.delete(requestKey);
    return body as TrackAnalysisData;
  }).catch((error) => { pending.delete(requestKey); throw error; });
  pending.set(requestKey, request);
  return request;
}

const time = (seconds: number) => seconds > 0 && seconds < 1
  ? `${seconds.toFixed(3)}s`
  : `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
const pct = (value: number, duration: number) => `${Math.max(0, Math.min(100, duration ? value / duration * 100 : 0))}%`;

export function useTrackAnalysis(trackId: number | null, refreshKey = 0) {
  const [data, setData] = useState<TrackAnalysisData | null>(() => trackId === null ? null : cache.get(trackId)?.data ?? null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let current = true;
    if (trackId === null) { setData(null); setError(null); return; }
    setData(cache.get(trackId)?.data ?? null); setError(null);
    void load(trackId, refreshKey).then((result) => { if (current && latestRequest.get(trackId) === refreshKey) setData(result); }).catch((reason) => { if (current && latestRequest.get(trackId) === refreshKey) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { current = false; };
  }, [trackId, refreshKey, retry]);
  return { data: data?.trackId === trackId ? data : null, error, retry: useCallback(() => setRetry((value) => value + 1), []) };
}

