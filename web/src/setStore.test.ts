import { describe, expect, test } from "bun:test";
import {
  DEFAULT_TRANSITION, TRANSITION_BARS, TRANSITION_PRESETS, describePlaylistAppend, draftSignature, mergeTransition,
  normalizeDraft, presetTransition, recoveryKey, rehearsalOf, resolveTransitionMix, seedOf, setOrder, transitionKey,
  type BuiltInPresetId, type SetDraft,
} from "./setStore";

describe("set order edits", () => {
  const ids = [1, 2, 3, 4];
  test("append and appendMany skip tracks already in the set and keep given order", () => {
    expect(setOrder.append(ids, 2)).toBe(ids);
    expect(setOrder.append(ids, 9)).toEqual([1, 2, 3, 4, 9]);
    expect(setOrder.appendMany(ids, [7, 2, 5, 7])).toEqual([1, 2, 3, 4, 7, 5]);
    expect(setOrder.appendMany(ids, [1, 4])).toBe(ids);
  });
  test("insertAt puts a new track at the final index, or moves one already in the set", () => {
    expect(setOrder.insertAt(ids, 1, 9)).toEqual([1, 9, 2, 3, 4]);
    expect(setOrder.insertAt(ids, 99, 9)).toEqual([1, 2, 3, 4, 9]);
    expect(setOrder.insertAt(ids, -3, 9)).toEqual([9, 1, 2, 3, 4]);
    expect(setOrder.insertAt(ids, 3, 1)).toEqual([2, 3, 4, 1]);
    expect(setOrder.insertAt(ids, 0, 1)).toBe(ids);
  });
  test("removeAt, moveBy and reorder return the same array when nothing changes", () => {
    expect(setOrder.removeAt(ids, 1)).toEqual([1, 3, 4]);
    expect(setOrder.removeAt(ids, -1)).toBe(ids);
    expect(setOrder.moveBy(ids, 0, 1)).toEqual([2, 1, 3, 4]);
    expect(setOrder.moveBy(ids, 0, -1)).toBe(ids);
    expect(setOrder.moveBy(ids, 3, 1)).toBe(ids);
    expect(setOrder.reorder(ids, 0, 2)).toEqual([2, 3, 1, 4]);
    expect(setOrder.reorder(ids, 3, 0)).toEqual([4, 1, 2, 3]);
    expect(setOrder.reorder(ids, 1, 1)).toBe(ids);
    expect(setOrder.reorder(ids, 5, 0)).toBe(ids);
    expect(ids).toEqual([1, 2, 3, 4]);
  });
});

