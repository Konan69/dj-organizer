/** Compact presentation of existing Rekordbox facts. No new audio analysis. */
export type AnalysisCue = {
  id: string; time: number; endTime: number | null; kind: "hot" | "memory";
  index: number | null; label: string; comment: string | null;
};
export type AnalysisBeat = { time: number; beat: number; bpm: number };
export type AnalysisPhrase = { start: number; end: number; label: string; kind: number; mood: number };
/** Rekordbox 3-band colour waveform, each value 0..100 against the track's
 *  loudest band. `rate` is columns per second. */
export type AnalysisBands = { rate: number; low: number[]; mid: number[]; high: number[] };
export type RawAnalysis = {
  status: "ready" | "partial" | "missing"; source: "rekordbox";
  beats: AnalysisBeat[]; phrases: AnalysisPhrase[];
  waveform: { samples: number[]; source: "PWAV" } | null;
  /** rate is null for the PWV6 whole-track preview; resolved from duration. */
  bands: (Omit<AnalysisBands, "rate"> & { rate: number | null }) | null;
  issues: string[]; observedAt: number | null;
};
export type AnalysisAnchor = { time: number; label: string; reason: string; kind: "cue" | "phrase" };

export function summarizeAnalysis(raw: RawAnalysis, cues: AnalysisCue[], duration: number) {
  const validTime = (time: number) => Number.isFinite(time) && time >= 0 && (duration <= 0 || time < duration);
  const beats = raw.beats.filter((beat) => validTime(beat.time));
  const phrases = raw.phrases.filter((phrase) => validTime(phrase.start) && Number.isFinite(phrase.end) && phrase.end > phrase.start)
    .map((phrase) => ({ ...phrase, end: duration > 0 ? Math.min(duration, phrase.end) : phrase.end }));
  const validCues = cues.filter((cue) => validTime(cue.time)).sort((a, b) => a.time - b.time);
  const anchors: AnalysisAnchor[] = validCues.map((cue) => ({ time: cue.time,
    label: cue.label, reason: cue.comment || `Saved Rekordbox ${cue.kind === "hot" ? "hot cue" : "memory cue"}`,
    kind: "cue" as const }));
  // A saved cue takes precedence over a nearby phrase boundary. Keep a short,
  // chronological listening list; these are anchors, not promised mix points.
  for (const phrase of phrases) {
    if (!anchors.some((anchor) => Math.abs(anchor.time - phrase.start) < 1)) {
      anchors.push({ time: phrase.start, label: phrase.label,
        reason: "Rekordbox phrase boundary — listen before choosing a mix point", kind: "phrase" });
    }
  }
  anchors.sort((a, b) => a.time - b.time);
  const issues = [...raw.issues];
  if (validCues.length !== cues.length) issues.push("Some saved cues are outside this audio file's duration.");
  // PWV6 previews span the whole track; without a duration they cannot be placed.
  const bands: AnalysisBands | null = !raw.bands ? null
    : raw.bands.rate !== null ? { ...raw.bands, rate: raw.bands.rate }
    : duration > 0 && raw.bands.low.length ? { ...raw.bands, rate: raw.bands.low.length / duration }
    : null;
  return { ...raw, bands, beats, phrases, cues: validCues, duration,
    status: raw.status === "missing" && validCues.length ? "partial" as const : raw.status,
    issues, summary: { beatCount: beats.length, phraseCount: phrases.length, cueCount: validCues.length },
    anchors };
}
