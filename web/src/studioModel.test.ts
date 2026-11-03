import { describe, expect, test } from "bun:test";
import { transitionKey, type TransitionPrep } from "./setStore";
import {
  bandGain, bandGains, buildTimeline, clipGainsAt, cueLabel, defaultMixIn, defaultMixOut, echoSendAt, fmtClock, gainToDb,
  matchRate, mixTimeOf, phraseTone, pointOptions, rateAt, snapToBeat, soundingAt, sourceAt, transitionAt,
  GLIDE_BEATS, KILL_DB, type StudioAnalysis, type StudioTrackInput,
} from "./studioModel";

/** A steady grid from `first` to `duration`, bar numbers 1..4. */
function grid(bpm: number, duration: number, first = 0) {
  const beat = 60 / bpm, beats = [];
  for (let i = 0; first + i * beat < duration; i++) beats.push({ time: first + i * beat, beat: (i % 4) + 1, bpm });
  return beats;
}

/** A track with intro / body / outro phrases on bar boundaries and a first-beat cue. */
function track(id: number, bpm: number, bars: number, outroBars = 16): StudioTrackInput {
  const bar = 4 * 60 / bpm, duration = bars * bar;
  const analysis: StudioAnalysis = {
    duration,
    beats: grid(bpm, duration),
    phrases: [
      { start: 0, end: 16 * bar, label: "Intro 1" },
      { start: 16 * bar, end: (bars - outroBars) * bar, label: "Chorus 1" },
      { start: (bars - outroBars) * bar, end: duration, label: "Outro 1" },
    ],
    cues: [{ time: 0, label: "CUE(Auto)", kind: "memory", index: null }],
    anchors: [
      { time: 0, label: "CUE(Auto)", reason: "", kind: "cue" },
      { time: 16 * bar, label: "Chorus 1", reason: "", kind: "phrase" },
      { time: (bars - outroBars) * bar, label: "Outro 1", reason: "", kind: "phrase" },
    ],
  };
  return { id, duration, bpm, analysis };
}

const close = (value: number, expected: number, digits = 6) => expect(value).toBeCloseTo(expected, digits);

describe("timeline layout", () => {
  const a = track(1, 128, 96), b = track(2, 126, 96);
  const tl = buildTimeline([a, b], {});
  const [ca, cb] = tl.clips;
  const tr = tl.transitions[0]!;

  test("A starts at zero and leaves at its outro; the window is 16 bars at A's tempo", () => {
    expect(ca!.start).toBe(0);
    expect(tr.mixOut.label).toBe("Outro 1");
    expect(tr.mixOut.auto).toBe(true);
    close(tr.t0, 80 * 4 * 60 / 128);
    close(tr.t1 - tr.t0, 16 * 4 * 60 / 128);
    close(ca!.end, tr.t1);
    close(cb!.start, tr.t0);
  });

  test("B enters on its first cue, stretched onto A's grid", () => {
    expect(tr.mixIn.time).toBe(0);
    close(tr.rateIn, 128 / 126);
    expect(tr.tempoMatched).toBe(true);
    // Every A beat in the window lands on a B beat.
    for (let k = 0; k <= 64; k += 7) {
      const t = tr.t0 + k * tr.beat;
      close(sourceAt(cb!, t), k * 60 / 126, 6);
      close(sourceAt(ca!, t), tr.exitAt + k * 60 / 128, 6);
    }
  });

  test("B glides back to its own tempo over 8 bars, continuously", () => {
    const rate = 128 / 126;
    const glideLength = 2 * GLIDE_BEATS * (60 / 126) / (rate + 1);
    close(rateAt(cb!, tr.t1 - 1e-6), rate);
    close(rateAt(cb!, tr.t1 + glideLength / 2), (rate + 1) / 2);
    close(rateAt(cb!, tr.t1 + glideLength + 1), 1);
    // The glide covers exactly 8 bars of B's audio.
    close(sourceAt(cb!, tr.t1 + glideLength) - sourceAt(cb!, tr.t1), GLIDE_BEATS * 60 / 126);
    // No jumps at segment seams.
    for (const t of [tr.t1, tr.t1 + glideLength]) close(sourceAt(cb!, t - 1e-7), sourceAt(cb!, t + 1e-7), 5);
  });

  test("mix time and source time round-trip through the glide", () => {
    for (const s of [1, 40, 70, 100, 150]) close(sourceAt(cb!, mixTimeOf(cb!, s)), s, 6);
  });

  test("the last track plays to its end", () => {
    close(sourceAt(cb!, cb!.end), b.duration, 5);
    close(tl.duration, cb!.end);
  });

  test("tracks alternate lanes", () => {
    const three = buildTimeline([a, b, track(3, 128, 96)], {});
    expect(three.clips.map((clip) => clip.lane)).toEqual([0, 1, 0]);
  });
});

