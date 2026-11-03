import { describe, expect, test } from "bun:test";
import { mixPointChoices, type ListeningAnchor } from "./mix-point-choices";

const anchor = (time: number, kind: "cue" | "phrase", label: string): ListeningAnchor => ({ time, kind, label, reason: "Saved evidence" });
describe("saved listening-point suggestions", () => {
  test("keeps exact cue times and prefers a saved cue over its nearby phrase", () => {
    const anchors = [anchor(0, "phrase", "Intro 1"), anchor(0.458, "cue", "A"), anchor(25, "phrase", "Verse 1")];
    const choices = mixPointChoices({ duration: 180, anchors }, "in");
    expect(choices.map((choice) => choice.time)).toEqual([0.458, 25]);
    expect(choices[0]!.label).toBe("A");
    expect(choices[0]!.reason).toContain("Audition before choosing");
  });
  test("entry and exit ideas stay within their supported part of the audio", () => {
    const anchors = [anchor(12.345, "cue", "A"), anchor(90, "phrase", "Chorus 1"), anchor(160.123, "phrase", "Outro 1"), anchor(180, "cue", "Past end"), anchor(NaN, "cue", "Invalid")];
    expect(mixPointChoices({ duration: 180, anchors }, "in").map((choice) => choice.time)).toEqual([12.345]);
    expect(mixPointChoices({ duration: 180, anchors }, "out").map((choice) => choice.time)).toEqual([160.123]);
    expect(anchors[0]!.reason).toBe("Saved evidence");
  });
  test("missing analysis never produces made-up mix positions", () => {
    expect(mixPointChoices(null, "in")).toEqual([]);
    expect(mixPointChoices({ duration: 180, anchors: [] }, "out")).toEqual([]);
    expect(mixPointChoices({ duration: 0, anchors: [anchor(12, "cue", "A")] }, "in")).toEqual([]);
  });
});
