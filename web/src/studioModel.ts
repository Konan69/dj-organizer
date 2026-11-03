/**
 * The Studio mix timeline, computed from the set order, each pair's
 * transition and each track's Rekordbox analysis. Pure: no React, no audio.
 *
 * Mix time is the time of the whole mix; source time is a position inside one
 * track's audio file. Each clip maps mix time to source time with a short list
 * of rate segments, so the engine, the waveform drawing and the lookups all
 * agree on where every beat lands.
 *
 *   A ─────────────[ T0 ····· window ····· T1 ]
 *                   B ── rate bpmA/bpmB ──┘└─ glide to 1.0 over 8 bars ─┘── 1.0 ──
 */
import { mixPointChoices } from "./mix-point-choices";
import {
  resolveTransitionMix, transitionKey,
  type BandAutomation, type BandMode, type TransitionBars, type TransitionEq, type TransitionMix, type TransitionPrep,
} from "./setStore";

// ---- inputs -------------------------------------------------------------------

export type StudioBeat = { time: number; beat: number; bpm: number };
export type StudioPhrase = { start: number; end: number; label: string };
export type StudioCue = { time: number; label: string; kind: "hot" | "memory"; index: number | null };
export type StudioAnchor = { time: number; label: string; reason: string; kind: "cue" | "phrase" };
/** The parts of a TrackAnalysisData the timeline reads. */
export type StudioAnalysis = {
  duration: number;
  beats: StudioBeat[];
  phrases: StudioPhrase[];
  cues: StudioCue[];
  anchors: StudioAnchor[];
};
export type StudioTrackInput = {
  id: number;
  /** Seconds of source audio. */
  duration: number;
  /** Rekordbox BPM when the beat grid has none. */
  bpm: number | null;
  analysis: StudioAnalysis | null;
};

// ---- outputs ------------------------------------------------------------------

/**
 * Source position over a span of mix time with a linearly changing rate:
 * source(t) = s0 + r0·u + (r1 − r0)·u² / 2L, where u = t − t0 and L = t1 − t0.
 * The last segment of a clip is open-ended (t1 = Infinity, r1 = r0).
 */
export type RateSegment = { t0: number; t1: number; s0: number; r0: number; r1: number };

export type StudioClip = {
  index: number;
  trackId: number;
  /** Tracks alternate Deck 1 / Deck 2. */
  lane: 0 | 1;
  duration: number;
  /** Native tempo near the start of the clip (display only). */
  bpm: number | null;
  /** Mix time the clip sounds from / until. */
  start: number;
  end: number;
  /** Source time at `start` / `end`. */
  sourceStart: number;
  sourceEnd: number;
  segments: RateSegment[];
  analysis: StudioAnalysis | null;
};

export type PointKind = "cue" | "phrase" | "grid" | "start" | "end";
export type ResolvedPoint = { time: number; label: string; kind: PointKind; auto: boolean };

export type StudioTransition = {
  index: number;
  key: string;
  fromId: number;
  toId: number;
  fromIndex: number;
  toIndex: number;
  /** The transition window in mix time. */
  t0: number;
  t1: number;
  bars: TransitionBars;
  mix: TransitionMix;
  prep: TransitionPrep;
  offsetBeats: number;
  /** Where A leaves, before the nudge (source time of A). */
  mixOut: ResolvedPoint;
  /** Source time of A at T0: mixOut plus the nudge, kept inside the track. */
  exitAt: number;
  /** Source time of B at T0. */
  mixIn: ResolvedPoint;
  /** Tempo of the mix during the window; null when A has no known tempo. */
  masterBpm: number | null;
  /** Mix seconds per beat during the window (120 BPM when unknown). */
  beat: number;
  /** B's playback rate during the window. */
  rateIn: number;
  /** Both tempos were known, so B is stretched onto A's grid. */
  tempoMatched: boolean;
  warnings: string[];
};