describe("transitions", () => {
  test("keys are from:to", () => expect(transitionKey(12, 7)).toBe("12:7"));

  test("rehearsal keeps practiced in step unless practiced is given", () => {
    expect(mergeTransition(undefined, { rehearsal: "works" })).toEqual({ notes: "", practiced: true, rehearsal: "works" });
    const worked = mergeTransition(undefined, { rehearsal: "works" });
    expect(mergeTransition(worked, { rehearsal: "needs-work" }).practiced).toBe(false);
    expect(mergeTransition(undefined, { notes: "bass at 16" })).toEqual({ notes: "bass at 16", practiced: false });
    expect(rehearsalOf({ notes: "", practiced: true })).toBe("works");
    expect(rehearsalOf(DEFAULT_TRANSITION)).toBe("not-tried");
  });

  test("editing one EQ band keeps the others and marks the pair custom", () => {
    const shaped = presetTransition({ notes: "keep", practiced: true, mixOut: { time: 10, label: "A", kind: "cue" } }, "bass-swap");
    const edited = mergeTransition(shaped, { eq: { mid: { mode: "swap", at: 0.4 } } });
    expect(edited.preset).toBe("custom");
    expect(edited.eq).toEqual({ ...TRANSITION_PRESETS["bass-swap"].eq, mid: { mode: "swap", at: 0.4 } });
    expect(edited.notes).toBe("keep");
    expect(edited.mixOut?.time).toBe(10);
    expect(mergeTransition(shaped, { bars: 8 }).preset).toBe("bass-swap");
    expect(mergeTransition(shaped, { fx: "echo", preset: "echo-out" }).preset).toBe("echo-out");
  });

  test("presets keep notes and give each pair its own EQ copy", () => {
    const a = presetTransition({ notes: "n", practiced: false, offsetBeats: 2 }, "high-to-low");
    expect(a).toMatchObject({ notes: "n", offsetBeats: 2, preset: "high-to-low", bars: 16, fx: null });
    expect(a.eq).toEqual(TRANSITION_PRESETS["high-to-low"].eq);
    expect(a.eq).not.toBe(TRANSITION_PRESETS["high-to-low"].eq);
    a.eq!.bass.at = 0.1;
    expect(TRANSITION_PRESETS["high-to-low"].eq.bass.at).toBe(0.75);
    expect(presetTransition(undefined, "echo-out")).toMatchObject({ bars: 4, fx: "echo", eq: { volume: { mode: "fade-out" } } });
    expect(presetTransition(undefined, "cut")).toMatchObject({ bars: 1, eq: { volume: { mode: "swap", at: 0 } } });
  });

  test("every preset uses a real bar count and in-window automation", () => {
    for (const [id, spec] of Object.entries(TRANSITION_PRESETS)) {
      expect(TRANSITION_BARS).toContain(spec.bars);
      for (const band of Object.values(spec.eq)) {
        expect(band.at, id).toBeGreaterThanOrEqual(0);
        expect(band.at, id).toBeLessThanOrEqual(1);
      }
    }
    expect(Object.keys(TRANSITION_PRESETS).sort()).toEqual((["bass-swap", "crossfade", "cut", "echo-out", "high-to-low", "low-to-high"] satisfies BuiltInPresetId[]).sort());
  });

  test("unshaped pairs resolve to a plain crossfade and say so", () => {
    expect(resolveTransitionMix(DEFAULT_TRANSITION)).toEqual({ preset: "crossfade", bars: 16, eq: TRANSITION_PRESETS.crossfade.eq, fx: null, offsetBeats: 0, explicit: false });
    expect(resolveTransitionMix(presetTransition(undefined, "echo-out"))).toMatchObject({ preset: "echo-out", bars: 4, fx: "echo", explicit: true });
  });
});

describe("draft helpers", () => {
  const draft: SetDraft = { revision: 3, setId: "s1", name: "Sat", trackIds: [5, 6, 7], notes: "", seedTrackId: null, transitions: {}, trackNotes: {} };
  test("the recovery key scheme is unchanged", () => {
    expect(recoveryKey("s1")).toBe("dj-organizer-prep-recovery-v1:s1");
    expect(recoveryKey()).toBe("dj-organizer-prep-recovery-v1:active");
  });
  test("signature ignores revision and name, but not set id or content", () => {
    expect(draftSignature({ ...draft, revision: 9, name: "Other" })).toBe(draftSignature(draft));
    expect(draftSignature({ ...draft, setId: "s2" })).not.toBe(draftSignature(draft));
    expect(draftSignature({ ...draft, notes: "x" })).not.toBe(draftSignature(draft));
  });
  test("server drafts without transitions or notes normalize to empty records", () => {
    const { transitions: _t, trackNotes: _n, ...bare } = draft;
    expect(normalizeDraft(bare)).toEqual(draft);
  });
  test("the seed is the chosen track while it is in the set, else the last track", () => {
    expect(seedOf(draft)).toBe(7);
    expect(seedOf({ ...draft, seedTrackId: 6 })).toBe(6);
    expect(seedOf({ ...draft, seedTrackId: 99 })).toBe(7);
    expect(seedOf({ trackIds: [], seedTrackId: null })).toBeNull();
  });
  test("playlist append summary", () => {
    const playlist = { id: 1, name: "Warmup" };
    expect(describePlaylistAppend({ playlist, added: 4, skipped: 0, unavailable: 0 })).toBe("4 added in playlist order.");
    expect(describePlaylistAppend({ playlist, added: 2, skipped: 3, unavailable: 1 })).toBe("2 added in playlist order · 3 already in set · 1 unavailable.");
  });
});
