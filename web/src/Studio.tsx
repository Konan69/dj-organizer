/**
 * Studio: the whole set as a two-deck timeline, like DJ.Studio's Studio view.
 * Clips alternate decks, overlap where they mix, and each overlap is a
 * transition you select, shape (preset, EQ moves, length, mix points, nudge)
 * and hear through the Web Audio engine.
 */
import {
  memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode,
} from "react";
import type { Track } from "./api";
import type { usePlayer } from "./hooks";
import { compat, COMPAT_LABEL, fmtBpm, keyColor, parseKey, type Compat } from "./keys";
import {
  rehearsalOf, TRANSITION_BARS, TRANSITION_PRESETS, useSet,
  type BandAutomation, type BandMode, type BuiltInPresetId, type RehearsalState, type TrackFacts,
  type TransitionBars, type TransitionEq, type TransitionPatch, type TransitionPrep,
} from "./setStore";
import { useTrackAnalysis, type TrackAnalysisData } from "./TrackAnalysis";
import { StudioEngine } from "./studioEngine";
import {
  bandGain, buildTimeline, cueLabel, fmtClock, mixTimeOf, phraseTone, pointOptions, rateAt,
  type PointOption, type StudioAnalysis, type StudioClip, type StudioTimeline, type StudioTrackInput, type StudioTransition,
} from "./studioModel";
import { drawLane, drawRuler, LANE, readPalette, type Palette, type WaveData } from "./studioDraw";
import { EmptyState, Icon, KeyBadge, Segmented } from "./ui";
import "./studio.css";

export type StudioProps = {
  tracks: Track[];
  player: ReturnType<typeof usePlayer>;
  focusPair: { fromId: number; toId: number } | null;
  onFocusConsumed: () => void;
  onBrowseLibrary: () => void;
  active: boolean;
};

// ---- constants --------------------------------------------------------------

const MAX_PPS = 400;
const EDGE = 24;
const ZOOM_STEP = 1.5;
const DRAG_SLOP = 4;
const SETTLE_MS = 140;
const PRESET_ORDER: BuiltInPresetId[] = ["bass-swap", "crossfade", "high-to-low", "low-to-high", "echo-out", "cut"];
const BANDS: { key: keyof TransitionEq; label: string }[] = [
  { key: "volume", label: "Volume" }, { key: "bass", label: "Bass" }, { key: "mid", label: "Mid" }, { key: "high", label: "High" },
];
const MODES: { value: BandMode; label: string }[] = [
  { value: "none", label: "None" }, { value: "crossfade", label: "Crossfade" }, { value: "fade-in", label: "Fade in" },
  { value: "fade-out", label: "Fade out" }, { value: "swap", label: "Swap" },
];
const REHEARSAL: { value: RehearsalState; label: string }[] = [
  { value: "not-tried", label: "Not tried" }, { value: "needs-work", label: "Needs work" }, { value: "works", label: "Works on decks" },
];
const EMPTY_TIMELINE: StudioTimeline = { clips: [], transitions: [], duration: 0 };
const COMPAT_TONE: Record<Compat, string> = {
  same: "var(--ok)", smooth: "var(--ok)", boost: "var(--info)", clash: "var(--danger)", unknown: "var(--text-3)",
};

const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value));
const reducedMotion = () => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const isTyping = (target: EventTarget | null) => target instanceof HTMLElement
  && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));

// ---- analysis adapters ------------------------------------------------------

const studioAnalysisCache = new WeakMap<TrackAnalysisData, StudioAnalysis | null>();
function toStudioAnalysis(data: TrackAnalysisData): StudioAnalysis | null {
  if (studioAnalysisCache.has(data)) return studioAnalysisCache.get(data)!;
  const value: StudioAnalysis | null = data.status === "missing" ? null : {
    duration: data.duration,
    beats: data.beats,
    phrases: data.phrases.map((phrase) => ({ start: phrase.start, end: phrase.end, label: phrase.label || String(phrase.kind) })),
    cues: data.cues.map((cue) => ({ time: cue.time, label: cue.label, kind: cue.kind, index: cue.index })),
    anchors: data.anchors,
  };
  studioAnalysisCache.set(data, value);
  return value;
}

const waveCache = new WeakMap<TrackAnalysisData, WaveData | null>();
function toWave(data: TrackAnalysisData): WaveData | null {
  if (waveCache.has(data)) return waveCache.get(data)!;
  let value: WaveData | null = null;
  if (data.bands && data.bands.rate > 0 && data.bands.low.length) value = { bands: data.bands, mono: null };
  else if (data.waveform?.samples.length) value = { bands: null, mono: { samples: data.waveform.samples, max: Math.max(1, ...data.waveform.samples) } };
  waveCache.set(data, value);
  return value;
}

type AnalysisSlot = { data: TrackAnalysisData | null; error: string | null };

function AnalysisProbe({ trackId, refreshKey, onResult }: {
  trackId: number; refreshKey: number; onResult: (trackId: number, slot: AnalysisSlot) => void;
}) {
  const { data, error } = useTrackAnalysis(trackId, refreshKey);
  useEffect(() => { onResult(trackId, { data, error }); }, [trackId, data, error, onResult]);
  return null;
}

const trackName = (track: Track | undefined, facts: TrackFacts | undefined) => {
  const artist = track?.artist ?? facts?.artist ?? null;
  const title = track?.title ?? facts?.title ?? track?.filename ?? null;
  return [artist, title].filter(Boolean).join(" – ") || "Unknown track";
};

/** Only the fields that move audio; notes and rehearsal edits don't relayout the timeline. */
const mixSignature = (transitions: Record<string, TransitionPrep>) => JSON.stringify(Object.keys(transitions).sort().map((key) => {
  const t = transitions[key]!;
  return [key, t.mixOut ?? null, t.mixIn ?? null, t.bars ?? null, t.preset ?? null, t.eq ?? null, t.fx ?? null, t.offsetBeats ?? 0];
}));

const isAdjacent = (ids: readonly number[], fromId: number, toId: number) => {
  const index = ids.indexOf(fromId);
  return index >= 0 && ids[index + 1] === toId;
};

const fmtOffset = (beats: number) => `${beats > 0 ? "+" : beats < 0 ? "−" : ""}${Math.abs(beats)} ${Math.abs(beats) === 1 ? "beat" : "beats"}`;

// ---- view controller --------------------------------------------------------

type ZoomTier = "far" | "near";
type Shift = { clipIndex: number; key: string | null; px: number };

/**
 * Owns zoom, scroll, playhead and canvas drawing. Everything that moves per
 * frame is a transform on one element; zoom is one custom property on the
 * few layers that position by time. React never re-renders for scroll.
 */
class TimelineView {
  pps = 1;
  sx = -EDGE;
  width = 0;
  laneHeight = 0;
  miniWidth = 0;
  t = 0;
  timeline: StudioTimeline = EMPTY_TIMELINE;
  waves: ReadonlyMap<number, WaveData> = new Map();
  palette: Palette | null = null;
  font = "500 12px sans-serif";
  shift: Shift | null = null;
  followPausedUntil = 0;
  fittedFor: string | null = null;
  onTier: ((tier: ZoomTier) => void) | null = null;

  root: HTMLElement | null = null;
  ruler: HTMLCanvasElement | null = null;
  lanes: [HTMLCanvasElement | null, HTMLCanvasElement | null] = [null, null];
  layers = new Set<HTMLElement>();
  playhead: HTMLElement | null = null;
  miniView: HTMLElement | null = null;
  miniHead: HTMLElement | null = null;
  clock: HTMLElement | null = null;
  slider: HTMLElement | null = null;
  private second = -1;
  titles = new Map<number, { el: HTMLElement; width: number }>();
  groups = new Map<number, HTMLElement>();
  chips = new Map<string, HTMLElement>();
  overlays = new Map<string, HTMLElement>();