export type StudioTimeline = { clips: StudioClip[]; transitions: StudioTransition[]; duration: number };

export type BandGains = { volume: number; bass: number; mid: number; high: number };

// ---- constants ----------------------------------------------------------------

/** B glides back to its own tempo over 8 bars after the window. */
export const GLIDE_BEATS = 32;
export const BEATS_PER_BAR = 4;
/** 120 BPM: used only when a track has no tempo at all. */
export const FALLBACK_BEAT = 0.5;
/** A band at "kill" is this many dB down. */
export const KILL_DB = -26;

const EMPTY: StudioTimeline = Object.freeze({ clips: [], transitions: [], duration: 0 }) as StudioTimeline;

const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value));
const finitePositive = (value: number | null | undefined): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

// ---- segments -----------------------------------------------------------------

const segLength = (g: RateSegment) => g.t1 - g.t0;
const isRamp = (g: RateSegment) => Number.isFinite(segLength(g)) && segLength(g) > 0 && g.r1 !== g.r0;

export function segSource(g: RateSegment, t: number): number {
  const u = t - g.t0;
  if (!isRamp(g)) return g.s0 + g.r0 * u;
  return g.s0 + g.r0 * u + (g.r1 - g.r0) * u * u / (2 * segLength(g));
}

export function segRate(g: RateSegment, t: number): number {
  if (!isRamp(g)) return g.r0;
  const u = clamp(t - g.t0, 0, segLength(g));
  return g.r0 + (g.r1 - g.r0) * u / segLength(g);
}

/** Mix time at which a segment reaches source time `s` (monotonic, rates > 0). */
function segTimeOf(g: RateSegment, s: number): number {
  const d = s - g.s0;
  if (!isRamp(g)) return g.t0 + d / g.r0;
  const a = (g.r1 - g.r0) / (2 * segLength(g));
  const root = Math.sqrt(Math.max(0, g.r0 * g.r0 + 4 * a * d));
  // Stable form of (−b + √(b² + 4ad)) / 2a; also correct as a → 0.
  return g.t0 + (2 * d) / (g.r0 + root);
}

export function sourceAtSegments(segments: readonly RateSegment[], t: number): number {
  const first = segments[0];
  if (!first) return t;
  if (t <= first.t0) return first.s0 + first.r0 * (t - first.t0);
  for (const g of segments) if (t <= g.t1) return segSource(g, t);
  const last = segments[segments.length - 1]!;
  return segSource(last, last.t1) + segRate(last, last.t1) * (t - last.t1);
}

export function rateAtSegments(segments: readonly RateSegment[], t: number): number {
  const first = segments[0];
  if (!first) return 1;
  if (t <= first.t0) return first.r0;
  for (const g of segments) if (t <= g.t1) return segRate(g, t);
  const last = segments[segments.length - 1]!;
  return segRate(last, last.t1);
}

export function mixTimeAtSegments(segments: readonly RateSegment[], s: number): number {
  const first = segments[0];
  if (!first) return s;
  if (s <= first.s0) return first.t0 + (s - first.s0) / first.r0;
  for (const g of segments) {
    const end = Number.isFinite(g.t1) ? segSource(g, g.t1) : Infinity;
    if (s <= end) return segTimeOf(g, s);
  }
  const last = segments[segments.length - 1]!;
  return last.t1 + (s - segSource(last, last.t1)) / segRate(last, last.t1);
}

export const sourceAt = (clip: StudioClip, t: number) => sourceAtSegments(clip.segments, t);
export const rateAt = (clip: StudioClip, t: number) => rateAtSegments(clip.segments, t);
export const mixTimeOf = (clip: StudioClip, source: number) => mixTimeAtSegments(clip.segments, source);