describe("mix points and nudges", () => {
  const a = track(1, 128, 96), b = track(2, 128, 96);
  const key = transitionKey(1, 2);
  const beat = 60 / 128;

  test("a positive nudge moves B later and A plays that much longer", () => {
    const base = buildTimeline([a, b], {}).transitions[0]!;
    const nudged = buildTimeline([a, b], { [key]: { notes: "", practiced: false, offsetBeats: 4 } }).transitions[0]!;
    close(nudged.t0 - base.t0, 4 * beat);
    close(nudged.exitAt - base.exitAt, 4 * beat);
    expect(nudged.mixIn.time).toBe(base.mixIn.time);
  });

  test("drag previews override the stored offset", () => {
    const preview = buildTimeline([a, b], {}, { offsets: { [key]: -2 } }).transitions[0]!;
    expect(preview.offsetBeats).toBe(-2);
  });

  test("chosen mix points snap to the beat grid", () => {
    const prep: TransitionPrep = { notes: "", practiced: false, mixOut: { time: 120.03, label: "Hot cue C", kind: "cue" }, mixIn: { time: 30.2, label: "Drop", kind: "cue" } };
    const tr = buildTimeline([a, b], { [key]: prep }).transitions[0]!;
    close(tr.mixOut.time, snapToBeat(a.analysis!.beats, 120.03));
    expect(Math.abs(tr.mixOut.time - 120.03)).toBeLessThan(beat / 2);
    expect(tr.mixOut.auto).toBe(false);
    close(tr.mixIn.time, 30); // 64 beats in; 30.47 is the next beat
    expect(tr.mixIn.label).toBe("Drop");
  });

  test("bars follow the transition and default to the preset's 16", () => {
    const eight = buildTimeline([a, b], { [key]: { notes: "", practiced: false, bars: 8 } }).transitions[0]!;
    close(eight.t1 - eight.t0, 8 * 4 * beat);
    expect(buildTimeline([a, b], {}).transitions[0]!.bars).toBe(16);
  });

  test("a leave point inside the previous window is pushed after it", () => {
    const c = track(3, 128, 96);
    const prep: TransitionPrep = { notes: "", practiced: false, mixOut: { time: 2, label: "Too early", kind: "cue" } };
    const tl = buildTimeline([a, b, c], { [transitionKey(2, 3)]: prep });
    const [first, second] = tl.transitions;
    expect(second!.t0).toBeGreaterThanOrEqual(first!.t1 - 1e-6);
    expect(second!.warnings.length).toBeGreaterThan(0);
    // Never more than two tracks at once.
    for (let t = 0; t < tl.duration; t += 0.5) expect(soundingAt(tl, t).length).toBeLessThanOrEqual(2);
  });

  test("default leave point falls back when the outro is too short for the window", () => {
    const short = track(9, 128, 96, 8); // 8-bar outro can't hold a 16-bar window
    const out = defaultMixOut(short, 16, 0);
    expect(out.auto).toBe(true);
    expect(out.time).toBeLessThanOrEqual(short.duration - 15 * 4 * beat + 1e-6);
  });

  test("default entry is the first saved cue, else the first downbeat", () => {
    expect(defaultMixIn(track(4, 128, 64)).kind).toBe("cue");
    const bare = track(5, 128, 64);
    bare.analysis = { ...bare.analysis!, cues: [], beats: grid(128, bare.duration, 0.3).map((b, i) => ({ ...b, beat: ((i + 2) % 4) + 1 })) };
    const point = defaultMixIn(bare);
    expect(point.kind).toBe("grid");
    expect(bare.analysis.beats.find((x) => x.time === point.time)?.beat).toBe(1);
  });
});

describe("tracks without analysis", () => {
  test("still get a clip; B plays at its own speed when a tempo is unknown", () => {
    const tl = buildTimeline([
      { id: 1, duration: 200, bpm: null, analysis: null },
      { id: 2, duration: 180, bpm: 128, analysis: null },
    ], {});
    expect(tl.clips).toHaveLength(2);
    const tr = tl.transitions[0]!;
    expect(tr.tempoMatched).toBe(false);
    expect(tr.rateIn).toBe(1);
    close(tr.t1 - tr.t0, 16 * 4 * 0.5);
    expect(tr.t0).toBeLessThan(200);
  });

  test("tracks with no length are left out and an empty set is empty", () => {
    expect(buildTimeline([{ id: 1, duration: 0, bpm: 120, analysis: null }], {}).clips).toHaveLength(0);
    expect(buildTimeline([], {}).duration).toBe(0);
  });
});

describe("tempo matching", () => {
  test("considers half and double time", () => {
    close(matchRate(174, 87), 1);
    close(matchRate(140, 70), 1);
    close(matchRate(128, 126), 128 / 126);
  });
});

describe("lookups", () => {
  const tl = buildTimeline([track(1, 128, 96), track(2, 128, 96)], {});
  const tr = tl.transitions[0]!;

  test("one track before the window, two inside, one after", () => {
    expect(soundingAt(tl, tr.t0 - 1).map((s) => s.clip.trackId)).toEqual([1]);
    expect(soundingAt(tl, (tr.t0 + tr.t1) / 2).map((s) => s.clip.trackId)).toEqual([1, 2]);
    expect(soundingAt(tl, tr.t1 + 1).map((s) => s.clip.trackId)).toEqual([2]);
    expect(transitionAt(tl, tr.t0 + 0.1)?.key).toBe(tr.key);
    expect(transitionAt(tl, tr.t1 + 0.1)).toBeNull();
  });

  test("clip gains: full outside the window, preset curves inside, silent outside the clip", () => {
    expect(clipGainsAt(tl, 0, 1)).toEqual({ volume: 1, bass: 1, mid: 1, high: 1 });
    const mid = clipGainsAt(tl, 0, (tr.t0 + tr.t1) / 2);
    close(mid.volume, Math.SQRT1_2);
    expect(clipGainsAt(tl, 1, tr.t0 - 1).volume).toBe(0);
  });
});

