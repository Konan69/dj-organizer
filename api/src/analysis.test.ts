import { describe, expect, test } from "bun:test";
import {
  summarizeAnalysis,
  type AnalysisCue,
  type RawAnalysis,
} from "./analysis-summary";

const raw = (overrides: Partial<RawAnalysis> = {}): RawAnalysis => ({
  status: "ready",
  source: "rekordbox",
  beats: [
    { time: 0.035, beat: 1, bpm: 128 },
    { time: 0.504, beat: 2, bpm: 128 },
  ],
  phrases: [
    { start: 0.035, end: 15.035, label: "Intro 2", kind: 1, mood: 1 },
    { start: 15.035, end: 30.035, label: "Chorus 2", kind: 5, mood: 1 },
    { start: 30.035, end: 45.035, label: "Down 1", kind: 3, mood: 1 },
  ],
  waveform: { samples: [1, 4, 2], source: "PWAV" },
  bands: null,
  issues: [],
  observedAt: 1_700_000_000,
  ...overrides,
});

const cue = (overrides: Partial<AnalysisCue> = {}): AnalysisCue => ({
  id: "cue-a",
  time: 15.035,
  endTime: null,
  kind: "hot",
  index: 1,
  label: "A",
  comment: "Bring in the bass here",
  ...overrides,
});

describe("Rekordbox analysis summary", () => {
  test("preserves native cue timestamps and prefers cues over nearby phrase anchors", () => {
    const result = summarizeAnalysis(raw(), [
      cue({ id: "later", time: 30.4, label: "B", comment: null }),
      cue(),
    ], 60);

    expect(result.cues.map(({ id, time }) => ({ id, time }))).toEqual([
      { id: "cue-a", time: 15.035 },
      { id: "later", time: 30.4 },
    ]);
    expect(result.anchors).toEqual([
      {
        time: 0.035,
        label: "Intro 2",
        reason: "Rekordbox phrase boundary — listen before choosing a mix point",
        kind: "phrase",
      },
      { time: 15.035, label: "A", reason: "Bring in the bass here", kind: "cue" },
      { time: 30.4, label: "B", reason: "Saved Rekordbox hot cue", kind: "cue" },
    ]);
  });

  test("preserves PSSI labels and raw kind/mood instead of relabeling sections", () => {
    const result = summarizeAnalysis(raw(), [], 60);

    expect(result.phrases).toEqual(raw().phrases);
    expect(result.anchors.map((anchor) => anchor.label)).toEqual([
      "Intro 2", "Chorus 2", "Down 1",
    ]);
    expect(result.anchors.some((anchor) => /drop|strongest|energy/i.test(
      `${anchor.label} ${anchor.reason}`,
    ))).toBe(false);
  });

  test("does not manufacture energy or strongest-section claims from waveform samples", () => {
    const result = summarizeAnalysis(raw(), [], 60);
    const serialized = JSON.stringify(result);

    expect(result.waveform).toEqual({ samples: [1, 4, 2], source: "PWAV" });
    expect(serialized).not.toContain('"energy"');
    expect(serialized).not.toContain('"strongest"');
  });

  test("drops invalid evidence, clips phrase ends, and reports rejected cues", () => {
    const source = raw({
      beats: [
        { time: -1, beat: 1, bpm: 120 },
        { time: Number.NaN, beat: 2, bpm: 120 },
        { time: 9, beat: 3, bpm: 120 },
        { time: 10, beat: 4, bpm: 120 },
      ],
      phrases: [
        { start: 2, end: 20, label: "Outro 1", kind: 6, mood: 1 },
        { start: 8, end: 8, label: "invalid", kind: 99, mood: 1 },
      ],
      issues: ["PSSI was partially decoded."],
    });
    const result = summarizeAnalysis(source, [
      cue({ id: "good", time: 3 }),
      cue({ id: "at-end", time: 10 }),
      cue({ id: "negative", time: -0.1 }),
      cue({ id: "nan", time: Number.NaN }),
    ], 10);

    expect(result.beats).toEqual([{ time: 9, beat: 3, bpm: 120 }]);
    expect(result.phrases).toEqual([
      { start: 2, end: 10, label: "Outro 1", kind: 6, mood: 1 },
    ]);
    expect(result.cues.map((item) => item.id)).toEqual(["good"]);
    expect(result.issues).toEqual([
      "PSSI was partially decoded.",
      "Some saved cues are outside this audio file's duration.",
    ]);
  });

  test("passes PWV7 band rates through and places PWV6 previews by duration", () => {
    const columns = { low: [100, 0], mid: [50, 0], high: [0, 25] };
    expect(summarizeAnalysis(raw({ bands: { rate: 25, ...columns } }), [], 60).bands)
      .toEqual({ rate: 25, ...columns });
    expect(summarizeAnalysis(raw({ bands: { rate: null, ...columns } }), [], 80).bands)
      .toEqual({ rate: 2 / 80, ...columns });
    // Without a duration a whole-track preview cannot be placed in time.
    expect(summarizeAnalysis(raw({ bands: { rate: null, ...columns } }), [], 0).bands).toBeNull();
    expect(summarizeAnalysis(raw(), [], 60).bands).toBeNull();
  });

  test("uses valid saved cues as partial evidence when analysis files are missing", () => {
    const result = summarizeAnalysis(raw({
      status: "missing", beats: [], phrases: [], waveform: null,
      issues: ["Rekordbox analysis files were not found."],
    }), [cue({ kind: "memory", label: "Memory", comment: null, time: 4.25 })], 120);

    expect(result.status).toBe("partial");
    expect(result.summary).toEqual({ beatCount: 0, phraseCount: 0, cueCount: 1 });
    expect(result.anchors).toEqual([{
      time: 4.25,
      label: "Memory",
      reason: "Saved Rekordbox memory cue",
      kind: "cue",
    }]);
  });
});