/** Keep everything before T, then hold the rate A had at T. */
function holdFrom(segments: RateSegment[], at: number): RateSegment[] {
  const kept: RateSegment[] = [];
  for (const g of segments) {
    if (g.t0 >= at) break;
    if (g.t1 <= at) { kept.push(g); continue; }
    kept.push({ ...g, t1: at, r1: segRate(g, at) });
    break;
  }
  const rate = rateAtSegments(segments, at);
  kept.push({ t0: at, t1: Infinity, s0: sourceAtSegments(segments, at), r0: rate, r1: rate });
  return kept;
}

// ---- beat grid ----------------------------------------------------------------

/** Index of the beat nearest `time`, or -1 without a grid. */
export function nearestBeatIndex(beats: readonly StudioBeat[], time: number): number {
  if (!beats.length) return -1;
  let lo = 0, hi = beats.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (beats[mid]!.time < time) lo = mid + 1; else hi = mid;
  }
  if (lo > 0 && Math.abs(beats[lo - 1]!.time - time) <= Math.abs(beats[lo]!.time - time)) return lo - 1;
  return lo;
}

/** Nearest beat of the grid; unchanged without one. */
export function snapToBeat(beats: readonly StudioBeat[], time: number): number {
  const index = nearestBeatIndex(beats, time);
  return index < 0 ? time : beats[index]!.time;
}

/** Nearest downbeat at or after `time` (or the nearest beat when the grid has no bar numbers). */
export function snapToDownbeatAtOrAfter(beats: readonly StudioBeat[], time: number): number {
  const start = nearestBeatIndex(beats, time);
  if (start < 0) return time;
  for (let i = beats[start]!.time < time - 1e-6 ? start + 1 : start; i < beats.length; i++) {
    if (beats[i]!.beat === 1) return beats[i]!.time;
  }
  return beats[start]!.time;
}

/** Nearest downbeat at or before `time`. */
export function snapToDownbeatAtOrBefore(beats: readonly StudioBeat[], time: number): number {
  const start = nearestBeatIndex(beats, time);
  if (start < 0) return time;
  for (let i = beats[start]!.time > time + 1e-6 ? start - 1 : start; i >= 0; i--) {
    if (beats[i]!.beat === 1) return beats[i]!.time;
  }
  return beats[start]!.time;
}

/** Native tempo at a source position: the grid's local BPM, else the track's. */
export function bpmAt(track: StudioTrackInput, source: number): number | null {
  const beats = track.analysis?.beats ?? [];
  const index = nearestBeatIndex(beats, source);
  const local = index < 0 ? null : beats[index]!.bpm;
  if (finitePositive(local)) return local;
  return finitePositive(track.bpm) ? track.bpm : null;
}

/**
 * B's rate to sit on A's grid. Half and double time are considered, so a
 * 174 track over 87 is played at its own speed rather than twice as fast.
 */
export function matchRate(masterBpm: number, bpm: number): number {
  let best = masterBpm / bpm;
  for (const factor of [2, 0.5]) {
    const rate = masterBpm / (bpm * factor);
    if (Math.abs(Math.log(rate)) < Math.abs(Math.log(best)) - 1e-9) best = rate;
  }
  return best;
}

// ---- mix points ---------------------------------------------------------------

const OUTRO = /^outro\b/i;
const phraseLabel = (label: string) => label.trim() || "Phrase";

/** Human cue name: "Hot cue A", "Memory cue", or the DJ's own comment. */
export function cueLabel(cue: StudioCue): string {
  const raw = cue.label.trim();
  if (raw && !/^cue\s*\(auto\)$/i.test(raw)) return raw;
  if (cue.kind === "hot" && cue.index !== null && cue.index >= 1) return `Hot cue ${String.fromCharCode(64 + cue.index)}`;
  return cue.kind === "hot" ? "Hot cue" : "Memory cue";
}

/** m:ss (or h:mm:ss) — never fractional seconds. */
export function fmtClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds + 1e-6));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

export type PointOption = { time: number; label: string; kind: "cue" | "phrase"; text: string };