  /** Set when chips mount or the timeline changes, so their fit is recomputed. */
  chipsDirty = true;
  private frame = 0;
  private appliedPps = -1;
  private tier: ZoomTier | null = null;

  get fitPps() {
    return this.timeline.duration > 0 && this.width > 0 ? (this.width - EDGE * 2) / this.timeline.duration : 1;
  }

  private clampView() {
    const fit = this.fitPps;
    this.pps = clamp(this.pps, Math.min(fit * 0.9, MAX_PPS), Math.max(MAX_PPS, fit));
    const total = this.timeline.duration * this.pps;
    this.sx = clamp(this.sx, -EDGE, Math.max(-EDGE, total - this.width + EDGE));
  }

  apply() {
    this.clampView();
    const { pps, sx } = this;
    const move = `translate3d(${-sx}px, 0, 0)`;
    const zoomChanged = pps !== this.appliedPps;
    for (const layer of this.layers) {
      layer.style.transform = move;
      if (zoomChanged) layer.style.setProperty("--pps", String(pps));
    }
    this.appliedPps = pps;
    for (const [index, title] of this.titles) {
      const clip = this.timeline.clips[index];
      if (!clip) continue;
      const left = clip.start * pps, span = (clip.end - clip.start) * pps;
      const offset = clamp(sx - left, 0, Math.max(0, span - title.width - 12));
      title.el.style.transform = offset ? `translate3d(${offset}px, 0, 0)` : "";
    }
    if (zoomChanged || this.chipsDirty) { this.chipsDirty = false; this.fitChips(); }
    const tier: ZoomTier = pps >= 2 ? "near" : "far";
    if (tier !== this.tier) {
      this.tier = tier;
      if (this.root) this.root.dataset.zoom = tier;
      this.onTier?.(tier);
    }
    this.placeMini();
    this.placePlayhead();
    this.requestDraw();
  }

  /** Each chip shows as much as the space to its neighbours allows. */
  private fitChips() {
    const list = this.timeline.transitions;
    list.forEach((tr, i) => {
      const el = this.chips.get(tr.key);
      if (!el) return;
      const centre = (tr.t0 + tr.t1) / 2;
      const prev = list[i - 1], next = list[i + 1];
      const gapPrev = prev ? centre - (prev.t0 + prev.t1) / 2 : Infinity;
      const gapNext = next ? (next.t0 + next.t1) / 2 - centre : Infinity;
      const room = Math.min(gapPrev, gapNext) * this.pps;
      el.dataset.fit = room > 250 ? "full" : room > 96 ? "keys" : "num";
    });
  }

  private placeMini() {
    const duration = this.timeline.duration;
    if (!this.miniView || duration <= 0 || this.miniWidth <= 0) return;
    const total = duration * this.pps;
    const x = clamp(this.sx / total, 0, 1) * this.miniWidth;
    const w = clamp(this.width / total, 0, 1) * this.miniWidth;
    this.miniView.style.transform = `translate3d(${x}px, 0, 0)`;
    this.miniView.style.width = `${Math.max(6, Math.min(w, this.miniWidth - x))}px`;
  }

  private placePlayhead() {
    const x = this.t * this.pps - this.sx;
    if (this.playhead) {
      this.playhead.style.transform = `translate3d(${x}px, 0, 0)`;
      this.playhead.style.visibility = x < -2 || x > this.width + 2 ? "hidden" : "";
    }
    if (this.miniHead && this.timeline.duration > 0) {
      this.miniHead.style.transform = `translate3d(${(this.t / this.timeline.duration) * this.miniWidth}px, 0, 0)`;
    }
  }

  setPlayhead(t: number, playing: boolean) {
    this.t = t;
    const second = Math.floor(t);
    if (second !== this.second) {
      this.second = second;
      if (this.clock) this.clock.textContent = fmtClock(t);
      this.slider?.setAttribute("aria-valuenow", String(second));
      this.slider?.setAttribute("aria-valuetext", fmtClock(t));
    }
    const x = t * this.pps - this.sx;
    if (playing && !this.shift && performance.now() > this.followPausedUntil && (x > this.width * 0.85 || x < 0)) {
      this.sx = t * this.pps - this.width * 0.15;
      this.apply();
      return;
    }
    this.placePlayhead();
  }

  zoomAt(pps: number, anchorX: number) {
    const t = (anchorX + this.sx) / this.pps;
    this.pps = pps;
    this.clampView();
    this.sx = t * this.pps - anchorX;
    this.apply();
  }

  /** Zoom around the playhead when it is on screen, else the middle. */
  zoomBy(factor: number) {
    const x = this.t * this.pps - this.sx;
    this.zoomAt(this.pps * factor, x >= 0 && x <= this.width ? x : this.width / 2);
  }

  fit() {
    this.pps = this.fitPps;
    this.sx = -EDGE;
    this.apply();
  }

  /** Bring [a, b] into view; zoom in or out only when it doesn't fit or is tiny. */
  reveal(a: number, b: number, zoom = false) {
    const span = Math.max(1, b - a);
    if (zoom || span * this.pps > this.width * 0.9) this.pps = (this.width * 0.6) / span;
    this.clampView();
    const x0 = a * this.pps - this.sx, x1 = b * this.pps - this.sx;
    if (zoom || x0 < 0 || x1 > this.width) this.sx = (a + b) / 2 * this.pps - this.width / 2;
    this.apply();
  }

  setShift(shift: Shift | null) {
    const previous = this.shift;
    this.shift = shift;
    const move = (el: HTMLElement | undefined, px: number) => { if (el) el.style.transform = px ? `translate3d(${px}px, 0, 0)` : ""; };
    if (previous && (!shift || previous.clipIndex !== shift.clipIndex)) {
      move(this.groups.get(previous.clipIndex), 0);
      if (previous.key) { move(this.overlays.get(previous.key), 0); move(this.chips.get(previous.key), 0); }
    }
    if (shift) {
      move(this.groups.get(shift.clipIndex), shift.px);
      if (shift.key) { move(this.overlays.get(shift.key), shift.px); move(this.chips.get(shift.key), shift.px); }
    }
    this.requestDraw();
  }

  requestDraw() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => { this.frame = 0; this.draw(); });
  }

  draw() {
    const palette = this.palette;
    if (!palette || this.width <= 0) return;
    if (this.ruler) drawRuler(this.ruler, this.width, this.ruler.clientHeight || 30, this.pps, this.sx, this.timeline.duration, palette, this.font);
    this.lanes.forEach((canvas, lane) => {
      if (!canvas) return;
      drawLane({
        canvas, width: this.width, height: canvas.clientHeight || this.laneHeight, lane: lane as 0 | 1,
        timeline: this.timeline, waves: this.waves, pps: this.pps, sx: this.sx, palette,
        shift: this.shift ? { clipIndex: this.shift.clipIndex, px: this.shift.px } : null,
      });
    });
  }

  dispose() {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
  }
}

// ---- local icons ------------------------------------------------------------

const EXTRA_ICONS = {
  arrow: <path d="M4 12h15M13.5 6.5 19 12l-5.5 5.5" />,
  fit: <><path d="M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4" /><path d="M8 12h8" /></>,
} as const;

