/**
 * Camelot wheel helpers. Rekordbox stores keys either as Camelot codes ("8A")
 * or as musical names ("Am", "F#m", "Dbmaj"); everything here normalises to
 * Camelot so colour, sorting and compatibility work off one notation.
 */

export type Camelot = { num: number; letter: "A" | "B" };

/** Musical name → Camelot. Minor keys are A, major keys are B. */
const MUSICAL: Record<string, string> = {
  "Abm": "1A", "G#m": "1A", "B": "1B", "Cb": "1B",
  "Ebm": "2A", "D#m": "2A", "F#": "2B", "Gb": "2B",
  "Bbm": "3A", "A#m": "3A", "Db": "3B", "C#": "3B",
  "Fm": "4A", "Ab": "4B", "G#": "4B",
  "Cm": "5A", "Eb": "5B", "D#": "5B",
  "Gm": "6A", "Bb": "6B", "A#": "6B",
  "Dm": "7A", "F": "7B",
  "Am": "8A", "C": "8B",
  "Em": "9A", "G": "9B",
  "Bm": "10A", "D": "10B",
  "F#m": "11A", "Gbm": "11A", "A": "11B",
  "Dbm": "12A", "C#m": "12A", "E": "12B",
};

export function parseKey(raw: string | null | undefined): Camelot | null {
  if (!raw) return null;
  const s = raw.trim();
  const cam = s.match(/^(1[0-2]|[1-9])\s*([AaBb])$/);
  if (cam) return { num: Number(cam[1]), letter: cam[2]!.toUpperCase() as "A" | "B" };
  const norm = s.replace(/\s+/g, "").replace(/maj(or)?$/i, "").replace(/min(or)?$/i, "m")
    .replace(/^([a-g])/, (c) => c.toUpperCase()).replace("♯", "#").replace("♭", "b");
  const hit = MUSICAL[norm];
  return hit ? parseKey(hit) : null;
}

export const keyLabel = (k: Camelot | null) => (k ? `${k.num}${k.letter}` : "—");

/**
 * Hue per wheel position, following the Mixed In Key wheel DJs already read:
 * 1 is aqua, 3 lime, 5 orange, 7 pink, 9 violet, 11 blue. OKLCH keeps every
 * step at the same perceived lightness, so no key shouts louder than another.
 */
const HUE = [0, 185, 155, 125, 95, 60, 30, 355, 325, 295, 265, 235, 210];

export function keyColor(k: Camelot | null): string {
  if (!k) return "var(--text-3)";
  const hue = HUE[k.num] ?? 0;
  return k.letter === "A" ? `oklch(0.84 0.13 ${hue})` : `oklch(0.89 0.11 ${hue})`;
}

export type Compat = "same" | "smooth" | "boost" | "clash" | "unknown";

/**
 * How two keys mix. "smooth" is the classic Camelot move (±1, or the
 * relative major/minor); "boost" is the +2 / +7 energy lift DJs use on
 * purpose; everything else clashes.
 */
export function compat(a: Camelot | null, b: Camelot | null): Compat {
  if (!a || !b) return "unknown";
  if (a.num === b.num && a.letter === b.letter) return "same";
  const step = (((b.num - a.num) % 12) + 12) % 12;
  if (a.letter === b.letter && (step === 1 || step === 11)) return "smooth";
  if (a.num === b.num) return "smooth";
  if (a.letter === b.letter && (step === 2 || step === 7)) return "boost";
  return "clash";
}

export const COMPAT_LABEL: Record<Compat, string> = {
  same: "Same key",
  smooth: "Harmonic",
  boost: "Energy boost",
  clash: "Key clash",
  unknown: "Key unknown",
};

/** Tempo difference as the DJ reads it: percent pitch you'd have to ride. */
export function bpmShift(from: number | null | undefined, to: number | null | undefined) {
  if (!from || !to) return null;
  return ((to - from) / from) * 100;
}

export const fmtBpm = (bpm: number | null | undefined) =>
  bpm ? (Math.abs(bpm - Math.round(bpm)) < 0.05 ? String(Math.round(bpm)) : bpm.toFixed(1)) : "—";