/** Saved cues and phrase starts, chronological, labelled "Outro 1 · 2:14". */
export function pointOptions(analysis: StudioAnalysis | null): PointOption[] {
  if (!analysis) return [];
  const within = (time: number) => Number.isFinite(time) && time >= 0 && (analysis.duration <= 0 || time < analysis.duration);
  const options: PointOption[] = [];
  const cues = analysis.cues.filter((cue) => within(cue.time)).sort((a, b) => a.time - b.time);
  const phrases = analysis.phrases.filter((phrase) => within(phrase.start));
  for (const cue of cues) {
    // An unnamed memory cue on a phrase boundary reads better as the phrase.
    const phrase = phrases.find((p) => Math.abs(p.start - cue.time) < 0.5);
    const name = cueLabel(cue);
    const label = phrase && name === "Memory cue" ? phraseLabel(phrase.label) : name;
    options.push({ time: cue.time, label, kind: "cue", text: `${label} · ${fmtClock(cue.time)}` });
  }
  for (const phrase of phrases) {
    if (options.some((option) => Math.abs(option.time - phrase.start) < 0.5)) continue;
    const label = phraseLabel(phrase.label);
    options.push({ time: phrase.start, label, kind: "phrase", text: `${label} · ${fmtClock(phrase.start)}` });
  }
  return options.sort((a, b) => a.time - b.time);
}

const pointLabel = (analysis: StudioAnalysis | null, time: number): { label: string; kind: PointKind } | null => {
  const hit = pointOptions(analysis).find((option) => Math.abs(option.time - time) < 0.5);
  return hit ? { label: hit.label, kind: hit.kind } : null;
};

/**
 * Where A leaves when nobody chose: the first Outro phrase that still leaves
 * room for the window, else a saved listening point (mixPointChoices), else
 * the last phrase boundary `bars` before the end, else the grid.
 */
export function defaultMixOut(track: StudioTrackInput, bars: TransitionBars, earliest: number): ResolvedPoint {
  const analysis = track.analysis;
  const bpm = bpmAt(track, track.duration * 0.8);
  const beat = bpm ? 60 / bpm : FALLBACK_BEAT;
  // The window may run up to one bar past the end of the file.
  const latest = track.duration - (bars - 1) * BEATS_PER_BAR * beat;
  const fits = (time: number) => time >= earliest - 1e-6 && time <= latest + 1e-6;
  if (analysis) {
    const outro = analysis.phrases.filter((phrase) => OUTRO.test(phrase.label) && fits(phrase.start)).sort((a, b) => a.start - b.start)[0];
    if (outro) return { time: outro.start, label: phraseLabel(outro.label), kind: "phrase", auto: true };
    const choices = mixPointChoices({ duration: track.duration, anchors: analysis.anchors }, "out").filter((choice) => fits(choice.time));
    const choice = choices.find((c) => OUTRO.test(c.label)) ?? choices.at(-1);
    if (choice) {
      const named = pointLabel(analysis, choice.time);
      return { time: choice.time, label: named?.label ?? choice.label, kind: named?.kind ?? choice.kind, auto: true };
    }
    const boundary = analysis.phrases.filter((phrase) => fits(phrase.start)).sort((a, b) => b.start - a.start)[0];
    if (boundary) return { time: boundary.start, label: phraseLabel(boundary.label), kind: "phrase", auto: true };
    if (analysis.beats.length && latest >= earliest) {
      return { time: snapToDownbeatAtOrBefore(analysis.beats, latest), label: `${bars} bars before the end`, kind: "grid", auto: true };
    }
  }
  return { time: Math.max(earliest, Math.max(0, latest)), label: latest > earliest ? `${bars} bars before the end` : "Earliest exit", kind: "end", auto: true };
}