function StudioIcon({ name, size = 16, style }: { name: keyof typeof EXTRA_ICONS; size?: number; style?: CSSProperties }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={style}>{EXTRA_ICONS[name]}</svg>
  );
}

// ---- component --------------------------------------------------------------

type Hit = { t: number; lane: 0 | 1; clip: StudioClip | null; transition: StudioTransition | null };
type Gesture = {
  id: number; x0: number; sx0: number; mode: "pending" | "pan" | "nudge"; hit: Hit;
  nudge: StudioTransition | null;
};
type DeckInfo = { clipIndex: number; bpm: string } | null;

export function Studio({ tracks, player, focusPair, onFocusConsumed, onBrowseLibrary, active }: StudioProps) {
  const set = useSet();
  const { draft, ready, loadFailed, facts, analysisRevision, canUndo, getTransition } = set;
  const { undo, updateTransition, applyPreset, retryLoad } = set;
  const ids = draft.trackIds;

  // ---- analysis for every track in the set ----
  const [analyses, setAnalyses] = useState<ReadonlyMap<number, AnalysisSlot>>(() => new Map());
  const report = useCallback((trackId: number, slot: AnalysisSlot) => setAnalyses((previous) => {
    const current = previous.get(trackId);
    if (current && current.data === slot.data && current.error === slot.error) return previous;
    return new Map(previous).set(trackId, slot);
  }), []);
  const loadedCount = ids.filter((id) => { const slot = analyses.get(id); return slot && (slot.data || slot.error); }).length;
  const settled = ready && loadedCount === ids.length;

  // ---- model ----
  const trackById = useMemo(() => new Map(tracks.map((track) => [track.id, track])), [tracks]);
  const inputs = useMemo<StudioTrackInput[]>(() => ids.map((id) => {
    const data = analyses.get(id)?.data ?? null;
    const duration = data && data.duration > 0 ? data.duration : trackById.get(id)?.duration ?? 0;
    return { id, duration, bpm: facts.get(id)?.bpm ?? null, analysis: data ? toStudioAnalysis(data) : null };
  }), [ids, analyses, trackById, facts]);
  const signature = mixSignature(draft.transitions);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `signature` stands in for draft.transitions.
  const mixTransitions = useMemo(() => draft.transitions, [signature]);
  const timeline = useMemo(() => settled ? buildTimeline(inputs, mixTransitions) : EMPTY_TIMELINE, [settled, inputs, mixTransitions]);
  const waves = useMemo(() => {
    const map = new Map<number, WaveData>();
    for (const id of ids) { const data = analyses.get(id)?.data; const wave = data ? toWave(data) : null; if (wave) map.set(id, wave); }
    return map;
  }, [ids, analyses]);

  const names = useMemo(() => new Map(ids.map((id) => [id, trackName(trackById.get(id), facts.get(id))])), [ids, trackById, facts]);
  const keyOf = useCallback((id: number) => facts.get(id)?.key ?? null, [facts]);

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const selected = timeline.transitions.find((tr) => tr.key === selectedKey) ?? null;
  const [loopOn, setLoopOn] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [issue, setIssue] = useState<string | null>(null);
  const [tier, setTier] = useState<ZoomTier>("far");
  const [decks, setDecks] = useState<[DeckInfo, DeckInfo]>([null, null]);
  /** Bumped when the timeline first gets a width, so work that needs one can run. */
  const [measured, setMeasured] = useState(false);

  // ---- view + engine ----
  const viewRef = useRef<TimelineView | null>(null);
  viewRef.current ??= new TimelineView();
  const view = viewRef.current;
  const engineRef = useRef<StudioEngine | null>(null);
  const namesRef = useRef(names);
  namesRef.current = names;
  const timelineRef = useRef(timeline);
  timelineRef.current = timeline;
  const decksRef = useRef<{ info: [DeckInfo, DeckInfo]; at: number }>({ info: [null, null], at: 0 });

  const updateDecks = useCallback((t: number, force = false) => {
    const tl = timelineRef.current;
    const next: [DeckInfo, DeckInfo] = [null, null];
    for (const clip of tl.clips) {
      if (t < clip.start || t >= clip.end) continue;
      const rate = rateAt(clip, t);
      next[clip.lane] = { clipIndex: clip.index, bpm: clip.bpm ? fmtBpm(clip.bpm * rate) : "—" };
    }
    const previous = decksRef.current;
    const changedClip = next.some((info, lane) => info?.clipIndex !== previous.info[lane]?.clipIndex);
    const changedBpm = next.some((info, lane) => info?.bpm !== previous.info[lane]?.bpm);
    const now = performance.now();
    if (changedClip || (changedBpm && (force || now - previous.at > 250))) {
      decksRef.current = { info: next, at: now };
      setDecks(next);
    }
  }, []);

  useEffect(() => {
    const engine = new StudioEngine({
      onTime: (t) => { viewRef.current?.setPlayhead(t, engine.isPlaying); updateDecks(t); },
      onPlayingChange: setPlaying,
      onIssue: (trackId, kind) => setIssue(kind === "blocked"
        ? "Audio was blocked. Press play again."
        : `Audio unavailable for ${namesRef.current.get(trackId) ?? "a track"}`),
    });
    engineRef.current = engine;
    // The timeline may already be built (cached analysis) before the engine exists.
    engine.setTimeline(timelineRef.current);
    return () => { engine.dispose(); engineRef.current = null; };
  }, [updateDecks]);

  useEffect(() => () => view.dispose(), [view]);
  useEffect(() => { view.onTier = setTier; return () => { view.onTier = null; }; }, [view]);

  // New timeline: hand it to the engine and the view, fit once per set.
  useLayoutEffect(() => {
    engineRef.current?.setTimeline(timeline);
    view.timeline = timeline;
    view.waves = waves;
    view.chipsDirty = true;
    const setKey = draft.setId ?? "active";
    if (timeline.duration > 0 && view.width > 0 && view.fittedFor !== setKey) { view.fittedFor = setKey; view.fit(); }
    else view.apply();
    updateDecks(view.t, true);
  }, [timeline, waves, view, draft.setId, updateDecks]);

  useEffect(() => { if (!active) engineRef.current?.pause(); }, [active]);
  // The preview player and Studio never play over each other.
  useEffect(() => { if (playing && !player.paused) player.toggle(); }, [playing]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!player.paused) engineRef.current?.pause(); }, [player.paused]);

  // ---- DOM registration ----
  const rootRef = useCallback((el: HTMLDivElement | null) => {
    view.root = el;
    if (el) {
      view.palette = readPalette(el);
      view.font = `500 12px ${getComputedStyle(el).fontFamily}`;
    }
  }, [view]);
  const layerRef = useCallback((el: HTMLElement | null) => {
    if (!el) return;
    view.layers.add(el);
    el.style.setProperty("--pps", String(view.pps));
    el.style.transform = `translate3d(${-view.sx}px, 0, 0)`;
    return () => { view.layers.delete(el); };
  }, [view]);
  const register = useMemo(() => ({
    title: (index: number, el: HTMLElement | null) => { if (el) view.titles.set(index, { el, width: el.offsetWidth }); else view.titles.delete(index); },
    group: (index: number, el: HTMLElement | null) => { if (el) view.groups.set(index, el); else view.groups.delete(index); },
    chip: (key: string, el: HTMLElement | null) => { if (el) view.chips.set(key, el); else view.chips.delete(key); view.chipsDirty = true; },
    overlay: (key: string, el: HTMLElement | null) => { if (el) view.overlays.set(key, el); else view.overlays.delete(key); },
  }), [view]);

  // Sizes: timeline width, lane height, minimap width.
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const miniRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const viewport = viewportRef.current, mini = miniRef.current;
    if (!viewport) return;
    const measure = () => {
      // Hidden behind another view: keep the last size and zoom.
      if (viewport.clientWidth <= 0) return;
      view.width = viewport.clientWidth;
      setMeasured(true);
      view.laneHeight = view.lanes[0]?.clientHeight ?? 0;
      view.miniWidth = mini?.clientWidth ?? 0;
      if (view.width > 0 && view.timeline.duration > 0 && view.fittedFor !== (draft.setId ?? "active")) {
        view.fittedFor = draft.setId ?? "active";
        view.fit();
      } else view.apply();
      view.draw();
    };
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    if (mini) observer.observe(mini);
    measure();
    return () => observer.disconnect();
  }, [view, draft.setId, settled]);

  // Wheel: ctrl/⌘ zooms around the pointer; otherwise scroll sideways.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const onWheel = (e: WheelEvent) => {
      if (!view.timeline.duration) return;
      e.preventDefault();
      const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? view.width : 1;
      if (e.ctrlKey || e.metaKey) {
        const x = e.clientX - viewport.getBoundingClientRect().left;
        view.zoomAt(view.pps * Math.exp(-e.deltaY * scale * 0.0015), x);
      } else {
        const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        view.sx += delta * scale;
        view.followPausedUntil = performance.now() + 3000;
        view.apply();
      }
    };
    viewport.addEventListener("wheel", onWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", onWheel);
  }, [view, settled]);

  // ---- transport actions ----
  const seek = useCallback((t: number) => engineRef.current?.seek(t), []);
  const togglePlay = useCallback(() => {
    const e = engineRef.current;
    if (!e || !timelineRef.current.clips.length) return;
    if (e.isPlaying) { e.pause(); return; }
    if (!player.paused) player.toggle();
    setIssue(null);
    void e.play();
  }, [player]);

  const loopRange = useMemo<readonly [number, number] | null>(() => selected
    ? [Math.max(0, selected.t0 - 4 * selected.beat), Math.min(timeline.duration, selected.t1 + 4 * selected.beat)] : null,
  [selected, timeline.duration]);
  useEffect(() => {
    engineRef.current?.setLoop(loopOn ? loopRange : null);
    // A loop elsewhere starts from its own beginning.
    if (loopOn && loopRange && (view.t < loopRange[0] || view.t > loopRange[1])) seek(loopRange[0]);
  }, [loopOn, loopRange, seek, view]);

  const goTo = useCallback((tr: StudioTransition, options: { zoom?: boolean } = {}) => {
    setSelectedKey(tr.key);
    seek(Math.max(0, tr.t0 - 4 * tr.beat));
    view.reveal(tr.t0 - 8 * tr.beat, tr.t1 + 8 * tr.beat, options.zoom);
  }, [seek, view]);

  const step = useCallback((direction: -1 | 1) => {
    const list = timelineRef.current.transitions;
    if (!list.length) return;
    let index: number;
    if (selected) index = selected.index + direction;
    else if (direction > 0) index = list.findIndex((tr) => tr.t0 > view.t + 0.01);
    else index = list.findLastIndex((tr) => tr.t0 < view.t - 0.01);
    // Nothing further that way: stay on the last (or first) one.
    if (index < 0 && !selected) index = direction > 0 ? list.length - 1 : 0;
    const target = list[clamp(index, 0, list.length - 1)];
    if (target) goTo(target);
  }, [selected, goTo, view]);

  const toggleLoop = useCallback(() => {
    if (loopOn) { setLoopOn(false); return; }
    const list = timelineRef.current.transitions;
    let target = selected;
    if (!target) {
      target = list.find((tr) => tr.t1 > view.t) ?? list.at(-1) ?? null;
      if (!target) return;
      setSelectedKey(target.key);
    }
    setLoopOn(true);
  }, [loopOn, selected, view]);

  const zoomBy = useCallback((factor: number) => view.zoomBy(factor), [view]);

  // ---- focus a pair from another view ----
  useEffect(() => {
    if (!focusPair || !settled || !measured) return;
    const tr = timeline.transitions.find((t) => t.fromId === focusPair.fromId && t.toId === focusPair.toId);
    if (tr) goTo(tr, { zoom: true });
    onFocusConsumed();
  }, [focusPair, settled, measured, timeline, goTo, onFocusConsumed]);

  // ---- keyboard ----
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
      const target = e.target instanceof HTMLElement ? e.target : null;
      // A dialog over Studio owns the keyboard.
      if (target?.closest("[aria-modal='true']")) return;
      // Space stays play/pause after a click, but a control reached with Tab
      // keeps its own Space, as buttons do everywhere else in the app.
      if (e.key === " " && target?.matches("button:focus-visible, a:focus-visible")) return;
      const actions: Record<string, () => void> = {
        " ": togglePlay, ArrowLeft: () => step(-1), ArrowRight: () => step(1),
        l: toggleLoop, L: toggleLoop, "+": () => zoomBy(ZOOM_STEP), "=": () => zoomBy(ZOOM_STEP),
        "-": () => zoomBy(1 / ZOOM_STEP), _: () => zoomBy(1 / ZOOM_STEP), Escape: () => setSelectedKey(null),
      };
      const action = actions[e.key];
      if (!action) return;
      e.preventDefault();
      action();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, togglePlay, step, toggleLoop, zoomBy]);

  // ---- ruler and minimap scrubbing ----
  const scrub = useRef<{ id: number; kind: "ruler" | "mini"; grab: number } | null>(null);
  const rulerTime = (clientX: number) => {
    const rect = viewportRef.current?.getBoundingClientRect();
    return rect ? clamp((clientX - rect.left + view.sx) / view.pps, 0, view.timeline.duration) : 0;
  };
  const onRulerDown = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0 || scrub.current || !view.timeline.duration) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    scrub.current = { id: e.pointerId, kind: "ruler", grab: 0 };
    seek(rulerTime(e.clientX));
  };
  const onRulerMove = (e: ReactPointerEvent<HTMLElement>) => {
    if (scrub.current?.id === e.pointerId && scrub.current.kind === "ruler") seek(rulerTime(e.clientX));
  };
  const onRulerKey = (e: ReactKeyboardEvent<HTMLElement>) => {
    const tl = view.timeline;
    if (!tl.duration) return;
    const clip = tl.clips.find((c) => view.t >= c.start && view.t < c.end);
    const bar = clip?.bpm ? 4 * 60 / (clip.bpm * rateAt(clip, view.t)) : 2;
    const moves: Record<string, number> = { ArrowLeft: view.t - bar, ArrowRight: view.t + bar, PageDown: view.t - 8 * bar, PageUp: view.t + 8 * bar, Home: 0, End: tl.duration };
    const target = moves[e.key];
    if (target === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    seek(clamp(target, 0, tl.duration));
    view.reveal(view.t, view.t);
  };

  const miniScroll = (clientX: number, grab: number) => {
    const mini = miniRef.current;
    if (!mini || !view.timeline.duration) return;
    const x = clientX - mini.getBoundingClientRect().left - grab;
    view.sx = (x / view.miniWidth) * view.timeline.duration * view.pps;
    view.followPausedUntil = performance.now() + 3000;
    view.apply();
  };
  const onMiniDown = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0 || scrub.current || !view.timeline.duration) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const rect = view.miniView?.getBoundingClientRect();
    const inside = rect && e.clientX >= rect.left && e.clientX <= rect.right;
    // Grabbing the window keeps the grab point under the pointer; clicking elsewhere centres it there.
    const grab = inside ? e.clientX - rect.left : (rect?.width ?? 0) / 2;
    scrub.current = { id: e.pointerId, kind: "mini", grab };
    miniScroll(e.clientX, grab);
  };
  const onMiniMove = (e: ReactPointerEvent<HTMLElement>) => {
    if (scrub.current?.id === e.pointerId && scrub.current.kind === "mini") miniScroll(e.clientX, scrub.current.grab);
  };
  const endScrub = (e: ReactPointerEvent<HTMLElement>) => { if (scrub.current?.id === e.pointerId) scrub.current = null; };

  // ---- lanes: click to seek or select, drag to pan, drag an incoming clip to nudge ----
  const gesture = useRef<Gesture | null>(null);
  const badgeRef = useRef<HTMLDivElement | null>(null);
  const pendingSettle = useRef<{ clipIndex: number; key: string; px: number } | null>(null);
  const settleFrame = useRef(0);

  const hitTest = (clientX: number, clientY: number, target: HTMLElement): Hit => {
    const rect = target.getBoundingClientRect();
    const t = (clientX - rect.left + view.sx) / view.pps;
    const lane: 0 | 1 = clientY - rect.top < rect.height / 2 ? 0 : 1;
    const tl = view.timeline;
    return {
      t, lane,
      clip: tl.clips.find((c) => c.lane === lane && t >= c.start && t < c.end) ?? null,
      transition: tl.transitions.find((tr) => t >= tr.t0 && t < tr.t1) ?? null,
    };
  };

  const settle = useCallback((clipIndex: number, key: string, from: number) => {
    cancelAnimationFrame(settleFrame.current);
    if (!from || reducedMotion()) { view.setShift(null); return; }
    const start = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / SETTLE_MS);
      const eased = 1 - Math.pow(1 - p, 3);
      view.setShift(p < 1 ? { clipIndex, key, px: from * (1 - eased) } : null);
      if (p < 1) settleFrame.current = requestAnimationFrame(tick);
    };
    settleFrame.current = requestAnimationFrame(tick);
  }, [view]);

  // After a nudge lands in the store, the clip re-renders at its snapped beat; ease out the remainder.
  useLayoutEffect(() => {
    const pending = pendingSettle.current;
    if (!pending) return;
    pendingSettle.current = null;
    view.setShift({ clipIndex: pending.clipIndex, key: pending.key, px: pending.px });
    settle(pending.clipIndex, pending.key, pending.px);
  }, [timeline, settle, view]);

  const onLanesDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || gesture.current || !view.timeline.duration) return;
    cancelAnimationFrame(settleFrame.current);
    const hit = hitTest(e.clientX, e.clientY, e.currentTarget);
    const incoming = hit.clip && hit.clip.index > 0 ? view.timeline.transitions[hit.clip.index - 1] ?? null : null;
    const nudge = incoming && isAdjacent(ids, incoming.fromId, incoming.toId) ? incoming : null;
    // Grabbing a clip that is still settling picks it up where it is, not where it is going.
    const carry = view.shift && nudge && view.shift.clipIndex === nudge.toIndex ? view.shift.px : 0;
    if (!carry) view.setShift(null);
    e.currentTarget.setPointerCapture(e.pointerId);
    gesture.current = { id: e.pointerId, x0: e.clientX - carry, sx0: view.sx, mode: "pending", hit, nudge };
  };

  const onLanesMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) return;
    const dx = e.clientX - g.x0;
    if (g.mode === "pending") {
      if (Math.abs(dx) <= DRAG_SLOP) return;
      g.mode = g.nudge ? "nudge" : "pan";
      e.currentTarget.dataset.drag = g.mode;
    }
    if (g.mode === "pan") {
      view.sx = g.sx0 - dx;
      view.followPausedUntil = performance.now() + 3000;
      view.apply();
      return;
    }
    const tr = g.nudge!;
    view.setShift({ clipIndex: tr.toIndex, key: tr.key, px: dx });
    const beats = Math.round(dx / (tr.beat * view.pps));
    const badge = badgeRef.current;
    if (badge) {
      badge.hidden = false;
      badge.textContent = fmtOffset(tr.offsetBeats + beats);
      const rect = e.currentTarget.getBoundingClientRect();
      badge.style.transform = `translate3d(${e.clientX - rect.left}px, ${tr.toIndex % 2 ? rect.height / 2 : 0}px, 0)`;
    }
  };

  const onLanesUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) return;
    gesture.current = null;
    delete e.currentTarget.dataset.drag;
    if (badgeRef.current) badgeRef.current.hidden = true;
    if (g.mode === "pending") {
      if (view.shift) settle(view.shift.clipIndex, view.shift.key ?? "", view.shift.px);
      if (g.hit.transition) setSelectedKey(g.hit.transition.key);
      else seek(clamp(g.hit.t, 0, view.timeline.duration));
      return;
    }
    if (g.mode !== "nudge" || !g.nudge) return;
    const tr = g.nudge;
    const dx = e.clientX - g.x0;
    const beats = Math.round(dx / (tr.beat * view.pps));
    setSelectedKey(tr.key);
    if (!beats) { settle(tr.toIndex, tr.key, dx); return; }
    // The remainder between the pointer and the snapped beat eases out once the store relays out the clip.
    pendingSettle.current = { clipIndex: tr.toIndex, key: tr.key, px: dx - beats * tr.beat * view.pps };
    updateTransition(tr.fromId, tr.toId, { offsetBeats: tr.offsetBeats + beats });
  };

  const onLanesCancel = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (gesture.current?.id !== e.pointerId) return;
    gesture.current = null;
    delete e.currentTarget.dataset.drag;
    if (badgeRef.current) badgeRef.current.hidden = true;
    settle(view.shift?.clipIndex ?? 0, view.shift?.key ?? "", view.shift?.px ?? 0);
  };

  // ---- editing the selected transition ----
  const editable = selected !== null && isAdjacent(ids, selected.fromId, selected.toId);
  const patch = useCallback((value: TransitionPatch) => {
    if (selected && isAdjacent(ids, selected.fromId, selected.toId)) updateTransition(selected.fromId, selected.toId, value);
  }, [selected, ids, updateTransition]);

  // ---- render ----
  const empty = ready && ids.length === 0;
  const loading = !ready || !settled;

  if (loadFailed) {
    return <div className="st st-center"><EmptyState title="Couldn't open this set" action={<button type="button" className="ui-btn" onClick={() => void retryLoad()}>Retry</button>} /></div>;
  }
  if (empty) {
    return (
      <div className="st st-center">
        <EmptyState title="No tracks in this set" action={
          <button type="button" className="ui-btn primary" onClick={onBrowseLibrary}><Icon name="plus" />Add tracks</button>
        } />
      </div>
    );
  }

  const laneStyle = { "--st-pad": `${LANE.pad}px`, "--st-head": `${LANE.head}px`, "--st-phrase": `${LANE.phrase}px` } as CSSProperties;

  return (
    <div className="st" ref={rootRef} style={laneStyle} data-zoom={tier} aria-busy={loading || undefined}>
      {ids.map((id) => <AnalysisProbe key={id} trackId={id} refreshKey={analysisRevision} onResult={report} />)}
      <span className="sr-only" role="status">{loading ? `Loading waveforms, ${loadedCount} of ${ids.length}` : ""}</span>

      <div className="st-stage">
        <div className="st-corner">
          <button type="button" className="ui-icon-btn sm" aria-label="Zoom out" title="Zoom out (−)" onClick={() => zoomBy(1 / ZOOM_STEP)} disabled={loading}><Icon name="zoomOut" /></button>
          <button type="button" className="ui-icon-btn sm" aria-label="Zoom in" title="Zoom in (+)" onClick={() => zoomBy(ZOOM_STEP)} disabled={loading}><Icon name="zoomIn" /></button>
          <button type="button" className="ui-icon-btn sm" aria-label="Zoom to fit" title="Zoom to fit" onClick={() => view.fit()} disabled={loading}><StudioIcon name="fit" /></button>
        </div>

        <div className="st-mini" ref={miniRef} onPointerDown={onMiniDown} onPointerMove={onMiniMove} onPointerUp={endScrub} onPointerCancel={endScrub} aria-hidden="true">
          {timeline.clips.map((clip) => (
            <span key={clip.index} className="st-mini-clip" data-lane={clip.lane} style={{
              left: `${(clip.start / timeline.duration) * 100}%`, width: `${((clip.end - clip.start) / timeline.duration) * 100}%`,
              "--k": keyColor(parseKey(keyOf(clip.trackId))),
            } as CSSProperties} />
          ))}
          {selected ? <span className="st-mini-sel" style={{ left: `${(selected.t0 / timeline.duration) * 100}%`, width: `${((selected.t1 - selected.t0) / timeline.duration) * 100}%` }} /> : null}
          <span className="st-mini-view" ref={(el) => { view.miniView = el; }} />
          <span className="st-mini-head" ref={(el) => { view.miniHead = el; }} />
        </div>

        <div className="st-decks">
          {([0, 1] as const).map((lane) => {
            const info = decks[lane];
            const clip = info ? timeline.clips[info.clipIndex] : null;
            return (
              <div key={lane} className="st-deck" data-live={clip ? "" : undefined}>
                <span className="st-deck-name">Deck {lane + 1}</span>
                {clip ? <><KeyBadge value={keyOf(clip.trackId)} size="sm" /><span className="st-deck-bpm num">{info!.bpm}</span></> : null}
              </div>
            );
          })}
        </div>

        <div className="st-tl" ref={viewportRef}>
          <div
            className="st-ruler" role="slider" tabIndex={0} aria-label="Playhead" ref={(el) => { view.slider = el; }}
            aria-valuemin={0} aria-valuemax={Math.round(timeline.duration)} aria-valuenow={Math.floor(view.t)} aria-valuetext={fmtClock(view.t)}
            onPointerDown={onRulerDown} onPointerMove={onRulerMove} onPointerUp={endScrub} onPointerCancel={endScrub} onKeyDown={onRulerKey}
          >
            <canvas ref={(el) => { view.ruler = el; }} aria-hidden="true" />
            <div className="st-layer" ref={layerRef}>
              {loopOn && loopRange ? <span className="st-loop" style={{ "--t": loopRange[0], "--d": loopRange[1] - loopRange[0] } as CSSProperties} /> : null}
            </div>
          </div>

          <div className="st-chips">
            <div className="st-layer" ref={layerRef}>
              {timeline.transitions.map((tr) => (
                <TransitionChip
                  key={tr.key} tr={tr} keyA={keyOf(tr.fromId)} keyB={keyOf(tr.toId)} selected={tr.key === selectedKey}
                  onSelect={setSelectedKey} register={register.chip}
                />
              ))}
            </div>
          </div>

          <div
            className="st-lanes" onPointerDown={onLanesDown} onPointerMove={onLanesMove}
            onPointerUp={onLanesUp} onPointerCancel={onLanesCancel}
          >
            {([0, 1] as const).map((lane) => (
              <div key={lane} className="st-lane" data-lane={lane}>
                <canvas ref={(el) => { view.lanes[lane] = el; }} aria-hidden="true" />
                {loading ? <LaneSkeleton lane={lane} /> : null}
                <div className="st-layer" ref={layerRef}>
                  {loading ? null : timeline.clips.filter((clip) => clip.lane === lane).map((clip) => (
                    <ClipView
                      key={`${clip.index}:${clip.trackId}`} clip={clip} name={names.get(clip.trackId) ?? ""}
                      keyValue={keyOf(clip.trackId)} noWave={!waves.has(clip.trackId)}
                      movable={clip.index > 0} tier={tier} register={register}
                    />
                  ))}
                </div>
              </div>
            ))}
            <div className="st-layer st-xfades" ref={layerRef} aria-hidden="true">
              {timeline.transitions.map((tr) => (
                <TransitionOverlay key={tr.key} tr={tr} selected={tr.key === selectedKey} register={register.overlay} />
              ))}
            </div>
            <div className="st-badge" ref={badgeRef} hidden />
          </div>

          <div className="st-playhead" ref={(el) => { view.playhead = el; }} aria-hidden="true" />
        </div>
      </div>

      <div className="st-transport">
        <div className="st-t-lead">
          <button type="button" className="ui-btn primary" onClick={onBrowseLibrary}><Icon name="plus" />Add tracks</button>
          <button type="button" className="ui-icon-btn" aria-label="Undo" title="Undo order change" disabled={!canUndo} onClick={undo}><Icon name="undo" /></button>
        </div>
        <div className="st-t-mid">
          <button type="button" className="ui-icon-btn" aria-label="Previous transition" title="Previous transition (←)" onClick={() => step(-1)} disabled={loading || !timeline.transitions.length}><Icon name="skipBack" /></button>
          <button type="button" className="st-play" aria-label={playing ? "Pause" : "Play"} title={playing ? "Pause (Space)" : "Play (Space)"} onClick={togglePlay} disabled={loading}>
            <Icon name={playing ? "pause" : "play"} />
          </button>
          <button type="button" className="ui-icon-btn" aria-label="Next transition" title="Next transition (→)" onClick={() => step(1)} disabled={loading || !timeline.transitions.length}><Icon name="skipFwd" /></button>
          <button type="button" className={`ui-icon-btn ${loopOn ? "on st-loop-on" : ""}`} aria-label="Loop transition" aria-pressed={loopOn} title="Loop transition (L)" onClick={toggleLoop} disabled={loading || !timeline.transitions.length}><Icon name="loop" /></button>
        </div>
        <div className="st-t-trail">
          <span className="st-issue" role="status" title={issue ?? undefined}>{issue ? <><Icon name="warning" size={16} /><span>{issue}</span></> : null}</span>
          <div className={`st-bars ${selected && editable ? "" : "off"}`} aria-disabled={!(selected && editable)}>
            <Segmented<string>
              label="Transition length in bars" tone="accent"
              value={String(selected?.bars ?? 16)}
              options={TRANSITION_BARS.map((bars) => ({ value: String(bars), label: String(bars), title: `${bars} bars` }))}
              onChange={(value) => patch({ bars: Number(value) as TransitionBars })}
            />
          </div>
          <span className="st-time num"><span ref={(el) => { view.clock = el; if (el) el.textContent = fmtClock(view.t); }} /><span className="st-total"> / {fmtClock(timeline.duration)}</span></span>
        </div>
      </div>

      <div className="st-panel">
        {selected ? (
          <TransitionPanel
            key={selected.key} tr={selected} prep={getTransition(selected.fromId, selected.toId)} editable={editable}
            analysisA={timeline.clips[selected.fromIndex]?.analysis ?? null} analysisB={timeline.clips[selected.toIndex]?.analysis ?? null}
            onPatch={patch} onPreset={(id) => { if (editable) applyPreset(selected.fromId, selected.toId, id); }}
          />
        ) : (
          <p className="st-panel-idle">
            {loading || timeline.transitions.length ? " " : "Add a second track"}
          </p>
        )}
      </div>
    </div>
  );
}

