import { db, getMeta, setMeta } from "./db";
import { toWin } from "./paths";

export type PrepAnchor = { time: number; label: string; kind: "cue" | "phrase" };
export const BAND_MODES = ["none", "crossfade", "fade-in", "fade-out", "swap"] as const;
export const TRANSITION_BARS = [1, 2, 4, 8, 16, 32] as const;
export const TRANSITION_PRESETS = ["bass-swap", "crossfade", "high-to-low", "low-to-high",
  "echo-out", "cut", "custom"] as const;
export type BandMode = typeof BAND_MODES[number];
/** `at` (0..1) is the swap position within the transition; other modes ignore it. */
export type BandAutomation = { mode: BandMode; at: number };
export type TransitionPreset = typeof TRANSITION_PRESETS[number];
export type PrepTransition = { notes: string; practiced: boolean;
  rehearsal?: "not-tried" | "needs-work" | "works";
  mixOut?: PrepAnchor | null; mixIn?: PrepAnchor | null;
  /** Transition length in bars of the outgoing track. */
  bars?: typeof TRANSITION_BARS[number];
  preset?: TransitionPreset;
  eq?: { volume: BandAutomation; bass: BandAutomation; mid: BandAutomation; high: BandAutomation };
  /** Effect on the outgoing track during the transition. */
  fx?: "echo" | null;
  /** -64..64 beats nudging the incoming track, applied on top of mixIn. */
  offsetBeats?: number };
export type PrepDraft = { revision: number; trackIds: number[]; notes: string;
  seedTrackId: number | null; transitions?: Record<string, PrepTransition>;
  trackNotes?: Record<string, string>; setId?: string; name?: string };
export type PrepSetSummary = { id: string; name: string; trackCount: number; updatedAt: number };
type SavedSet = { id: string; name: string; updatedAt: number; draft: PrepDraft };
type SetStore = { version: 1; activeSetId: string; sets: SavedSet[] };

const LEGACY_KEY = "prep_draft_v1";
const SETS_KEY = "prep_sets_v1";
const emptyDraft = (): PrepDraft => ({ revision: 0, trackIds: [], notes: "",
  seedTrackId: null, transitions: {}, trackNotes: {} });