/** Where B starts when nobody chose: its first saved cue in the opening third, else its first downbeat. */
export function defaultMixIn(track: StudioTrackInput): ResolvedPoint {
  const analysis = track.analysis;
  if (analysis) {
    const cue = analysis.cues.filter((c) => Number.isFinite(c.time) && c.time >= 0 && c.time <= track.duration / 3).sort((a, b) => a.time - b.time)[0];
    if (cue) {
      const named = pointLabel(analysis, cue.time);
      return { time: snapToBeat(analysis.beats, cue.time), label: named?.label ?? cueLabel(cue), kind: "cue", auto: true };
    }
    const downbeat = analysis.beats.find((beat) => beat.beat === 1) ?? analysis.beats[0];
    if (downbeat) return { time: downbeat.time, label: "First downbeat", kind: "grid", auto: true };
  }
  return { time: 0, label: "Track start", kind: "start", auto: true };
}

function resolvePoint(stored: TransitionPrep["mixOut"], track: StudioTrackInput): ResolvedPoint | null {
  if (!stored || !Number.isFinite(stored.time)) return null;
  const time = snapToBeat(track.analysis?.beats ?? [], clamp(stored.time, 0, Math.max(0, track.duration)));
  return { time, label: stored.label || fmtClock(stored.time), kind: stored.kind, auto: false };
}

// ---- timeline -----------------------------------------------------------------

type Incoming = { t0: number; t1: number; sIn: number; rate: number; bpm: number | null };

export type TimelineOverrides = { offsets?: Readonly<Record<string, number>> };

/**
 * Lay the set out in mix time. Track 0 starts at 0. Each transition window
 * starts where A reaches its (nudged) mix-out point and lasts `bars` bars at
 * A's tempo; B enters at its mix-in point, stretched onto A's beat grid, then
 * glides back to its own tempo. Mix-outs are pushed after the previous
 * window so no more than two tracks ever overlap.
 */