// ---- timeline pieces --------------------------------------------------------

type Register = {
  title: (index: number, el: HTMLElement | null) => void;
  group: (index: number, el: HTMLElement | null) => void;
  chip: (key: string, el: HTMLElement | null) => void;
  overlay: (key: string, el: HTMLElement | null) => void;
};

const at = (t: number, d?: number) => ({ "--t": t, ...(d === undefined ? {} : { "--d": d }) }) as CSSProperties;

function LaneSkeleton({ lane }: { lane: 0 | 1 }) {
  return <div className="st-skel">{[0, 1, 2].map((i) => <span key={i} className="ui-skel" style={{ left: `${(i * 2 + lane) * 16 + 2}%` }} />)}</div>;
}

const ClipView = memo(function ClipView({ clip, name, keyValue, noWave, movable, tier, register }: {
  clip: StudioClip; name: string; keyValue: string | null; noWave: boolean; movable: boolean; tier: ZoomTier; register: Register;
}) {
  const groupRef = useCallback((el: HTMLElement | null) => register.group(clip.index, el), [register, clip.index]);
  const titleRef = useCallback((el: HTMLElement | null) => register.title(clip.index, el), [register, clip.index]);

  const cues = useMemo(() => {
    const all = (clip.analysis?.cues ?? []).slice().sort((a, b) => a.time - b.time);
    return all.map((cue, i) => ({ cue, n: i + 1 }))
      .filter(({ cue }) => cue.time >= clip.sourceStart && cue.time < clip.sourceEnd)
      .map(({ cue, n }) => ({ n, x: mixTimeOf(clip, cue.time) - clip.start, hot: cue.kind === "hot", title: `${cueLabel(cue)} · ${fmtClock(cue.time)}` }));
  }, [clip]);

  const phrases = useMemo(() => (clip.analysis?.phrases ?? [])
    .filter((p) => p.end > clip.sourceStart && p.start < clip.sourceEnd)
    .map((p) => {
      const a = mixTimeOf(clip, Math.max(p.start, clip.sourceStart)), b = mixTimeOf(clip, Math.min(p.end, clip.sourceEnd));
      return { x: a - clip.start, w: b - a, tone: phraseTone(p.label), label: p.label };
    }), [clip]);

  const bpm = clip.bpm ? fmtBpm(clip.bpm) : null;
  return (
    <div className={`st-clip ${movable ? "movable" : ""}`} style={at(clip.start, clip.end - clip.start)} ref={groupRef}>
      <div className="st-clip-head">
        <span className="st-clip-title" ref={titleRef}>
          <KeyBadge value={keyValue} size="sm" />
          <span className="st-clip-name" title={name}>{name}</span>
          {bpm ? <span className="st-clip-bpm num">{bpm}</span> : null}
        </span>
      </div>
      {tier === "near" ? cues.map((c) => (
        <span key={c.n} className={`st-cue ${c.hot ? "hot" : ""}`} style={{ "--x": c.x } as CSSProperties} title={c.title}><b>{c.n}</b></span>
      )) : null}
      <div className="st-phrases">
        {phrases.map((p, i) => (
          <span key={i} className={`st-ph ph-${p.tone}`} style={{ "--x": p.x, "--w": p.w } as CSSProperties} title={p.label}><span>{p.label}</span></span>
        ))}
      </div>
      {noWave ? <span className="st-nowave">No waveform</span> : null}
    </div>
  );
});

