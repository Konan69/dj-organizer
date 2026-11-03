/**
 * The current set, shared by the Library, Playlist and Studio views.
 *
 * Non-visual only: draft hydration and tab recovery, debounced autosave with
 * revision conflicts, saved sets, order edits with undo, notes, per-pair
 * transitions, Rekordbox facts, next-track suggestions, AI steering and prep
 * gaps. Views read it through `useSet()` (everything), `useSetActions()`
 * (stable callbacks only) or `useTrackFacts(id)`.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { InsightsResult } from "@api/insights-ai";
import type { SuggestedCandidate, SuggestionReadModel, SuggestionTrack, suggestNext } from "@api/suggestions";
import type { Track } from "./api";
import type { OpenRouterStatus } from "./OpenRouterSettings";

// ---- transition model -------------------------------------------------------

export type MixPoint = { time: number; label: string; kind: "cue" | "phrase" };
export type BandMode = "none" | "crossfade" | "fade-in" | "fade-out" | "swap";
/** `at` is a 0–1 fraction of the transition window where the band's move happens. */
export type BandAutomation = { mode: BandMode; at: number };
export type TransitionBars = 1 | 2 | 4 | 8 | 16 | 32;
export type TransitionPresetId = "bass-swap" | "crossfade" | "high-to-low" | "low-to-high" | "echo-out" | "cut" | "custom";
export type BuiltInPresetId = Exclude<TransitionPresetId, "custom">;
export type TransitionEq = { volume: BandAutomation; bass: BandAutomation; mid: BandAutomation; high: BandAutomation };
export type TransitionFx = "echo" | null;
export type RehearsalState = "not-tried" | "needs-work" | "works";
export type TransitionPrep = {
  notes: string; practiced: boolean; rehearsal?: RehearsalState;
  mixOut?: MixPoint | null; mixIn?: MixPoint | null;
  bars?: TransitionBars; preset?: TransitionPresetId;
  eq?: TransitionEq; fx?: TransitionFx; offsetBeats?: number;
};
/** Like TransitionPrep, but `eq` may name only the bands that change. */
export type TransitionPatch = Partial<Omit<TransitionPrep, "eq">> & { eq?: Partial<TransitionEq> };
export type TransitionPresetSpec = { label: string; bars: TransitionBars; eq: TransitionEq; fx: TransitionFx };
/** A transition with every mix field filled in. `explicit` is false when nothing was chosen yet. */
export type TransitionMix = { preset: TransitionPresetId; bars: TransitionBars; eq: TransitionEq; fx: TransitionFx; offsetBeats: number; explicit: boolean };

export const TRANSITION_BARS: readonly TransitionBars[] = [1, 2, 4, 8, 16, 32];

const band = (mode: BandMode, at = 0): BandAutomation => Object.freeze({ mode, at });
const preset = (label: string, bars: TransitionBars, eq: TransitionEq, fx: TransitionFx = null): TransitionPresetSpec =>
  Object.freeze({ label, bars, eq: Object.freeze(eq), fx });

export const TRANSITION_PRESETS: Readonly<Record<BuiltInPresetId, TransitionPresetSpec>> = Object.freeze({
  "bass-swap": preset("Bass swap", 16, { volume: band("crossfade", 0.5), bass: band("swap", 0.5), mid: band("none"), high: band("none") }),
  crossfade: preset("Crossfade", 16, { volume: band("crossfade", 0.5), bass: band("none"), mid: band("none"), high: band("none") }),
  "high-to-low": preset("Highs, mids, then bass", 16, { volume: band("crossfade", 0.5), bass: band("swap", 0.75), mid: band("swap", 0.5), high: band("swap", 0.25) }),
  "low-to-high": preset("Bass, mids, then highs", 16, { volume: band("crossfade", 0.5), bass: band("swap", 0.25), mid: band("swap", 0.5), high: band("swap", 0.75) }),
  "echo-out": preset("Echo out", 4, { volume: band("fade-out", 0), bass: band("none"), mid: band("none"), high: band("none") }, "echo"),
  cut: preset("Cut", 1, { volume: band("swap", 0), bass: band("none"), mid: band("none"), high: band("none") }),
});
/** Used to fill mix fields for a pair nobody has shaped yet: volume only, no EQ moves. */
const FALLBACK_PRESET: BuiltInPresetId = "crossfade";

export const DEFAULT_TRANSITION: TransitionPrep = Object.freeze({ notes: "", practiced: false });
export const transitionKey = (fromId: number, toId: number) => `${fromId}:${toId}`;
export const rehearsalOf = (transition: TransitionPrep): RehearsalState =>
  transition.rehearsal ?? (transition.practiced ? "works" : "not-tried");

export function resolveTransitionMix(transition: TransitionPrep): TransitionMix {
  const base = transition.preset && transition.preset !== "custom" ? transition.preset : FALLBACK_PRESET;
  const spec = TRANSITION_PRESETS[base];
  return {
    preset: transition.preset ?? FALLBACK_PRESET,
    bars: transition.bars ?? spec.bars,
    eq: transition.eq ?? spec.eq,
    fx: transition.fx === undefined ? spec.fx : transition.fx,
    offsetBeats: transition.offsetBeats ?? 0,
    explicit: transition.preset !== undefined || transition.eq !== undefined,
  };
}

/**
 * Merge a patch into a pair. Choosing a rehearsal result keeps `practiced` in
 * step (only "works" counts as practiced); hand-editing EQ or FX turns the
 * pair's preset into "custom" unless the patch names a preset itself.
 */