export function buildTimeline(
  tracks: readonly StudioTrackInput[],
  transitions: Readonly<Record<string, TransitionPrep>>,
  overrides: TimelineOverrides = {},
): StudioTimeline {
  const list = tracks.filter((track) => finitePositive(track.duration));
  if (!list.length) return EMPTY;
  const clips: StudioClip[] = [];
  const out: StudioTransition[] = [];
  let incoming: Incoming | null = null;

  for (let i = 0; i < list.length; i++) {
    const track = list[i]!;
    let segments: RateSegment[];
    let start: number, sourceStart: number, earliestExit: number;

    if (!incoming) {
      start = 0; sourceStart = 0; earliestExit = 0;
      segments = [{ t0: 0, t1: Infinity, s0: 0, r0: 1, r1: 1 }];
    } else {
      start = incoming.t0; sourceStart = incoming.sIn;
      const windowSeg: RateSegment = { t0: incoming.t0, t1: incoming.t1, s0: incoming.sIn, r0: incoming.rate, r1: incoming.rate };
      const atEnd = segSource(windowSeg, incoming.t1);
      segments = [windowSeg];
      if (Math.abs(incoming.rate - 1) > 1e-6 && incoming.bpm) {
        const glide = GLIDE_BEATS * 60 / incoming.bpm;
        const length = (2 * glide) / (incoming.rate + 1);
        segments.push({ t0: incoming.t1, t1: incoming.t1 + length, s0: atEnd, r0: incoming.rate, r1: 1 });
        segments.push({ t0: incoming.t1 + length, t1: Infinity, s0: atEnd + glide, r0: 1, r1: 1 });
      } else {
        segments.push({ t0: incoming.t1, t1: Infinity, s0: atEnd, r0: incoming.rate, r1: incoming.rate });
      }
      earliestExit = Math.min(track.duration, atEnd);
    }

    const next = list[i + 1];
    if (!next) {
      const end = Math.max(start, mixTimeAtSegments(segments, track.duration));
      clips.push({
        index: i, trackId: track.id, lane: (i % 2) as 0 | 1, duration: track.duration, bpm: bpmAt(track, sourceStart),
        start, end, sourceStart, sourceEnd: track.duration, segments, analysis: track.analysis,
      });
      break;
    }

    const key = transitionKey(track.id, next.id);
    const prep = transitions[key] ?? { notes: "", practiced: false };
    const mix = resolveTransitionMix(prep);
    const offsetBeats = overrides.offsets?.[key] ?? mix.offsetBeats;
    const bars = mix.bars;
    const warnings: string[] = [];

    let mixOut = resolvePoint(prep.mixOut, track) ?? defaultMixOut(track, bars, earliestExit);
    if (!mixOut.auto && mixOut.time < earliestExit - 1e-6) {
      warnings.push("Leave point falls inside the previous transition; moved to where that one ends.");
      mixOut = { ...mixOut, time: earliestExit };
    }
    const bpmA = bpmAt(track, mixOut.time);
    const beatA = bpmA ? 60 / bpmA : FALLBACK_BEAT;
    let exitAt = mixOut.time + offsetBeats * beatA;
    const lastExit = Math.max(earliestExit, track.duration - beatA);
    if (exitAt < earliestExit - 1e-6) {
      warnings.push("Nudged into the previous transition; held at its end.");
      exitAt = earliestExit;
    } else if (exitAt > lastExit + 1e-6) {
      warnings.push("Nudged past the end of the track; held at its last beat.");
      exitAt = lastExit;
    }
    if (earliestExit > track.duration - beatA) warnings.push("This track is shorter than the transitions around it.");

    const t0 = mixTimeAtSegments(segments, exitAt);
    const rateA = rateAtSegments(segments, t0);
    segments = holdFrom(segments, t0);
    const masterBpm = bpmA ? bpmA * rateA : null;
    const beat = masterBpm ? 60 / masterBpm : FALLBACK_BEAT;
    const t1 = t0 + bars * BEATS_PER_BAR * beat;
    const end = Math.max(start, Math.min(t1, mixTimeAtSegments(segments, track.duration)));

    const mixIn = resolvePoint(prep.mixIn, next) ?? defaultMixIn(next);
    const bpmB = bpmAt(next, mixIn.time);
    const tempoMatched = masterBpm !== null && bpmB !== null;
    const rateIn = tempoMatched ? matchRate(masterBpm, bpmB) : 1;
    if (!tempoMatched) warnings.push("Tempo unknown for one of these tracks, so B plays at its own speed.");

    clips.push({
      index: i, trackId: track.id, lane: (i % 2) as 0 | 1, duration: track.duration, bpm: bpmAt(track, sourceStart),
      start, end, sourceStart, sourceEnd: sourceAtSegments(segments, end), segments, analysis: track.analysis,
    });
    out.push({
      index: i, key, fromId: track.id, toId: next.id, fromIndex: i, toIndex: i + 1,
      t0, t1, bars, mix, prep, offsetBeats, mixOut, exitAt, mixIn,
      masterBpm, beat, rateIn, tempoMatched, warnings,
    });
    incoming = { t0, t1, sIn: mixIn.time, rate: rateIn, bpm: bpmB };
  }

  const duration = clips.reduce((max, clip) => Math.max(max, clip.end), 0);
  return { clips, transitions: out, duration };
}

// ---- lookups ------------------------------------------------------------------

export type Sounding = { clip: StudioClip; source: number; rate: number };

/** Tracks that sound at mix time t, with where each is in its own audio and how fast. */
export function soundingAt(timeline: StudioTimeline, t: number): Sounding[] {
  const result: Sounding[] = [];
  for (const clip of timeline.clips) {
    if (t < clip.start || t >= clip.end) continue;
    result.push({ clip, source: sourceAt(clip, t), rate: rateAt(clip, t) });
  }
  return result;
}

export function transitionAt(timeline: StudioTimeline, t: number): StudioTransition | null {
  return timeline.transitions.find((transition) => t >= transition.t0 && t < transition.t1) ?? null;
}