function curvePoints(automation: BandAutomation, side: "out" | "in"): string {
  const points = new Set<number>();
  for (let i = 0; i <= 48; i++) points.add(i / 48);
  const a = clamp(automation.at, 0, 1), half = Math.min(a, 1 - a);
  for (const p of [a - 1e-3, a + 1e-3, a - half, a + half]) points.add(clamp(p, 0, 1));
  return [...points].sort((x, y) => x - y)
    .map((p) => `${(p * 100).toFixed(2)},${((1 - bandGain(automation, p, side)) * 100).toFixed(2)}`).join(" ");
}

const CURVES: (keyof TransitionEq)[] = ["high", "mid", "bass", "volume"];

function Curves({ eq, side }: { eq: TransitionEq; side: "out" | "in" }) {
  return (
    <svg className="st-curves" viewBox="0 0 100 100" preserveAspectRatio="none">
      {CURVES.filter((band) => band === "volume" || eq[band].mode !== "none").map((band) => {
        const points = curvePoints(eq[band], side);
        return <g key={band} className={`c-${band}`}><polyline className="halo" points={points} /><polyline points={points} /></g>;
      })}
    </svg>
  );
}

const TransitionOverlay = memo(function TransitionOverlay({ tr, selected, register }: {
  tr: StudioTransition; selected: boolean; register: (key: string, el: HTMLElement | null) => void;
}) {
  const ref = useCallback((el: HTMLElement | null) => register(tr.key, el), [register, tr.key]);
  const laneA = tr.fromIndex % 2;
  return (
    <div className={`st-xf ${selected ? "on" : ""}`} style={at(tr.t0, tr.t1 - tr.t0)} ref={ref}>
      <div className="st-xf-lane" data-lane={laneA}><Curves eq={tr.mix.eq} side="out" /></div>
      <div className="st-xf-lane" data-lane={1 - laneA}><Curves eq={tr.mix.eq} side="in" /></div>
    </div>
  );
});