export function mergeTransition(current: TransitionPrep | undefined, patch: TransitionPatch): TransitionPrep {
  const base = current ?? DEFAULT_TRANSITION;
  const { eq, ...rest } = patch;
  const next: TransitionPrep = { ...base, ...rest };
  if (eq) next.eq = { ...resolveTransitionMix(base).eq, ...eq };
  if (patch.rehearsal !== undefined && patch.practiced === undefined) next.practiced = patch.rehearsal === "works";
  if ((eq !== undefined || patch.fx !== undefined) && patch.preset === undefined) next.preset = "custom";
  return next;
}

/** Shape a pair with a preset. Notes, rehearsal, mix points and beat offset are kept. */
export function presetTransition(current: TransitionPrep | undefined, id: BuiltInPresetId): TransitionPrep {
  const spec = TRANSITION_PRESETS[id];
  return { ...(current ?? DEFAULT_TRANSITION), preset: id, bars: spec.bars, eq: structuredClone(spec.eq), fx: spec.fx };
}

// ---- draft, sets and server shapes -------------------------------------------

export type SetDraft = {
  revision: number; setId?: string; name?: string; trackIds: number[]; notes: string;
  seedTrackId: number | null; transitions: Record<string, TransitionPrep>; trackNotes: Record<string, string>;
};
/** What /api/prep/* returns: transitions and track notes may be absent. */
type ServerDraft = Omit<SetDraft, "transitions" | "trackNotes"> & {
  transitions?: Record<string, TransitionPrep>; trackNotes?: Record<string, string>;
};
export type PrepSet = { id: string; name: string; trackCount: number; updatedAt: number };
type SetsResult = { sets: PrepSet[]; activeSetId: string };
export type PrepGap = {
  id: string; kind: "file" | "analysis"; trackId: number; label: string; title: string;
  detail: string; missing: string[]; action: string;
};
export type TrackFacts = SuggestionTrack;
export type FactsCoverage = SuggestionReadModel["coverage"];
export type SuggestionResult = Awaited<ReturnType<typeof suggestNext>>;
export type SuggestionCandidate = SuggestedCandidate;
export type AiResult = InsightsResult;
export type AiStatus = OpenRouterStatus;
export type SuggestionPriority = "balanced" | "tempo" | "key";
export type SuggestionPrefs = { priority: SuggestionPriority; allowHalfDouble: boolean };
export type SaveState = "loading" | "saving" | "saved" | "pending" | "issue";
/**
 * Autosave is paused while an issue is open.
 * recovered: this tab holds unsaved edits from before a reload/switch.
 * conflict: the saved set changed elsewhere (another tab, or a 409).
 * failed: the server rejected or never received the save.
 */
export type SaveIssue = { kind: "recovered" | "conflict" | "failed"; message: string; conflict: boolean; serverDraft?: SetDraft };
export type PlaylistAppendResult = { playlist: { id: number; name: string }; added: number; skipped: number; unavailable: number };
export type SetEntry = { id: number; index: number; track: Track | null };
export type SetPair = { fromId: number; toId: number; index: number; key: string; transition: TransitionPrep };

export const EMPTY_DRAFT: SetDraft = { revision: 0, trackIds: [], notes: "", seedTrackId: null, transitions: {}, trackNotes: {} };
const RECOVERY_KEY = "dj-organizer-prep-recovery-v1";
export const recoveryKey = (setId?: string) => `${RECOVERY_KEY}:${setId ?? "active"}`;
const PREFS_KEY = "dj-organizer-suggestion-prefs-v1";
const DEFAULT_PREFS: SuggestionPrefs = { priority: "balanced", allowHalfDouble: false };
const SAVE_DELAY_MS = 450;
const UNDO_LIMIT = 20;
const SUGGESTION_LIMIT = 6;
const GAPS_LIMIT = 8;
/** Browsers reject keepalive requests with bodies over 64 KiB. */
const KEEPALIVE_MAX_BYTES = 60_000;

export const draftSignature = (draft: SetDraft) =>
  JSON.stringify([draft.setId, draft.trackIds, draft.notes, draft.seedTrackId, draft.transitions, draft.trackNotes]);
export const normalizeDraft = (draft: ServerDraft): SetDraft =>
  ({ ...draft, transitions: draft.transitions ?? {}, trackNotes: draft.trackNotes ?? {} });
/** Suggestions follow the chosen seed while it is in the set, else the last track. */
export const seedOf = (draft: Pick<SetDraft, "seedTrackId" | "trackIds">): number | null =>
  draft.seedTrackId !== null && draft.trackIds.includes(draft.seedTrackId) ? draft.seedTrackId : draft.trackIds.at(-1) ?? null;
export const describePlaylistAppend = ({ added, skipped, unavailable }: PlaylistAppendResult) =>
  `${added} added in playlist order${skipped ? ` · ${skipped} already in set` : ""}${unavailable ? ` · ${unavailable} unavailable` : ""}.`;

/** Pure order edits. Each returns the same array when nothing changes. Indexes are final positions. */
export const setOrder = {
  append: (ids: number[], id: number) => ids.includes(id) ? ids : [...ids, id],
  appendMany(ids: number[], additions: readonly number[]) {
    const seen = new Set(ids), next = [...ids];
    for (const id of additions) if (!seen.has(id)) { seen.add(id); next.push(id); }
    return next.length === ids.length ? ids : next;
  },
  insertAt(ids: number[], index: number, id: number) {
    const existing = ids.indexOf(id);
    if (existing >= 0) return setOrder.reorder(ids, existing, index);
    const next = [...ids];
    next.splice(Math.max(0, Math.min(index, ids.length)), 0, id);
    return next;
  },
  removeAt: (ids: number[], index: number) => index < 0 || index >= ids.length ? ids : ids.filter((_, i) => i !== index),
  moveBy(ids: number[], index: number, direction: -1 | 1) {
    const target = index + direction;
    if (index < 0 || index >= ids.length || target < 0 || target >= ids.length) return ids;
    const next = [...ids];
    [next[index], next[target]] = [next[target]!, next[index]!];
    return next;
  },
  reorder(ids: number[], from: number, to: number) {
    const target = Math.max(0, Math.min(to, ids.length - 1));
    if (from < 0 || from >= ids.length || from === target) return ids;
    const next = [...ids];
    const [moved] = next.splice(from, 1);
    next.splice(target, 0, moved!);
    return next;
  },
};