const now = () => Math.floor(Date.now() / 1000);
const newId = () => `set-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
const cleanName = (value: string) => {
  const name = value.trim();
  if (!name) throw new Error("Set name cannot be empty.");
  if (name.length > 120) throw new Error("Set name is too long.");
  return name;
};
const normalize = (draft: PrepDraft, set: Pick<SavedSet, "id" | "name">): PrepDraft => ({
  ...draft, setId: set.id, name: set.name,
});
const normalizeFull = (draft: PrepDraft, set: Pick<SavedSet, "id" | "name">): PrepDraft => ({
  ...normalize(draft, set), transitions: draft.transitions ?? {}, trackNotes: draft.trackNotes ?? {},
});

function loadStore(): SetStore {
  const saved = getMeta(SETS_KEY);
  if (saved) {
    try {
      const parsed = JSON.parse(saved) as SetStore;
      if (parsed.version === 1 && parsed.sets.length &&
          parsed.sets.some((set) => set.id === parsed.activeSetId)) return parsed;
    } catch { /* Recover below from the untouched legacy draft. */ }
  }
  const legacyRaw = getMeta(LEGACY_KEY);
  let legacy = emptyDraft();
  if (legacyRaw) {
    try { legacy = { ...legacy, ...JSON.parse(legacyRaw) }; } catch { /* Keep an empty set. */ }
  }
  const first: SavedSet = { id: newId(), name: "My first set", updatedAt: now(), draft: legacy };
  const store: SetStore = { version: 1, activeSetId: first.id, sets: [first] };
  setMeta(SETS_KEY, JSON.stringify(store));
  return store;
}

const writeStore = (store: SetStore) => setMeta(SETS_KEY, JSON.stringify(store));
const active = (store: SetStore) => store.sets.find((set) => set.id === store.activeSetId)!;
const findSet = (store: SetStore, id?: string) => {
  const set = id ? store.sets.find((candidate) => candidate.id === id) : active(store);
  if (!set) throw new Error("Set not found.");
  return set;
};
const summaries = (store: SetStore): PrepSetSummary[] => store.sets
  .map((set) => ({ id: set.id, name: set.name, trackCount: set.draft.trackIds.length,
    updatedAt: set.updatedAt }))
  .sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name));

export function getSets() {
  const store = loadStore();
  return { sets: summaries(store), activeSetId: store.activeSetId };
}
export function getDraft(setId?: string): PrepDraft {
  const set = findSet(loadStore(), setId);
  return normalize(set.draft, set);
}
export function saveDraft(input: PrepDraft): { draft: PrepDraft; conflict: boolean } {
  return db.transaction(() => {
    const store = loadStore(), set = findSet(store, input.setId), current = normalize(set.draft, set);
    if (input.revision !== current.revision) return { draft: current, conflict: true };
    const known = db.query<{ id: number }, [number]>("SELECT id FROM tracks WHERE id=?");
    for (const id of [...input.trackIds, ...(input.seedTrackId === null ? [] : [input.seedTrackId])]) {
      if (!known.get(id)) throw new Error("A selected track no longer exists. Reload your library.");
    }
    set.draft = { revision: current.revision + 1, trackIds: input.trackIds,
      notes: input.notes, seedTrackId: input.seedTrackId,
      transitions: input.transitions, trackNotes: input.trackNotes };
    set.updatedAt = now();
    writeStore(store);
    return { draft: normalize(set.draft, set), conflict: false };
  })();
}
export function createSet(name: string, fromCurrent = false, sourceSetId?: string) {
  return db.transaction(() => {
    const store = loadStore(), source = findSet(store, sourceSetId).draft;
    const set: SavedSet = { id: newId(), name: cleanName(name), updatedAt: now(),
      draft: fromCurrent ? { ...structuredClone(source), revision: 0 } : emptyDraft() };
    store.sets.push(set); store.activeSetId = set.id; writeStore(store);
    return { ...getSets(), draft: normalizeFull(set.draft, set) };
  })();
}
export function openSet(id: string) {
  const store = loadStore(), set = store.sets.find((candidate) => candidate.id === id);
  if (!set) throw new Error("Set not found.");
  store.activeSetId = set.id; writeStore(store);
  return { draft: normalizeFull(set.draft, set), activeSetId: set.id };
}
export function renameSet(id: string, name: string) {
  const store = loadStore(), set = store.sets.find((candidate) => candidate.id === id);
  if (!set) throw new Error("Set not found.");
  set.name = cleanName(name); set.updatedAt = now(); writeStore(store);
  return { set: summaries(store).find((summary) => summary.id === id)!,
    activeSetId: store.activeSetId };
}
export function deleteSet(id: string) {
  return db.transaction(() => {
    const store = loadStore();
    if (store.sets.length === 1) throw new Error("Keep at least one saved set.");
    const index = store.sets.findIndex((set) => set.id === id);
    if (index < 0) throw new Error("Set not found.");
    store.sets.splice(index, 1);
    if (store.activeSetId === id) store.activeSetId = store.sets[0]!.id;
    writeStore(store);
    return { ...getSets(), draft: getDraft() };
  })();
}

export function exportDraft(setId?: string): string {
  const draft = getDraft(setId);
  if (!draft.trackIds.length) throw new Error("Add tracks to your set before exporting.");
  const track = db.query<{ path: string; missing: number }, [number]>("SELECT path,missing FROM tracks WHERE id=?");
  const paths = draft.trackIds.map((id) => {
    const row = track.get(id);
    if (!row || row.missing || !Bun.file(row.path).size) throw new Error("A set track is missing. Resolve it before exporting.");
    const path = toWin(row.path);
    if (/[\r\n]/.test(path)) throw new Error("A track path contains a line break and cannot be exported.");
    return path;
  });
  return "#EXTM3U\n" + paths.join("\n") + "\n";
}
export function exportFilename(setId?: string) {
  const name = getDraft(setId).name ?? "My DJ set";
  return `${name.replace(/[\\/:*?"<>|\r\n]+/g, " ").trim() || "My DJ set"}.m3u8`;
}
export function exportContentDisposition(setId?: string) {
  const filename = exportFilename(setId);
  const ascii = filename.normalize("NFKD").replace(/[^\x20-\x7E]/g, "")
    .replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim();
  const fallback = ascii && ascii !== ".m3u8" ? ascii : "My DJ set.m3u8";
  const encoded = encodeURIComponent(filename).replace(/[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const anchorText = (label: string, anchor?: PrepAnchor | null) => anchor
  ? `${label}: ${anchor.label} at ${anchor.time.toFixed(1)}s (${anchor.kind})` : "";
const PRESET_LABELS: Record<TransitionPreset, string> = { "bass-swap": "Bass swap",
  crossfade: "Crossfade", "high-to-low": "High to low", "low-to-high": "Low to high",
  "echo-out": "Echo out", cut: "Cut", custom: "Custom" };
/** e.g. "Bass swap · 16 bars"; empty when neither is set. */
export const transitionShape = (pair?: PrepTransition) => [
  pair?.preset ? PRESET_LABELS[pair.preset] : "",
  pair?.bars ? `${pair.bars} bar${pair.bars === 1 ? "" : "s"}` : "",
].filter(Boolean).join(" · ");
export function runSheet(setId?: string): string {
  const draft = getDraft(setId), title = draft.name ?? "My set";
  const track = db.query<{ title: string; artist: string | null; missing: number }, [number]>(
    `SELECT COALESCE(o.title,t.title,t.filename) AS title,COALESCE(o.artist,t.artist) AS artist,t.missing
     FROM tracks t LEFT JOIN track_overrides o ON o.track_hash=t.content_hash WHERE t.id=?`);
  const tracks = draft.trackIds.map((id) => track.get(id));
  const rows = tracks.map((row, i) => {
    const pair = draft.transitions?.[`${draft.trackIds[i]}:${draft.trackIds[i + 1]}`];
    const anchors = [anchorText("Mix out", pair?.mixOut), anchorText("Mix in", pair?.mixIn)]
      .filter(Boolean).map((text) => `<p>${escapeHtml(text)}</p>`).join("");
    const rehearsal = pair?.rehearsal ? pair.rehearsal.replaceAll("-", " ") :
      pair?.practiced ? "Practiced on decks" : "Still to practice";
    const trackNote = draft.trackNotes?.[String(draft.trackIds[i])];
    const shape = transitionShape(pair);
    return `<li><h2>${escapeHtml(row?.title ?? "Unavailable track")}</h2><p>${escapeHtml(row?.artist ?? "")}${!row || row.missing ? " — file unavailable" : ""}</p>${trackNote ? `<pre class="track-note">${escapeHtml(trackNote)}</pre>` : ""}${i < tracks.length - 1 ? `<div class="pair"><strong>Into ${escapeHtml(tracks[i + 1]?.title ?? "next track")}</strong>${shape ? `<p class="transition">${escapeHtml(shape)}</p>` : ""}<p>Rehearsal: ${escapeHtml(rehearsal)}</p>${anchors}<pre>${escapeHtml(pair?.notes || "No transition notes yet")}</pre></div>` : ""}</li>`;
  }).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} — practice sheet</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:800px;margin:40px auto;padding:0 24px;color:#17212b}h1{font-size:30px}h2{font-size:20px;margin-bottom:0}li{padding:12px 0;break-inside:avoid}pre{white-space:pre-wrap;font:inherit}.pair{border-left:3px solid #777;padding-left:16px}button{padding:10px 16px;cursor:pointer}@media print{button{display:none}body{margin:0}}</style></head><body><button onclick="window.print()">Print / save PDF</button><h1>${escapeHtml(title)} — practice sheet</h1><p>${draft.trackIds.length} tracks · Saved version ${draft.revision}</p><pre>${escapeHtml(draft.notes)}</pre><ol>${rows}</ol><p>Playlist export carries track order. Keep this sheet for your notes and practice checks.</p></body></html>`;
}