const presetName = (tr: StudioTransition) => tr.mix.preset === "custom" ? "Custom" : TRANSITION_PRESETS[tr.mix.preset].label;

const TransitionChip = memo(function TransitionChip({ tr, keyA, keyB, selected, onSelect, register }: {
  tr: StudioTransition; keyA: string | null; keyB: string | null; selected: boolean;
  onSelect: (key: string) => void; register: (key: string, el: HTMLElement | null) => void;
}) {
  const ref = useCallback((el: HTMLElement | null) => register(tr.key, el), [register, tr.key]);
  const a = parseKey(keyA), b = parseKey(keyB);
  const match = compat(a, b);
  const label = `Transition ${tr.index + 1}: ${keyA ?? "unknown key"} to ${keyB ?? "unknown key"}, ${COMPAT_LABEL[match]}, ${presetName(tr)}, ${tr.bars} bars${tr.warnings.length ? `. ${tr.warnings.join(" ")}` : ""}`;
  return (
    <button
      type="button" className={`st-chip ${selected ? "on" : ""}`} style={{ "--c": (tr.t0 + tr.t1) / 2 } as CSSProperties}
      aria-pressed={selected} aria-label={label} title={[COMPAT_LABEL[match], ...tr.warnings].join(". ")}
      onClick={() => onSelect(tr.key)} ref={ref}
    >
      <span className="st-chip-n num">{tr.index + 1}</span>
      <span className="st-chip-keys">
        <span className="k" style={{ color: keyColor(a) }}>{a ? `${a.num}${a.letter}` : "—"}</span>
        <StudioIcon name="arrow" size={14} style={{ color: COMPAT_TONE[match] }} />
        <span className="k" style={{ color: keyColor(b) }}>{b ? `${b.num}${b.letter}` : "—"}</span>
      </span>
      <span className="st-chip-more">{presetName(tr)} · {tr.bars}</span>
      {tr.warnings.length ? <Icon name="warning" size={14} className="st-chip-warn" /> : null}
    </button>
  );
});