const sameOrder = (a: number[], b: number[]) => a.length === b.length && a.every((id, i) => id === b[i]);
const message = (error: unknown) => (error as Error).message;
const setQuery = (setId?: string) => setId ? `?setId=${encodeURIComponent(setId)}` : "";

function readPrefs(): SuggestionPrefs {
  try { return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") }; }
  catch { return DEFAULT_PREFS; }
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error ?? `Request failed (${response.status})`) as Error & { status: number };
    error.status = response.status;
    throw error;
  }
  return body as T;
}
const send = (method: "POST" | "PUT" | "PATCH", body: unknown): RequestInit =>
  ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

// ---- public store shape ----------------------------------------------------

export type SetFacts = {
  /** Rekordbox facts per local track id (bpm, key, analysisAvailable, cueCount, …). */
  facts: ReadonlyMap<number, TrackFacts>;
  coverage: FactsCoverage | null;
  /** Why facts are partial or unavailable; null when all is well. */
  factsMessage: string | null;
  factsLoading: boolean;
  refreshingFacts: boolean;
  /** Bumped by refreshFacts(); pass to waveform components as refreshKey. */
  analysisRevision: number;
};

export type SetState = {
  draft: SetDraft;
  /** The draft loaded; edits are ignored until then. */
  ready: boolean;
  loadFailed: boolean;
  saveState: SaveState;
  saveIssue: SaveIssue | null;
  error: string | null;
  canUndo: boolean;

  sets: PrepSet[];
  activeSetId: string | null;
  setsBusy: boolean;
  canSwitchSets: boolean;
  canDeleteSet: boolean;
  playlistBusy: boolean;

  seedId: number | null;
  /** The ordered set joined with the library; `track` is null for unavailable tracks. */
  entries: SetEntry[];
  /** Consecutive pairs with their stored transition (defaults when absent). */
  pairs: SetPair[];
  inSet: ReadonlySet<number>;
  /** Seconds of full-length audio; mixing shortens the real set. */
  totalDuration: number;
  getTransition: (fromId: number, toId: number) => TransitionPrep;

  prefs: SuggestionPrefs;
  playlistScope: number | null;
  suggestions: SuggestionResult | null;
  suggestionsLoading: boolean;
  aiStatus: AiStatus | null;
  ai: AiResult | null;
  aiBusy: boolean;
  /** AI reasons keyed by candidate track id. */
  aiReasons: ReadonlyMap<number, string>;

  gaps: PrepGap[];
  hasMissingFiles: boolean;
  canExport: boolean;
  canExportPlaylist: boolean;
  runSheetUrl: string | null;
  m3uUrl: string | null;
};

export type SetActions = {
  retryLoad: () => Promise<void>;
  /** Save now; resolves true when the server holds exactly what the user sees. */
  flush: () => Promise<boolean>;
  clearError: () => void;
  /** "Keep my changes and save" (or "Save recovered changes"). */
  resolveKeepMine: () => void;
  /** "Use latest saved version": drop this tab's copy. */
  resolveUseLatest: () => Promise<void>;

  refreshSets: () => Promise<void>;
  openSet: (setId: string) => Promise<boolean>;
  /** Resolve to the new set id, or null on failure. */
  createSet: (name?: string) => Promise<string | null>;
  duplicateSet: (name?: string) => Promise<string | null>;
  renameSet: (name: string, setId?: string) => Promise<boolean>;
  deleteSet: (setId: string) => Promise<boolean>;

  add: (trackId: number) => void;
  insertAt: (index: number, trackId: number) => void;
  addMany: (trackIds: readonly number[]) => void;
  remove: (index: number) => void;
  removeTrack: (trackId: number) => void;
  move: (index: number, direction: -1 | 1) => void;
  reorder: (from: number, to: number) => void;
  undo: () => void;
  appendPlaylist: (playlistId: number) => Promise<PlaylistAppendResult | null>;
  setSeed: (trackId: number | null) => void;

  setSetNotes: (notes: string) => void;
  setTrackNote: (trackId: number, note: string) => void;
  updateTransition: (fromId: number, toId: number, patch: TransitionPatch) => void;
  applyPreset: (fromId: number, toId: number, preset: BuiltInPresetId) => void;

  refreshFacts: () => Promise<void>;
  setPrefs: (patch: Partial<SuggestionPrefs>) => void;
  setPlaylistScope: (playlistId: number | null) => void;
  steer: (intent: string) => Promise<void>;
  setAiStatus: (status: AiStatus) => void;
};

export type SetStore = SetState & SetFacts & SetActions;

const SetStateContext = createContext<SetState | null>(null);
const SetFactsContext = createContext<SetFacts | null>(null);
const SetActionsContext = createContext<SetActions | null>(null);

function required<T>(value: T | null, hook: string): T {
  if (value === null) throw new Error(`${hook} must be used inside <SetProvider>.`);
  return value;
}

