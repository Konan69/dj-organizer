export type ListeningAnchor = { time: number; label: string; kind: "cue" | "phrase"; reason: string };

/** Listening ideas from saved markers, never a claim that a transition will work. */
export function mixPointChoices(data: { duration: number; anchors: ListeningAnchor[] } | null, role: "in" | "out"): ListeningAnchor[] {
  if (!data || !Number.isFinite(data.duration) || data.duration <= 0) return [];
  const candidates = data.anchors.filter((anchor) => Number.isFinite(anchor.time) && anchor.time >= 0 && anchor.time < data.duration
    && (role === "in" ? anchor.time <= data.duration / 3 : anchor.time >= data.duration * 2 / 3));
  const preferredLabel = role === "in" ? /^intro\b/i : /^outro\b/i;
  const priority = (anchor: ListeningAnchor) => anchor.kind === "cue" ? 0 : preferredLabel.test(anchor.label) ? 1 : 2;
  candidates.sort((a, b) => priority(a) - priority(b) || (role === "in" ? a.time - b.time : b.time - a.time));
  const chosen: ListeningAnchor[] = [];
  for (const anchor of candidates) {
    if (chosen.some((other) => Math.abs(other.time - anchor.time) < 1)) continue;
    chosen.push({ ...anchor, reason: `${anchor.kind === "cue" ? "Saved Rekordbox cue" : `Saved ${anchor.label} phrase boundary`} in the ${role === "in" ? "opening" : "final"} third. Audition before choosing.` });
    if (chosen.length === 3) break;
  }
  return chosen.sort((a, b) => a.time - b.time);
}