// ---- transition panel -------------------------------------------------------

/** A vertical single-choice list with roving focus (arrow keys move and choose). */
function RadioList<T extends string>({ label, value, options, onChange, disabled, extra }: {
  label: string; value: T; options: { value: T; label: string }[]; onChange: (value: T) => void; disabled?: boolean;
  extra?: (value: T) => ReactNode;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: ReactKeyboardEvent, index: number) => {
    const delta = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 0;
    if (!delta) return;
    e.preventDefault();
    e.stopPropagation();
    const next = (index + delta + options.length) % options.length;
    onChange(options[next]!.value);
    refs.current[next]?.focus();
  };
  const current = options.some((o) => o.value === value) ? value : options[0]?.value;
  return (
    <div className="st-radios" role="radiogroup" aria-label={label} aria-disabled={disabled || undefined}>
      {options.map((option, i) => {
        const on = option.value === value;
        return (
          <div key={option.value} className={`st-radio ${on ? "on" : ""}`}>
            <button
              type="button" role="radio" aria-checked={on} tabIndex={option.value === current ? 0 : -1} disabled={disabled}
              ref={(el) => { refs.current[i] = el; }} onClick={() => onChange(option.value)} onKeyDown={(e) => onKey(e, i)}
            >{option.label}</button>
            {on && extra ? extra(option.value) : null}
          </div>
        );
      })}
    </div>
  );
}