/** 0 at T0, 1 at T1. */
export const progressIn = (transition: StudioTransition, t: number) =>
  transition.t1 > transition.t0 ? clamp((t - transition.t0) / (transition.t1 - transition.t0), 0, 1) : 1;

/**
 * One band's gain (0..1) for the outgoing ("out") or incoming ("in") track at
 * progress p. Crossfade is equal-power, centred on `at` (0.5 spans the whole
 * window); fade-in / fade-out are linear on their own side; swap is a hard
 * switch at `at`; "none" keeps both full until A ends.
 */
export function bandGain(automation: BandAutomation, p: number, side: "out" | "in"): number {
  const at = clamp(Number.isFinite(automation.at) ? automation.at : 0.5, 0, 1);
  const x = clamp(p, 0, 1);
  switch (automation.mode as BandMode) {
    case "crossfade": {
      const half = Math.min(at, 1 - at);
      if (half < 1e-6) return swapGain(at, x, side);
      const q = clamp((x - (at - half)) / (2 * half), 0, 1);
      return side === "out" ? Math.cos(q * Math.PI / 2) : Math.sin(q * Math.PI / 2);
    }
    case "fade-out": return side === "out" ? 1 - x : 1;
    case "fade-in": return side === "in" ? x : 1;
    case "swap": return swapGain(at, x, side);
    default: return 1;
  }
}

const swapGain = (at: number, p: number, side: "out" | "in") => {
  const after = p >= at;
  return side === "out" ? (after ? 0 : 1) : (after ? 1 : 0);
};

export function bandGains(eq: TransitionEq, p: number, side: "out" | "in"): BandGains {
  return {
    volume: bandGain(eq.volume, p, side),
    bass: bandGain(eq.bass, p, side),
    mid: bandGain(eq.mid, p, side),
    high: bandGain(eq.high, p, side),
  };
}

const FULL: BandGains = Object.freeze({ volume: 1, bass: 1, mid: 1, high: 1 });
const SILENT: BandGains = Object.freeze({ volume: 0, bass: 1, mid: 1, high: 1 });

/** What one clip's channel strip should be doing at mix time t. */
export function clipGainsAt(timeline: StudioTimeline, clipIndex: number, t: number): BandGains {
  const clip = timeline.clips[clipIndex];
  if (!clip || t < clip.start || t >= clip.end) return SILENT;
  const incoming = timeline.transitions[clipIndex - 1];
  if (incoming && t >= incoming.t0 && t < incoming.t1) return bandGains(incoming.mix.eq, progressIn(incoming, t), "in");
  const outgoing = timeline.transitions[clipIndex];
  if (outgoing && t >= outgoing.t0 && t < outgoing.t1) return bandGains(outgoing.mix.eq, progressIn(outgoing, t), "out");
  return FULL;
}

/** Echo send from the outgoing deck: ramps up across an echo transition's window. */
export function echoSendAt(timeline: StudioTimeline, clipIndex: number, t: number): number {
  const outgoing = timeline.transitions[clipIndex];
  if (!outgoing || outgoing.mix.fx !== "echo" || t < outgoing.t0 || t >= outgoing.t1) return 0;
  return progressIn(outgoing, t);
}

/** Linear band gain → EQ gain in dB, floored at the kill level. */
export const gainToDb = (gain: number) => gain >= 1 ? 0 : gain <= 0 ? KILL_DB : Math.max(KILL_DB, 20 * Math.log10(gain));

/** Rekordbox phrase label → phrase colour role. */
export type PhraseTone = "intro" | "verse" | "up" | "down" | "chorus" | "bridge" | "outro" | "other";
export function phraseTone(label: string): PhraseTone {
  const word = label.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return (["intro", "verse", "up", "down", "chorus", "bridge", "outro"] as const).find((tone) => tone === word) ?? "other";
}