describe("band gains", () => {
  test("crossfade is equal-power and spans the window at 50%", () => {
    const eq = { mode: "crossfade" as const, at: 0.5 };
    for (const p of [0, 0.2, 0.5, 0.8, 1]) close(bandGain(eq, p, "out") ** 2 + bandGain(eq, p, "in") ** 2, 1);
    close(bandGain(eq, 0, "out"), 1);
    close(bandGain(eq, 0, "in"), 0);
    close(bandGain(eq, 1, "in"), 1);
    close(bandGain(eq, 0.5, "out"), Math.SQRT1_2);
  });

  test("crossfade centred at 25% runs over the first half", () => {
    const eq = { mode: "crossfade" as const, at: 0.25 };
    close(bandGain(eq, 0.5, "out"), 0);
    close(bandGain(eq, 0.5, "in"), 1);
    close(bandGain(eq, 0.25, "in"), Math.SQRT1_2);
  });

  test("swap is a hard switch at its position", () => {
    const eq = { mode: "swap" as const, at: 0.5 };
    expect([bandGain(eq, 0.49, "out"), bandGain(eq, 0.49, "in")]).toEqual([1, 0]);
    expect([bandGain(eq, 0.51, "out"), bandGain(eq, 0.51, "in")]).toEqual([0, 1]);
  });

  test("fades are linear on their own side; none keeps both full", () => {
    close(bandGain({ mode: "fade-out", at: 0 }, 0.25, "out"), 0.75);
    expect(bandGain({ mode: "fade-out", at: 0 }, 0.25, "in")).toBe(1);
    close(bandGain({ mode: "fade-in", at: 0 }, 0.25, "in"), 0.25);
    expect(bandGain({ mode: "fade-in", at: 0 }, 0.25, "out")).toBe(1);
    expect(bandGains({ volume: { mode: "none", at: 0 }, bass: { mode: "none", at: 0 }, mid: { mode: "none", at: 0 }, high: { mode: "none", at: 0 } }, 0.9, "out"))
      .toEqual({ volume: 1, bass: 1, mid: 1, high: 1 });
  });

  test("bass swap preset kills A's bass after the halfway point", () => {
    const prep: TransitionPrep = { notes: "", practiced: false, preset: "bass-swap" };
    const a = track(1, 128, 96), b = track(2, 128, 96);
    const tl = buildTimeline([a, b], { [transitionKey(1, 2)]: prep });
    const tr = tl.transitions[0]!;
    const late = tr.t0 + 0.75 * (tr.t1 - tr.t0);
    expect(clipGainsAt(tl, 0, late).bass).toBe(0);
    expect(clipGainsAt(tl, 1, late).bass).toBe(1);
    expect(gainToDb(0)).toBe(KILL_DB);
    expect(gainToDb(1)).toBe(0);
  });

  test("echo send ramps across an echo-out window only", () => {
    const prep: TransitionPrep = { notes: "", practiced: false, preset: "echo-out", fx: "echo", bars: 4 };
    const tl = buildTimeline([track(1, 128, 96), track(2, 128, 96)], { [transitionKey(1, 2)]: prep });
    const tr = tl.transitions[0]!;
    close(echoSendAt(tl, 0, (tr.t0 + tr.t1) / 2), 0.5);
    expect(echoSendAt(tl, 0, tr.t0 - 1)).toBe(0);
    expect(echoSendAt(tl, 1, (tr.t0 + tr.t1) / 2)).toBe(0);
  });
});

describe("labels", () => {
  test("cue names are human", () => {
    expect(cueLabel({ time: 0, label: "CUE(Auto)", kind: "memory", index: null })).toBe("Memory cue");
    expect(cueLabel({ time: 0, label: "", kind: "hot", index: 3 })).toBe("Hot cue C");
    expect(cueLabel({ time: 0, label: "Drop", kind: "hot", index: 1 })).toBe("Drop");
  });

  test("point options read like 'Outro 1 · 2:30', never fractional seconds", () => {
    const options = pointOptions(track(1, 128, 96).analysis);
    expect(options.map((o) => o.text)).toEqual(["Intro 1 · 0:00", "Chorus 1 · 0:30", "Outro 1 · 2:30"]);
    expect(fmtClock(3725.9)).toBe("1:02:05");
  });

  test("phrase labels map to colour roles", () => {
    expect(phraseTone("Outro 2")).toBe("outro");
    expect(phraseTone("Up 3")).toBe("up");
    expect(phraseTone("Unclassified phrase")).toBe("other");
  });
});
