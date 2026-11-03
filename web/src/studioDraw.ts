/**
 * Canvas drawing for the Studio timeline: the time ruler and each deck lane
 * (clip bodies, rekordbox-style 3-band waveforms, beat and bar lines).
 * Redrawn on zoom, scroll, drag and data changes only, never per playhead frame.
 */
import { mixTimeOf, nearestBeatIndex, sourceAt, fmtClock, type StudioClip, type StudioTimeline } from "./studioModel";

/** Vertical layout of a lane, shared with studio.css through custom properties. */
export const LANE = { pad: 6, head: 26, phrase: 16 } as const;

export type WaveData = {
  bands: { rate: number; low: number[]; mid: number[]; high: number[] } | null;
  mono: { samples: number[]; max: number } | null;
};

export type Palette = {
  low: string; mid: string; high: string; mono: string;
  clip: string; grid: string; beat: string; bar: string;
  tick: string; label: string;
};

const TOKENS: Record<keyof Palette, string> = {
  low: "--wave-low", mid: "--wave-mid", high: "--wave-high", mono: "--wave-mono",
  clip: "--st-clip", grid: "--line", beat: "--line", bar: "--line-strong",
  tick: "--line-strong", label: "--text-3",
};

/**
 * Resolve design tokens to plain rgba() strings. Custom properties can hold
 * oklch() or color-mix(); painting each once into a 1×1 canvas gives a value
 * every canvas implementation accepts.
 */
export function readPalette(scope: HTMLElement): Palette {
  const probe = document.createElement("span");
  probe.style.display = "none";
  scope.appendChild(probe);
  const pixel = document.createElement("canvas");
  pixel.width = pixel.height = 1;
  const ctx = pixel.getContext("2d", { willReadFrequently: true });
  const resolve = (token: string) => {
    probe.style.color = `var(${token})`;
    const computed = getComputedStyle(probe).color;
    if (!ctx) return computed;
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = computed;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    return `rgba(${r}, ${g}, ${b}, ${((a ?? 255) / 255).toFixed(3)})`;
  };
  const palette = Object.fromEntries(Object.entries(TOKENS).map(([name, token]) => [name, resolve(token)])) as Palette;
  probe.remove();
  return palette;
}

/** Ruler step (seconds) that keeps labels at least ~80px apart. */
export function rulerStep(pps: number): { major: number; minor: number } {
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
  const major = steps.find((step) => step * pps >= 80) ?? 3600;
  const minor = major >= 60 ? major / 4 : major >= 10 ? major / 5 : major / 2;
  return { major, minor };
}

function prepare(canvas: HTMLCanvasElement, width: number, height: number) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(width * dpr)), h = Math.max(1, Math.round(height * dpr));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return ctx;
}

export function drawRuler(canvas: HTMLCanvasElement, width: number, height: number, pps: number, sx: number, duration: number, palette: Palette, font: string) {
  const ctx = prepare(canvas, width, height);
  if (!ctx || pps <= 0) return;
  const { major, minor } = rulerStep(pps);
  const first = Math.max(0, Math.floor(sx / pps / minor) * minor);
  const last = Math.min(duration + major, (sx + width) / pps);
  ctx.font = font;
  ctx.textBaseline = "top";
  for (let t = first; t <= last + 1e-9; t += minor) {
    const x = Math.round(t * pps - sx) + 0.5;
    const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6;
    ctx.fillStyle = palette.tick;
    const tick = isMajor ? 10 : 5;
    ctx.fillRect(x - 0.5, height - tick, 1, tick);
    if (isMajor) {
      ctx.fillStyle = palette.label;
      ctx.fillText(fmtClock(t), x + 4, 7);
    }
  }
}

type LaneArgs = {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  lane: 0 | 1;
  timeline: StudioTimeline;
  waves: ReadonlyMap<number, WaveData>;
  pps: number;
  sx: number;
  palette: Palette;
  /** A clip being dragged, drawn this many px off its place. */
  shift?: { clipIndex: number; px: number } | null;
};

export function drawLane({ canvas, width, height, lane, timeline, waves, pps, sx, palette, shift }: LaneArgs) {
  const ctx = prepare(canvas, width, height);
  if (!ctx || pps <= 0) return;

  // Time grid across the whole lane, in step with the ruler's labels.
  const { major } = rulerStep(pps);
  ctx.fillStyle = palette.grid;
  for (let t = Math.max(0, Math.floor(sx / pps / major) * major); t * pps - sx <= width; t += major) {
    ctx.fillRect(Math.round(t * pps - sx), 0, 1, height);
  }

  for (const clip of timeline.clips) {
    if (clip.lane !== lane) continue;
    const dx = shift && shift.clipIndex === clip.index ? shift.px : 0;
    const x0 = clip.start * pps - sx + dx, x1 = clip.end * pps - sx + dx;
    if (x1 < 0 || x0 > width) continue;
    drawClip(ctx, clip, waves.get(clip.trackId) ?? null, { x0, x1, dx, width, height, pps, sx, palette });
  }
}