export function useSet(): SetStore {
  const state = required(useContext(SetStateContext), "useSet");
  const facts = required(useContext(SetFactsContext), "useSet");
  const actions = required(useContext(SetActionsContext), "useSet");
  return useMemo(() => ({ ...state, ...facts, ...actions }), [state, facts, actions]);
}
/** Stable callbacks only; never re-renders because the set changed. */
export const useSetActions = (): SetActions => required(useContext(SetActionsContext), "useSetActions");
export const useSetFacts = (): SetFacts => required(useContext(SetFactsContext), "useSetFacts");
/** Rekordbox facts for one track; re-renders only when facts reload. */
export function useTrackFacts(trackId: number | null | undefined): TrackFacts | null {
  const { facts } = useSetFacts();
  return trackId == null ? null : facts.get(trackId) ?? null;
}

// ---- provider ---------------------------------------------------------------

export function SetProvider({ tracks, children }: { tracks: Track[]; children: ReactNode }) {
  const [draft, setDraftState] = useState<SetDraft>(EMPTY_DRAFT);
  const [loading, setLoading] = useState(true);
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveIssue, setSaveIssue] = useState<SaveIssue | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [undoDepth, setUndoDepth] = useState(0);

  const [sets, setSets] = useState<PrepSet[]>([]);
  const [activeSetId, setActiveSetId] = useState<string | null>(null);
  const [setsBusy, setSetsBusy] = useState(false);
  const [playlistBusy, setPlaylistBusy] = useState(false);

  const [facts, setFacts] = useState<ReadonlyMap<number, TrackFacts>>(() => new Map());
  const [coverage, setCoverage] = useState<FactsCoverage | null>(null);
  const [factsMessage, setFactsMessage] = useState<string | null>(null);
  const [factsLoading, setFactsLoading] = useState(true);
  const [refreshingFacts, setRefreshingFacts] = useState(false);
  const [analysisRevision, setAnalysisRevision] = useState(0);
  const [signalRevision, setSignalRevision] = useState(0);

  const [prefs, setPrefsState] = useState<SuggestionPrefs>(readPrefs);
  const [playlistScope, setPlaylistScopeState] = useState<number | null>(null);
  const [suggestions, setSuggestions] = useState<SuggestionResult | null>(null);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const [aiStatus, setAiStatus] = useState<AiStatus | null>(null);
  const [ai, setAi] = useState<AiResult | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [gaps, setGaps] = useState<PrepGap[]>([]);

  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const savePaused = useRef(false);
  const hydrated = useRef(false);
  const latestDraft = useRef<SetDraft>(EMPTY_DRAFT);
  const serverRevision = useRef(0);
  const savedSignature = useRef("");
  const savedTrackOrder = useRef("");
  const saveChain = useRef<Promise<void>>(Promise.resolve());
  const orderHistory = useRef<number[][]>([]);
  const aiRequest = useRef(0);
  const gapsRequest = useRef(0);
  const prefsRef = useRef(prefs);
  const scopeRef = useRef<number | null>(null);

  // ---- persistence ----

  const loadGaps = useCallback((setId: string | undefined) => {
    const request = ++gapsRequest.current;
    const params = new URLSearchParams({ limit: String(GAPS_LIMIT), ...(setId ? { setId } : {}) });
    return json<{ gaps: PrepGap[] }>(`/api/prep/gaps?${params}`).then((value) => {
      if (request === gapsRequest.current && latestDraft.current.setId === setId) setGaps(value.gaps);
    });
  }, []);

  /** Make a server draft current, restoring this tab's unsaved copy of it when one exists. */
  const installDraft = useCallback((value: ServerDraft, source: "hydrate" | "open") => {
    const server = normalizeDraft(value);
    let next = server;
    let issue: SaveIssue | null = null;
    try {
      const raw = sessionStorage.getItem(recoveryKey(server.setId));
      if (raw) {
        const recovery = normalizeDraft(JSON.parse(raw) as ServerDraft);
        if (draftSignature(recovery) !== draftSignature(server)) {
          const changedElsewhere = recovery.revision !== server.revision;
          next = { ...recovery, setId: server.setId, name: server.name, revision: server.revision };
          issue = {
            kind: changedElsewhere ? "conflict" : "recovered", conflict: changedElsewhere, serverDraft: server,
            message: source === "open" ? "Recovered unsaved changes for this set. Review them before saving."
              : changedElsewhere ? "Recovered unsaved changes, but the saved set also changed elsewhere. Review your copy before choosing which version to keep."
              : "Recovered unsaved changes from this tab. Review them, then save when ready.",
          };
        } else sessionStorage.removeItem(recoveryKey(server.setId));
      }
    } catch {
      try { sessionStorage.removeItem(recoveryKey(server.setId)); } catch { /* No readable recovery copy: keep the saved version. */ }
    }
    clearTimeout(saveTimer.current);
    gapsRequest.current += 1;
    serverRevision.current = server.revision;
    savedSignature.current = draftSignature(server);
    savedTrackOrder.current = server.trackIds.join(",");
    latestDraft.current = next;
    savePaused.current = issue !== null;
    orderHistory.current = [];
    hydrated.current = true;
    setUndoDepth(0);
    setDraftState(next);
    if (server.setId) setActiveSetId(server.setId);
    setSaved(issue === null);
    setSaveIssue(issue);
    setReady(true);
    if (source === "open") { setError(null); setSignalRevision((revision) => revision + 1); }
  }, []);

  const hydrate = useCallback(async () => {
    setLoading(true); setError(null);
    try { installDraft(await json<ServerDraft>("/api/prep/draft"), "hydrate"); }
    catch (e) { setError(`Could not open your saved set: ${message(e)}`); setReady(false); }
    finally { setLoading(false); }
  }, [installDraft]);

  const persistLatest = useCallback(() => {
    saveChain.current = saveChain.current.then(async () => {
      if (savePaused.current || !hydrated.current) return;
      const desired = latestDraft.current;
      const signature = draftSignature(desired);
      if (signature === savedSignature.current) return;
      setSaving(true);
      let succeeded = false;
      try {
        const body = JSON.stringify({ ...desired, revision: serverRevision.current });
        const result = await json<ServerDraft | { draft: ServerDraft }>("/api/prep/draft", {
          method: "PUT", headers: { "content-type": "application/json" }, body, keepalive: body.length < KEEPALIVE_MAX_BYTES,
        });
        const savedDraft = normalizeDraft("draft" in result ? result.draft : result);
        setSets((current) => current.map((set) => set.id === savedDraft.setId
          ? { ...set, trackCount: savedDraft.trackIds.length, updatedAt: Math.floor(Date.now() / 1000) } : set));
        // The set was switched or deleted while this request was in flight; its state is gone.
        if (latestDraft.current.setId !== desired.setId) return;
        serverRevision.current = savedDraft.revision;
        savedSignature.current = signature;
        const latest = { ...latestDraft.current, revision: savedDraft.revision };
        try {
          if (signature === draftSignature(latest)) sessionStorage.removeItem(recoveryKey(desired.setId));
          else sessionStorage.setItem(recoveryKey(desired.setId), JSON.stringify(latest));
        } catch { /* Saving on the server must not fail when browser storage is full. */ }
        savePaused.current = false;
        setSaveIssue(null);
        succeeded = true;
        latestDraft.current = latest;
        setDraftState(latest);
        setSaved(signature === draftSignature(latest));
        const trackOrder = desired.trackIds.join(",");
        if (trackOrder !== savedTrackOrder.current) {
          savedTrackOrder.current = trackOrder;
          setSignalRevision((revision) => revision + 1);
        }
        void loadGaps(desired.setId).catch(() => {});
      } catch (e) {
        const failure = e as Error & { status?: number };
        setSaved(false);
        savePaused.current = true;
        if (failure.status === 409) {
          try {
            const serverDraft = normalizeDraft(await json<ServerDraft>(`/api/prep/draft${setQuery(desired.setId)}`));
            serverRevision.current = serverDraft.revision;
            setSaveIssue({ kind: "conflict", conflict: true, serverDraft, message: "This set changed in another tab. Your edits are still here." });
          } catch {
            setSaveIssue({ kind: "conflict", conflict: true, message: "This set changed elsewhere. Your edits are still here; reload the latest revision before retrying." });
          }
        } else setSaveIssue({ kind: "failed", conflict: false, message: `Save failed: ${failure.message}. Your edits are kept in this tab.` });
      } finally { setSaving(false); }
      if (succeeded && savedSignature.current !== draftSignature(latestDraft.current)) persistLatest();
    });
  }, [loadGaps]);

  /** Wait for every queued save, including follow-ups queued while waiting. */
  const drainSaves = useCallback(async () => {
    let pending: Promise<void>;
    do { pending = saveChain.current; await pending; } while (pending !== saveChain.current);
  }, []);

  const flush = useCallback(async () => {
    clearTimeout(saveTimer.current);
    persistLatest();
    await drainSaves();
    return hydrated.current && !savePaused.current && savedSignature.current === draftSignature(latestDraft.current);
  }, [drainSaves, persistLatest]);

  const updateDraft = useCallback((change: (current: SetDraft) => SetDraft) => {
    if (!hydrated.current) return;
    const current = latestDraft.current;
    const next = change(current);
    if (next === current) return;
    latestDraft.current = next;
    try { sessionStorage.setItem(recoveryKey(next.setId), JSON.stringify(next)); } catch { /* Autosave still works. */ }
    setDraftState(next);
    setSaved(draftSignature(next) === savedSignature.current);
  }, []);

  useEffect(() => {
    void Promise.all([
      hydrate(),
      json<SuggestionReadModel>("/api/suggestions/model")
        .then((value) => { setFacts(new Map(value.tracks.map((track) => [track.trackId, track]))); setCoverage(value.coverage); setFactsMessage(value.reason ?? null); })
        .catch(() => setFactsMessage("Rekordbox facts are unavailable. Use Refresh Rekordbox facts to retry."))
        .finally(() => setFactsLoading(false)),
      json<AiStatus>("/api/suggestions/ai/status").then(setAiStatus).catch(() => {}),
      json<SetsResult>("/api/prep/sets").then((value) => { setSets(value.sets); setActiveSetId(value.activeSetId); }).catch(() => {}),
    ]);
  }, [hydrate]);

  // Debounced autosave; a recovery copy is written first so nothing is lost on reload.
  useEffect(() => {
    if (!hydrated.current) return;
    if (draftSignature(draft) === savedSignature.current) return;
    try { sessionStorage.setItem(recoveryKey(draft.setId), JSON.stringify(draft)); } catch { /* Server save still remains available. */ }
    if (saveIssue) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(persistLatest, SAVE_DELAY_MS);
    return () => clearTimeout(saveTimer.current);
    // Deliberately not `draft`: revision/name-only changes must not reschedule a save.
  }, [draft.setId, draft.trackIds, draft.notes, draft.seedTrackId, draft.transitions, draft.trackNotes, persistLatest, saveIssue]);

  useEffect(() => () => {
    clearTimeout(saveTimer.current);
    if (hydrated.current && !savePaused.current) persistLatest();
  }, [persistLatest]);

  useEffect(() => {
    if (!ready) return;
    void loadGaps(draft.setId).catch(() => {});
  }, [draft.setId, ready, loadGaps]);

  // ---- suggestions ----

  const seedId = seedOf(draft);

  useEffect(() => {
    aiRequest.current += 1;
    setAiBusy(false);
    setAi(null);
    if (seedId === null) { setSuggestions(null); setSuggestionsLoading(false); return; }
    const controller = new AbortController();
    setSuggestionsLoading(true);
    const params = new URLSearchParams({ trackId: String(seedId), limit: String(SUGGESTION_LIMIT), priority: prefs.priority });
    if (draft.setId) params.set("setId", draft.setId);
    if (playlistScope !== null) params.set("localPlaylistId", String(playlistScope));
    if (prefs.allowHalfDouble) params.set("allowHalfDouble", "1");
    void json<SuggestionResult>(`/api/suggestions?${params}`, { signal: controller.signal })
      .then(setSuggestions)
      .catch((e: Error) => { if (e.name !== "AbortError") setError(e.message); })
      .finally(() => { if (!controller.signal.aborted) setSuggestionsLoading(false); });
    return () => controller.abort();
  }, [seedId, signalRevision, playlistScope, prefs, draft.setId]);

  const setPrefs = useCallback((patch: Partial<SuggestionPrefs>) => {
    const next = { ...prefsRef.current, ...patch };
    prefsRef.current = next;
    setPrefsState(next);
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(next)); } catch { /* Preferences stay for this session. */ }
  }, []);

  const setPlaylistScope = useCallback((playlistId: number | null) => {
    scopeRef.current = playlistId;
    setPlaylistScopeState(playlistId);
  }, []);

  const steer = useCallback(async (intent: string) => {
    const seed = seedOf(latestDraft.current), text = intent.trim();
    if (seed === null || !text) return;
    const request = ++aiRequest.current;
    const { priority, allowHalfDouble } = prefsRef.current;
    const setId = latestDraft.current.setId, scope = scopeRef.current;
    setAiBusy(true); setError(null);
    try {
      const result = await json<AiResult>("/api/suggestions/ai", send("POST", {
        trackId: seed, intent: text, priority, allowHalfDouble,
        ...(setId ? { setId } : {}), ...(scope === null ? {} : { localPlaylistId: scope }),
      }));
      if (request === aiRequest.current) setAi(result);
    } catch (e) { if (request === aiRequest.current) setError(message(e)); }
    finally { if (request === aiRequest.current) setAiBusy(false); }
  }, []);

  const refreshFacts = useCallback(async () => {
    setRefreshingFacts(true); setError(null);
    try {
      const value = await json<SuggestionReadModel>("/api/suggestions/model?refresh=1");
      setFacts(new Map(value.tracks.map((track) => [track.trackId, track])));
      setCoverage(value.coverage);
      setFactsMessage(value.reason ?? null);
      setSignalRevision((revision) => revision + 1);
      setAnalysisRevision((revision) => revision + 1);
      await loadGaps(latestDraft.current.setId);
    } catch (e) { setError(`Could not refresh Rekordbox facts: ${message(e)}`); }
    finally { setRefreshingFacts(false); }
  }, [loadGaps]);

  // ---- save issues ----

  const resolveKeepMine = useCallback(() => {
    savePaused.current = false;
    setSaveIssue(null);
    persistLatest();
  }, [persistLatest]);

  const resolveUseLatest = useCallback(async () => {
    const setId = latestDraft.current.setId;
    let server: SetDraft;
    try { server = normalizeDraft(await json<ServerDraft>(`/api/prep/draft${setQuery(setId)}`)); }
    catch (e) { setError(`Could not load the saved version: ${message(e)}`); return; }
    if (latestDraft.current.setId !== setId) return;
    latestDraft.current = server;
    savedSignature.current = draftSignature(server);
    savedTrackOrder.current = server.trackIds.join(",");
    serverRevision.current = server.revision;
    try { sessionStorage.removeItem(recoveryKey(server.setId)); } catch { /* Nothing to clear. */ }
    savePaused.current = false;
    orderHistory.current = [];
    setUndoDepth(0);
    setDraftState(server); setSaved(true); setSaveIssue(null); setError(null);
  }, []);

  const retryLoad = useCallback(async () => {
    if (hydrated.current) return;
    await hydrate();
  }, [hydrate]);

  const clearError = useCallback(() => setError(null), []);

  // ---- sets ----

  const loadSets = useCallback(async () => {
    const value = await json<SetsResult>("/api/prep/sets");
    setSets(value.sets); setActiveSetId(value.activeSetId);
  }, []);

  const refreshSets = useCallback(async () => {
    try { await loadSets(); } catch (e) { setError(`Could not load your sets: ${message(e)}`); }
  }, [loadSets]);

  /** Switching sets needs the current one safely saved first. */
  const settleBeforeSwitch = useCallback(async () => {
    if (!hydrated.current) { setError("Your set has not loaded yet."); return false; }
    if (savePaused.current) { setError("Resolve the save issue before switching sets."); return false; }
    if (await flush()) return true;
    setError("Your changes could not be saved, so the set was not switched.");
    return false;
  }, [flush]);

  const openSet = useCallback(async (setId: string) => {
    if (setId === latestDraft.current.setId) return true;
    setSetsBusy(true); setError(null);
    try {
      if (!(await settleBeforeSwitch())) return false;
      const value = await json<{ draft: ServerDraft; activeSetId: string }>(`/api/prep/sets/${encodeURIComponent(setId)}/open`,
        send("POST", { revision: serverRevision.current, setId: latestDraft.current.setId }));
      installDraft(value.draft, "open");
      await loadSets().catch(() => {});
      return true;
    } catch (e) { setError(`Could not open the set: ${message(e)}`); return false; }
    finally { setSetsBusy(false); }
  }, [installDraft, loadSets, settleBeforeSwitch]);

  const createFrom = useCallback(async (fromCurrent: boolean, requestedName?: string) => {
    const name = requestedName?.trim() || (fromCurrent ? `${latestDraft.current.name ?? "My set"} copy` : "New set");
    setSetsBusy(true); setError(null);
    try {
      if (!(await settleBeforeSwitch())) return null;
      const value = await json<SetsResult & { draft: ServerDraft }>("/api/prep/sets",
        send("POST", { name, fromCurrent, revision: serverRevision.current, setId: latestDraft.current.setId }));
      setSets(value.sets);
      installDraft(value.draft, "open");
      setActiveSetId(value.activeSetId);
      return value.draft.setId ?? value.activeSetId;
    } catch (e) { setError(`Could not create the set: ${message(e)}`); return null; }
    finally { setSetsBusy(false); }
  }, [installDraft, settleBeforeSwitch]);

  const createSet = useCallback((name?: string) => createFrom(false, name), [createFrom]);
  const duplicateSet = useCallback((name?: string) => createFrom(true, name), [createFrom]);

  const renameSet = useCallback(async (requestedName: string, setId?: string) => {
    const target = setId ?? latestDraft.current.setId, name = requestedName.trim();
    const currentName = target === latestDraft.current.setId ? latestDraft.current.name : undefined;
    if (!target || !name || name === currentName) return false;
    setSetsBusy(true);
    try {
      await json(`/api/prep/sets/${encodeURIComponent(target)}`, send("PATCH", { name }));
      if (latestDraft.current.setId === target) {
        latestDraft.current = { ...latestDraft.current, name };
        setDraftState(latestDraft.current);
      }
      await loadSets();
      return true;
    } catch (e) { setError(`Could not rename the set: ${message(e)}`); return false; }
    finally { setSetsBusy(false); }
  }, [loadSets]);

  const deleteSet = useCallback(async (setId: string) => {
    const deletingActive = setId === latestDraft.current.setId;
    const wasPaused = savePaused.current;
    setSetsBusy(true); setError(null);
    try {
      if (deletingActive) {
        // Its unsaved edits are being thrown away; stop them racing the delete.
        clearTimeout(saveTimer.current);
        savePaused.current = true;
        await drainSaves();
      }
      const value = await json<SetsResult & { draft: ServerDraft }>(`/api/prep/sets/${encodeURIComponent(setId)}`, { method: "DELETE" });
      try { sessionStorage.removeItem(recoveryKey(setId)); } catch { /* Nothing to clear. */ }
      setSets(value.sets);
      setActiveSetId(value.activeSetId);
      // The server moved "active" when the open set was deleted; its response carries that set's draft.
      if (deletingActive) installDraft(value.draft, "open");
      return true;
    } catch (e) {
      if (deletingActive) { savePaused.current = wasPaused; if (!wasPaused) persistLatest(); }
      setError(`Could not delete the set: ${message(e)}`);
      return false;
    } finally { setSetsBusy(false); }
  }, [drainSaves, installDraft, persistLatest]);

  // ---- order ----

  const changeOrder = useCallback((change: (ids: number[]) => number[]) => updateDraft((current) => {
    const next = change(current.trackIds);
    if (next === current.trackIds || sameOrder(next, current.trackIds)) return current;
    orderHistory.current.push(current.trackIds);
    if (orderHistory.current.length > UNDO_LIMIT) orderHistory.current.shift();
    setUndoDepth(orderHistory.current.length);
    return { ...current, trackIds: next };
  }), [updateDraft]);

  const add = useCallback((trackId: number) => changeOrder((ids) => setOrder.append(ids, trackId)), [changeOrder]);
  const insertAt = useCallback((index: number, trackId: number) => changeOrder((ids) => setOrder.insertAt(ids, index, trackId)), [changeOrder]);
  const addMany = useCallback((trackIds: readonly number[]) => changeOrder((ids) => setOrder.appendMany(ids, trackIds)), [changeOrder]);
  const remove = useCallback((index: number) => changeOrder((ids) => setOrder.removeAt(ids, index)), [changeOrder]);
  const removeTrack = useCallback((trackId: number) => changeOrder((ids) => setOrder.removeAt(ids, ids.indexOf(trackId))), [changeOrder]);
  const move = useCallback((index: number, direction: -1 | 1) => changeOrder((ids) => setOrder.moveBy(ids, index, direction)), [changeOrder]);
  const reorder = useCallback((from: number, to: number) => changeOrder((ids) => setOrder.reorder(ids, from, to)), [changeOrder]);

  const undo = useCallback(() => {
    const previous = orderHistory.current.pop();
    setUndoDepth(orderHistory.current.length);
    if (previous) updateDraft((current) => ({ ...current, trackIds: previous }));
  }, [updateDraft]);

  const appendPlaylist = useCallback(async (playlistId: number): Promise<PlaylistAppendResult | null> => {
    if (!hydrated.current) return null;
    const targetSetId = latestDraft.current.setId;
    setPlaylistBusy(true);
    try {
      const value = await json<{ playlist: { id: number; name: string }; trackIds: number[]; unavailable?: number[] }>(`/api/prep/playlist/${playlistId}`);
      if (latestDraft.current.setId !== targetSetId) return null;
      const before = latestDraft.current.trackIds.length;
      changeOrder((ids) => setOrder.appendMany(ids, value.trackIds));
      const added = latestDraft.current.trackIds.length - before;
      return { playlist: value.playlist, added, skipped: value.trackIds.length - added, unavailable: value.unavailable?.length ?? 0 };
    } catch (e) { setError(`Could not add the playlist: ${message(e)}`); return null; }
    finally { setPlaylistBusy(false); }
  }, [changeOrder]);

  const setSeed = useCallback((trackId: number | null) => updateDraft((current) => ({ ...current, seedTrackId: trackId })), [updateDraft]);

  // ---- notes and transitions ----

  const setSetNotes = useCallback((notes: string) => updateDraft((current) => ({ ...current, notes })), [updateDraft]);

  const setTrackNote = useCallback((trackId: number, note: string) => updateDraft((current) => {
    const trackNotes = { ...current.trackNotes };
    if (note) trackNotes[String(trackId)] = note; else delete trackNotes[String(trackId)];
    return { ...current, trackNotes };
  }), [updateDraft]);

  const updateTransition = useCallback((fromId: number, toId: number, patch: TransitionPatch) => updateDraft((current) => {
    const key = transitionKey(fromId, toId);
    return { ...current, transitions: { ...current.transitions, [key]: mergeTransition(current.transitions[key], patch) } };
  }), [updateDraft]);

  const applyPreset = useCallback((fromId: number, toId: number, id: BuiltInPresetId) => updateDraft((current) => {
    const key = transitionKey(fromId, toId);
    return { ...current, transitions: { ...current.transitions, [key]: presetTransition(current.transitions[key], id) } };
  }), [updateDraft]);

  // ---- derived ----

  const trackById = useMemo(() => new Map(tracks.map((track) => [track.id, track])), [tracks]);
  const entries = useMemo(() => draft.trackIds.map((id, index): SetEntry => ({ id, index, track: trackById.get(id) ?? null })), [draft.trackIds, trackById]);
  const inSet = useMemo<ReadonlySet<number>>(() => new Set(draft.trackIds), [draft.trackIds]);
  const getTransition = useCallback((fromId: number, toId: number) =>
    draft.transitions[transitionKey(fromId, toId)] ?? DEFAULT_TRANSITION, [draft.transitions]);
  const pairs = useMemo(() => draft.trackIds.slice(1).map((toId, index): SetPair => {
    const fromId = draft.trackIds[index]!, key = transitionKey(fromId, toId);
    return { fromId, toId, index, key, transition: draft.transitions[key] ?? DEFAULT_TRANSITION };
  }), [draft.trackIds, draft.transitions]);
  const totalDuration = useMemo(() => draft.trackIds.reduce((sum, id) => sum + (trackById.get(id)?.duration ?? 0), 0), [draft.trackIds, trackById]);
  const aiReasons = useMemo<ReadonlyMap<number, string>>(() => new Map(ai?.suggestions.map((s) => [Number(s.candidateId), s.reason]) ?? []), [ai]);

  const loadFailed = !ready && !loading;
  const saveState: SaveState = loading ? "loading" : saving ? "saving" : saveIssue || loadFailed ? "issue" : saved ? "saved" : "pending";
  const canExport = ready && saved && !saving && draft.trackIds.length > 0;
  const hasMissingFiles = gaps.some((gap) => gap.kind === "file") || draft.trackIds.some((id) => !trackById.has(id));
  const canExportPlaylist = canExport && !hasMissingFiles;
  const exportQuery = setQuery(draft.setId);

  const factsValue = useMemo<SetFacts>(() => ({ facts, coverage, factsMessage, factsLoading, refreshingFacts, analysisRevision }),
    [facts, coverage, factsMessage, factsLoading, refreshingFacts, analysisRevision]);

  const actions = useMemo<SetActions>(() => ({
    retryLoad, flush, clearError, resolveKeepMine, resolveUseLatest,
    refreshSets, openSet, createSet, duplicateSet, renameSet, deleteSet,
    add, insertAt, addMany, remove, removeTrack, move, reorder, undo, appendPlaylist, setSeed,
    setSetNotes, setTrackNote, updateTransition, applyPreset,
    refreshFacts, setPrefs, setPlaylistScope, steer, setAiStatus,
  }), [retryLoad, flush, clearError, resolveKeepMine, resolveUseLatest,
    refreshSets, openSet, createSet, duplicateSet, renameSet, deleteSet,
    add, insertAt, addMany, remove, removeTrack, move, reorder, undo, appendPlaylist, setSeed,
    setSetNotes, setTrackNote, updateTransition, applyPreset,
    refreshFacts, setPrefs, setPlaylistScope, steer]);

  const state = useMemo<SetState>(() => ({
    draft, ready, loadFailed, saveState, saveIssue, error, canUndo: undoDepth > 0 && ready,
    sets, activeSetId, setsBusy, canSwitchSets: ready && !setsBusy && saveIssue === null, canDeleteSet: sets.length > 1 && !setsBusy, playlistBusy,
    seedId, entries, pairs, inSet, totalDuration, getTransition,
    prefs, playlistScope, suggestions, suggestionsLoading, aiStatus, ai, aiBusy, aiReasons,
    gaps, hasMissingFiles, canExport, canExportPlaylist,
    runSheetUrl: canExport ? `/api/prep/run-sheet${exportQuery}` : null,
    m3uUrl: canExportPlaylist ? `/api/prep/export.m3u8${exportQuery}` : null,
  }), [draft, ready, loadFailed, saveState, saveIssue, error, undoDepth,
    sets, activeSetId, setsBusy, playlistBusy,
    seedId, entries, pairs, inSet, totalDuration, getTransition,
    prefs, playlistScope, suggestions, suggestionsLoading, aiStatus, ai, aiBusy, aiReasons,
    gaps, hasMissingFiles, canExport, canExportPlaylist, exportQuery]);

  return <SetActionsContext.Provider value={actions}>
    <SetFactsContext.Provider value={factsValue}>
      <SetStateContext.Provider value={state}>{children}</SetStateContext.Provider>
    </SetFactsContext.Provider>
  </SetActionsContext.Provider>;
}