function PercentField({ label, value, onChange, disabled }: { label: string; value: number; onChange: (value: number) => void; disabled?: boolean }) {
  return (
    <label className="st-pct">
      <input
        type="number" inputMode="numeric" min={0} max={100} step={5} value={Math.round(value * 100)} aria-label={label} disabled={disabled}
        onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n)) onChange(clamp(n, 0, 100) / 100); }}
      />
      <span aria-hidden="true">%</span>
    </label>
  );
}

function MixPointSelect({ label, point, stored, options, onChange, disabled }: {
  label: string; point: StudioTransition["mixOut"]; stored: TransitionPrep["mixOut"]; options: PointOption[];
  onChange: (option: PointOption | null) => void; disabled?: boolean;
}) {
  const id = `st-${label.replace(/\s+/g, "-").toLowerCase()}`;
  const list = stored && !options.some((o) => Math.abs(o.time - stored.time) < 0.05)
    ? [...options, { time: stored.time, label: stored.label, kind: stored.kind, text: `${stored.label} · ${fmtClock(stored.time)}` }].sort((a, b) => a.time - b.time)
    : options;
  const index = stored ? list.findIndex((o) => Math.abs(o.time - stored.time) < 0.05) : -1;
  return (
    <div className="st-field">
      <label className="st-col-label" htmlFor={id}>{label}</label>
      <select
        id={id} className="ui-select sm" value={index < 0 ? "auto" : String(index)} disabled={disabled}
        onChange={(e) => onChange(e.target.value === "auto" ? null : list[Number(e.target.value)] ?? null)}
      >
        <option value="auto">Auto · {point.auto ? `${point.label} · ${fmtClock(point.time)}` : "suggested"}</option>
        {list.map((option, i) => <option key={`${option.time}-${i}`} value={String(i)}>{option.text}</option>)}
      </select>
    </div>
  );
}

function TransitionPanel({ tr, prep, editable, analysisA, analysisB, onPatch, onPreset }: {
  tr: StudioTransition; prep: TransitionPrep; editable: boolean;
  analysisA: StudioAnalysis | null; analysisB: StudioAnalysis | null;
  onPatch: (patch: TransitionPatch) => void; onPreset: (id: BuiltInPresetId) => void;
}) {
  const optionsA = useMemo(() => pointOptions(analysisA), [analysisA]);
  const optionsB = useMemo(() => pointOptions(analysisB), [analysisB]);
  const eq = tr.mix.eq;
  const presetOptions = PRESET_ORDER.map((id) => ({ value: id as BuiltInPresetId | "custom", label: TRANSITION_PRESETS[id].label }));
  const setBand = (band: keyof TransitionEq, next: Partial<BandAutomation>) =>
    onPatch({ eq: { [band]: { ...eq[band], ...next } } as Partial<TransitionEq> });
  const nudge = (beats: number) => onPatch({ offsetBeats: tr.offsetBeats + beats });
  const disabled = !editable;

  return (
    <div className="st-cols">
      <section className="st-col" aria-labelledby="st-presets">
        <h2 id="st-presets" className="st-col-title">Presets{tr.mix.preset === "custom" ? <span className="ui-tag">Custom</span> : null}</h2>
        <RadioList<BuiltInPresetId | "custom">
          label="Presets" value={tr.mix.preset} options={presetOptions} disabled={disabled}
          onChange={(value) => { if (value !== "custom") onPreset(value); }}
        />
      </section>

      {BANDS.map((band) => (
        <section key={band.key} className="st-col" aria-labelledby={`st-band-${band.key}`}>
          <h2 id={`st-band-${band.key}`} className="st-col-title">{band.label}</h2>
          <RadioList<BandMode>
            label={band.label} value={eq[band.key].mode} options={MODES} disabled={disabled}
            onChange={(mode) => setBand(band.key, { mode, at: mode === "swap" || mode === "crossfade" ? (eq[band.key].mode === mode ? eq[band.key].at : 0.5) : eq[band.key].at })}
            extra={(mode) => mode === "swap" || mode === "crossfade"
              ? <PercentField label={`${band.label} ${mode} position`} value={eq[band.key].at} disabled={disabled} onChange={(value) => setBand(band.key, { at: value })} />
              : null}
          />
        </section>
      ))}

      <section className="st-col st-col-points" aria-label="Mix points">
        <MixPointSelect
          label="Leave A at" point={tr.mixOut} stored={prep.mixOut ?? null} options={optionsA} disabled={disabled}
          onChange={(option) => onPatch({ mixOut: option ? { time: option.time, label: option.label, kind: option.kind } : null })}
        />
        <MixPointSelect
          label="Start B at" point={tr.mixIn} stored={prep.mixIn ?? null} options={optionsB} disabled={disabled}
          onChange={(option) => onPatch({ mixIn: option ? { time: option.time, label: option.label, kind: option.kind } : null })}
        />
        <div className="st-field">
          <div className="st-label-row">
            <span className="st-col-label" id="st-nudge">Nudge B</span>
            <output className="st-offset num" aria-live="polite">{fmtOffset(tr.offsetBeats)}</output>
          </div>
          <div className="st-nudge" role="group" aria-labelledby="st-nudge">
            <button type="button" className="ui-btn sm" onClick={() => nudge(-4)} disabled={disabled}>−1 bar</button>
            <button type="button" className="ui-btn sm" onClick={() => nudge(-1)} disabled={disabled}>−1 beat</button>
            <button type="button" className="ui-btn sm" onClick={() => nudge(1)} disabled={disabled}>+1 beat</button>
            <button type="button" className="ui-btn sm" onClick={() => nudge(4)} disabled={disabled}>+1 bar</button>
          </div>
        </div>
      </section>

      <section className="st-col st-col-notes" aria-label="Rehearsal">
        <div className="st-field">
          <span className="st-col-label">Rehearsal</span>
          <Segmented<RehearsalState>
            label="Rehearsal" value={rehearsalOf(prep)} options={REHEARSAL}
            onChange={(rehearsal) => onPatch({ rehearsal })}
          />
        </div>
        <div className="st-field st-grow">
          <label className="st-col-label" htmlFor="st-notes">Notes</label>
          <textarea id="st-notes" className="ui-textarea" value={prep.notes} disabled={disabled} onChange={(e) => onPatch({ notes: e.target.value })} />
        </div>
      </section>
    </div>
  );
}