type ClipFrame = { x0: number; x1: number; dx: number; width: number; height: number; pps: number; sx: number; palette: Palette };

function drawClip(ctx: CanvasRenderingContext2D, clip: StudioClip, wave: WaveData | null, f: ClipFrame) {
  const { x0, x1, dx, width, height, pps, sx, palette } = f;
  const top = LANE.pad, bottom = height - LANE.pad;
  ctx.fillStyle = palette.clip;
  ctx.beginPath();
  ctx.roundRect(x0, top, x1 - x0, bottom - top, 6);
  ctx.fill();

  const bandTop = top + LANE.head, bandBottom = bottom - LANE.phrase;
  const centre = (bandTop + bandBottom) / 2, half = Math.max(0, (bandBottom - bandTop) / 2 - 3);
  const from = Math.max(0, Math.ceil(x0)), to = Math.min(width, Math.floor(x1));
  const mixAt = (px: number) => (px + sx - dx) / pps;

  if (wave?.bands && half > 0) {
    const { rate, low, mid, high } = wave.bands;
    const n = low.length;
    const peaks = [new Float32Array(to - from), new Float32Array(to - from), new Float32Array(to - from)];
    for (let px = from; px < to; px++) {
      const s0 = sourceAt(clip, mixAt(px)), s1 = sourceAt(clip, mixAt(px + 1));
      let i0 = Math.floor(s0 * rate), i1 = Math.ceil(s1 * rate);
      if (i1 <= i0) i1 = i0 + 1;
      i0 = Math.max(0, i0); i1 = Math.min(n, i1);
      let l = 0, m = 0, h = 0;
      for (let i = i0; i < i1; i++) {
        if (low[i]! > l) l = low[i]!;
        if (mid[i]! > m) m = mid[i]!;
        if (high[i]! > h) h = high[i]!;
      }
      peaks[0]![px - from] = l / 100; peaks[1]![px - from] = m / 100; peaks[2]![px - from] = h / 100;
    }
    // Low widest at the back, mids over it, highs on top: rekordbox's 3-band look.
    [palette.low, palette.mid, palette.high].forEach((colour, band) => {
      ctx.fillStyle = colour;
      const values = peaks[band]!;
      for (let i = 0; i < values.length; i++) {
        const v = values[i]! * half;
        if (v > 0.25) ctx.fillRect(from + i, centre - v, 1, v * 2);
      }
    });
  } else if (wave?.mono && half > 0) {
    const { samples, max } = wave.mono;
    const perSecond = samples.length / Math.max(1e-6, clip.duration);
    ctx.fillStyle = palette.mono;
    for (let px = from; px < to; px++) {
      const s0 = sourceAt(clip, mixAt(px)), s1 = sourceAt(clip, mixAt(px + 1));
      let i0 = Math.max(0, Math.floor(s0 * perSecond)), i1 = Math.min(samples.length, Math.ceil(s1 * perSecond));
      if (i1 <= i0) i1 = Math.min(samples.length, i0 + 1);
      let peak = 0;
      for (let i = i0; i < i1; i++) if (samples[i]! > peak) peak = samples[i]!;
      const v = (peak / max) * half;
      if (v > 0.25) ctx.fillRect(px, centre - v, 1, v * 2);
    }
  }

  drawBeatGrid(ctx, clip, { from, to, bandTop, bandBottom, dx, pps, sx, palette });
}

function drawBeatGrid(ctx: CanvasRenderingContext2D, clip: StudioClip,
  g: { from: number; to: number; bandTop: number; bandBottom: number; dx: number; pps: number; sx: number; palette: Palette }) {
  const beats = clip.analysis?.beats;
  if (!beats?.length || g.to <= g.from) return;
  const bpm = clip.bpm ?? beats[0]!.bpm;
  if (!bpm) return;
  const beatPx = (60 / bpm) * g.pps;
  const showBeats = beatPx >= 10, showBars = beatPx * 4 >= 14;
  if (!showBars) return;
  const sFrom = Math.max(clip.sourceStart, sourceAt(clip, (g.from + g.sx - g.dx) / g.pps));
  let i = Math.max(0, nearestBeatIndex(beats, sFrom) - 1);
  for (; i < beats.length; i++) {
    const beat = beats[i]!;
    if (beat.time < clip.sourceStart) continue;
    if (beat.time > clip.sourceEnd) break;
    const x = mixTimeOf(clip, beat.time) * g.pps - g.sx + g.dx;
    if (x > g.to) break;
    if (x < g.from) continue;
    const isBar = beat.beat === 1;
    if (!isBar && !showBeats) continue;
    ctx.fillStyle = isBar ? g.palette.bar : g.palette.beat;
    ctx.fillRect(Math.round(x), g.bandTop, 1, g.bandBottom - g.bandTop);
  }
}
