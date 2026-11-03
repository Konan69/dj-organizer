/**
 * The set: one calm row per track, a slim transition line between each pair,
 * and a side panel for what comes next, set notes and prep checks. Transition
 * detail lives in Studio; every connector is one click away from it.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type FocusEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import type { Track } from "./api";
import type { usePlayer } from "./hooks";
import { COMPAT_LABEL, bpmShift, compat, fmtBpm, parseKey, type Compat } from "./keys";
import { OpenRouterSettings } from "./OpenRouterSettings";
import {
  TRANSITION_PRESETS, rehearsalOf, resolveTransitionMix, useSet,
  type PrepGap, type RehearsalState, type SaveIssue, type SetPair, type SuggestionCandidate, type SuggestionPriority, type TrackFacts, type TransitionPrep,
} from "./setStore";
import { AddButton, Art, EmptyState, Icon, KeyBadge, Popover, Segmented, fmtLength, fmtTotal } from "./ui";
import "./setview.css";

export type SetViewProps = {
  /** Library tracks, for titles, art and length. */
  tracks: Track[];
  /** Preview playback shared with the player bar. */
  player: ReturnType<typeof usePlayer>;
  /** "Add tracks" / "Browse library": go to the Library view. */
  onBrowseLibrary: () => void;
  /** Open Studio focused on one pair. */
  onOpenTransition: (fromId: number, toId: number) => void;
  /** The view is on screen; keyboard shortcuts are live only then. */
  active: boolean;
};

// ---- wording -----------------------------------------------------------------

const cls = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(" ");
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const titleOf = (track: Track | null | undefined) => (track ? track.title ?? track.filename : "Unavailable track");
const firstLine = (text: string) => text.split("\n").find((line) => line.trim())?.trim() ?? "";

/** Same reading as Studio's transition chips: boost is blue, never the coral "press this". */
const COMPAT_TONE: Record<Compat, string> = { same: "ok", smooth: "ok", boost: "info", clash: "danger", unknown: "" };

const REHEARSAL: Record<RehearsalState, string> = { "not-tried": "Not tried", "needs-work": "Needs work", works: "Works on decks" };

const PRIORITIES: { value: SuggestionPriority; label: string }[] = [
  { value: "balanced", label: "Balanced" },
  { value: "tempo", label: "Closer tempo" },
  { value: "key", label: "Closer key" },
];

const ISSUE_COPY: Record<SaveIssue["kind"], { text: string; keep: string; drop: string }> = {
  recovered: { text: "Unsaved changes restored.", keep: "Save", drop: "Discard" },
  conflict: { text: "This set changed in another tab.", keep: "Keep mine", drop: "Use saved" },
  failed: { text: "Couldn’t save your last change.", keep: "Retry", drop: "Use saved" },
};

/** Tempo move between two tracks as a DJ reads it: a pitch percentage, or half/double time. */
function tempoMove(from: number | null | undefined, to: number | null | undefined) {
  const shift = bpmShift(from, to);
  if (shift === null || !from || !to) return null;
  const title = `${fmtBpm(from)} to ${fmtBpm(to)} BPM`;
  const ratio = to / from;
  if (Math.abs(ratio - 2) < 0.12) return { text: "Double time", far: false, title };
  if (Math.abs(ratio - 0.5) < 0.03) return { text: "Half time", far: false, title };
  if (Math.abs(shift) < 0.05) return { text: "Same tempo", far: false, title };
  return { text: `${shift > 0 ? "+" : "−"}${Math.abs(shift).toFixed(1)}%`, far: Math.abs(shift) > 6, title };
}

/** "Bass swap · 16 bars", or null when nothing is planned yet. */
function plannedMix(transition: TransitionPrep): string | null {
  const mix = resolveTransitionMix(transition);
  if (mix.explicit || transition.bars !== undefined) {
    const name = mix.preset === "custom" ? "Custom" : TRANSITION_PRESETS[mix.preset].label;
    return `${name} · ${plural(mix.bars, "bar", "bars")}`;
  }
  return transition.mixOut || transition.mixIn ? "Mix points" : null;
}

/** Why a candidate fits, in plain words, from the server's measured facts. Shown as a tooltip. */
function candidateReason(candidate: SuggestionCandidate, seedBpm: number | null): string | null {
  const tempo = candidate.evidence.find((e) => e.signal === "tempo" && e.kind === "measured")?.detail ?? "";
  let words: string | null = null;
  if (tempo.includes("double-tempo")) words = "Mixes in at double time";
  else if (tempo.includes("half-tempo")) words = "Mixes in at half time";
  else {
    const shift = bpmShift(seedBpm, candidate.bpm);
    if (shift !== null) {
      const size = Math.abs(shift);
      words = size < 0.5 ? "Same tempo"
        : size < 3 ? "Nearly the same tempo"
        : size < 6 ? (shift > 0 ? "A touch faster" : "A touch slower")
        : shift > 0 ? "Much faster, a big tempo ride" : "Much slower, a big tempo ride";
    }
  }
  if (!candidate.cueCount) return words;
  return words ? `${words}, cue points ready` : "Cue points ready";
}

/** A prep check as "what's wrong" in 1–3 words, with the fix for the tooltip. */
function gapIssue(gap: PrepGap, facts: ReadonlyMap<number, TrackFacts>): { issue: string; fix: string } {
  if (gap.kind === "file") return { issue: "File missing", fix: "Restore the file, or remove the track from the set." };
  if (facts.get(gap.trackId)?.sourceId === null) return { issue: "Not in Rekordbox", fix: "Import it into Rekordbox, then check again." };
  const bpm = gap.missing.includes("BPM"), key = gap.missing.includes("key");
  const issue = bpm && key ? "No BPM or key" : bpm ? "No BPM" : key ? "No key" : "No waveform";
  return { issue, fix: "Analyze it in Rekordbox, then check again." };
}

// ---- small pieces ----------------------------------------------------------------

function Item({ icon, children, hint, onClick, disabled, danger }: {
  icon: ReactNode; children: ReactNode; hint?: ReactNode; onClick: () => void; disabled?: boolean; danger?: boolean;
}) {
  return (
    <button type="button" role="menuitem" className={cls("item", danger && "danger")} disabled={disabled} onClick={onClick}>
      {icon}<span>{children}</span>{hint ? <span className="hint">{hint}</span> : null}
    </button>
  );
}

/** Menu body: focuses the first item on open; arrows, Home and End move between items. */
function MenuBody({ children, className, onLeave }: { children: ReactNode; className?: string; onLeave: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const items = () => [...(ref.current?.querySelectorAll<HTMLElement>(".item:not(:disabled):not([aria-disabled='true'])") ?? [])];
  useEffect(() => { items()[0]?.focus(); }, []);
  const onKeyDown = (e: ReactKeyboardEvent) => {
    const list = items();
    if (!list.length || !["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const at = list.indexOf(document.activeElement as HTMLElement);
    const next = e.key === "Home" ? 0 : e.key === "End" ? list.length - 1
      : e.key === "ArrowDown" ? (at + 1) % list.length : (at - 1 + list.length) % list.length;
    list[next]?.focus();
  };
  // Tabbing out of the menu closes it, so it never lingers behind the focus.
  const onBlur = (e: FocusEvent<HTMLDivElement>) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onLeave(); };
  return <div ref={ref} role="none" className={className} onKeyDown={onKeyDown} onBlur={onBlur}>{children}</div>;
}

function NoteEditor({ value, onChange, onDone }: { value: string; onChange: (value: string) => void; onDone: (refocus: boolean) => void }) {
  return (
    <div className="sv-note-edit">
      <label className="ui-field">
        <span>Note</span>
        <input
          autoFocus value={value} placeholder="Start at the second drop" onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onDone(true); } }}
          onBlur={() => onDone(false)}
        />
      </label>
    </div>
  );
}

/** Rehearsal state carried by shape as well as colour: ring, dot, check. */
function RehearsalMark({ state }: { state: RehearsalState }) {
  const label = REHEARSAL[state];
  return (
    <span className={cls("sv-rehearsal", state)} title={label}>
      {state === "works" ? <Icon name="check" size={14} stroke={2.2} /> : <span className="ui-dot" aria-hidden="true" />}
      <span className="sr-only">{label}</span>
    </span>
  );
}

function Connector({ pair, fromTitle, toTitle, from, to, onOpen, onDragOver }: {
  pair: SetPair; fromTitle: string; toTitle: string; from: TrackFacts | null; to: TrackFacts | null;
  onOpen: () => void; onDragOver: (e: DragEvent<HTMLElement>) => void;
}) {
  const a = parseKey(from?.key), b = parseKey(to?.key);
  const match = compat(a, b);
  const tempo = tempoMove(from?.bpm, to?.bpm);
  const planned = plannedMix(pair.transition);
  const note = pair.transition.notes.trim();
  return (
    <button type="button" className="sv-conn" title="Edit in Studio" onClick={onOpen} onDragOver={onDragOver}>
      <span className="sr-only">Transition from {fromTitle} into {toTitle}: </span>
      <span className="sv-conn-icon" aria-hidden="true"><Icon name="transition" size={16} /></span>
      {a && b ? (
        <span className="sv-conn-keys">
          {`${a.num}${a.letter}`}<span aria-hidden="true"> → </span><span className="sr-only"> to </span>{`${b.num}${b.letter}`}
        </span>
      ) : null}
      <span className={cls("ui-tag", COMPAT_TONE[match])}>{COMPAT_LABEL[match]}</span>
      {tempo ? <span className={cls("sv-conn-tempo", tempo.far && "far")} title={tempo.title}>{tempo.text}</span> : null}
      <span className={cls("ui-tag", "sv-plan", !planned && "none")}>{planned ?? "Not planned"}</span>
      <RehearsalMark state={rehearsalOf(pair.transition)} />
      {note ? (
        <span className="sv-conn-note" title={note}>
          <Icon name="notes" size={15} /><span className="sr-only">Note: {firstLine(note)}</span>
        </span>
      ) : null}
      <span className="sv-conn-go" aria-hidden="true"><Icon name="chevronRight" size={16} /></span>
      <span className="sr-only">Edit in Studio</span>
    </button>
  );
}

// ---- the view -------------------------------------------------------------------

type Pick = { id: number; title: string; artist: string | null; bpm: number | null; key: string | null; reason: string | null };

export function SetView({ tracks, player, onBrowseLibrary, onOpenTransition, active }: SetViewProps) {
  const set = useSet();
  const {
    draft, entries, pairs, facts, ready, loadFailed, saveState, saveIssue, error, canUndo, seedId, inSet, totalDuration,
    prefs, suggestions, suggestionsLoading, aiStatus, ai, aiBusy, aiReasons, gaps, refreshingFacts,
    canExport, hasMissingFiles, runSheetUrl, m3uUrl,
  } = set;

  const trackById = useMemo(() => new Map(tracks.map((track) => [track.id, track])), [tracks]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [menu, setMenu] = useState<{ index: number; anchor: DOMRect; trigger: HTMLElement | null } | null>(null);
  const [exportMenu, setExportMenu] = useState<{ anchor: DOMRect; trigger: HTMLElement } | null>(null);
  const [editingNote, setEditingNote] = useState<number | null>(null);
  const [drag, setDrag] = useState<{ from: number; at: number | null } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [intent, setIntent] = useState("");
  const [showAi, setShowAi] = useState(false);
  const [aiSetupOpen, setAiSetupOpen] = useState(false);
  const rowRefs = useRef(new Map<number, HTMLDivElement>());

  const ids = draft.trackIds;
  const n = entries.length;
  const selected = selectedId !== null && inSet.has(selectedId) ? selectedId : null;
  const selectedIndex = selected === null ? -1 : ids.indexOf(selected);
  const loading = saveState === "loading";
  const factsFor = (id: number) => facts.get(id) ?? null;

  const preview = useCallback((id: number) => {
    if (player.playingId === id) player.toggle(); else player.play(id);
  }, [player]);

  const focusRow = useCallback((id: number) => {
    setSelectedId(id);
    // After a reorder React may have moved the node; focus once the DOM settles.
    requestAnimationFrame(() => {
      const el = rowRefs.current.get(id);
      el?.focus();
      el?.scrollIntoView({ block: "nearest" });
    });
  }, []);

  // ---- order edits, each announced for screen readers ----

  const nameAt = (index: number) => titleOf(entries[index]?.track);
  const moveTrack = (from: number, to: number) => {
    const id = ids[from];
    if (id === undefined || from === to) return;
    set.reorder(from, to);
    setAnnouncement(`${nameAt(from)} moved to position ${to + 1}.`);
    focusRow(id);
  };
  const removeAt = (index: number) => {
    const title = nameAt(index);
    const fallback = ids[index + 1] ?? ids[index - 1];
    set.remove(index);
    setAnnouncement(`${title} removed. Undo with Control Z.`);
    if (fallback !== undefined) focusRow(fallback);
  };
  /** Suggestions follow the seed: a pick lands right after it, and the chain continues from the pick. */
  const addPick = (id: number, title: string) => {
    const explicit = draft.seedTrackId === null ? -1 : ids.indexOf(draft.seedTrackId);
    if (explicit >= 0 && explicit < ids.length - 1) {
      set.insertAt(explicit + 1, id);
      set.setSeed(id);
      setAnnouncement(`${title} added at position ${explicit + 2}.`);
    } else {
      set.add(id);
      if (draft.seedTrackId !== null) set.setSeed(null);
      setAnnouncement(`${title} added at the end.`);
    }
  };
  const suggestAfter = (index: number) => set.setSeed(index === ids.length - 1 ? null : ids[index] ?? null);
  const openStudioFor = (index: number) => {
    const id = ids[index], next = ids[index + 1], prev = ids[index - 1];
    if (id === undefined) return;
    if (next !== undefined) onOpenTransition(id, next);
    else if (prev !== undefined) onOpenTransition(prev, id);
  };

  // ---- drag to reorder ----

  const dropAt = drag && drag.at !== null && drag.at !== drag.from && drag.at !== drag.from + 1 ? drag.at : null;
  const onRowDragStart = (index: number) => (e: DragEvent<HTMLDivElement>) => {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(ids[index]));
    setMenu(null);
    setDrag({ from: index, at: null });
  };
  const overAt = (at: number) => (e: DragEvent<HTMLElement>) => {
    if (!drag) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (drag.at !== at) setDrag({ ...drag, at });
  };
  const onRowDragOver = (index: number) => (e: DragEvent<HTMLElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    overAt(e.clientY < rect.top + rect.height / 2 ? index : index + 1)(e);
  };
  const onDrop = (e: DragEvent<HTMLElement>) => {
    if (!drag) return;
    e.preventDefault();
    const { from } = drag;
    setDrag(null);
    if (dropAt !== null) moveTrack(from, dropAt > from ? dropAt - 1 : dropAt);
  };

  // ---- keyboard: space previews, arrows move between rows, alt+arrows reorder, ctrl/cmd+z undoes ----

  const onKey = useRef<(e: KeyboardEvent) => void>(() => {});
  useEffect(() => {
    onKey.current = (e) => {
      if (e.defaultPrevented || menu || exportMenu) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable) return;
      // A dialog over the view owns the keyboard; Ctrl+Z there must not reorder the set behind it.
      if (target?.closest?.("[aria-modal='true']")) return;
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "z") {
        if (canUndo) { e.preventDefault(); set.undo(); setAnnouncement("Order change undone."); }
        return;
      }
      // Buttons and links keep their own Space/Enter; only rows and the page itself are ours.
      const free = !target || target === document.body || target.dataset.svRow !== undefined;
      if (!free) return;
      if (e.key === " ") {
        const entry = entries[selectedIndex];
        if (entry?.track) { e.preventDefault(); preview(entry.id); }
        else if (player.playingId !== null) { e.preventDefault(); player.toggle(); }
        return;
      }
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      const step = e.key === "ArrowDown" ? 1 : -1;
      if (e.altKey) {
        const to = selectedIndex + step;
        if (selectedIndex < 0 || to < 0 || to >= ids.length) return;
        e.preventDefault();
        moveTrack(selectedIndex, to);
        return;
      }
      const next = ids[selectedIndex < 0 ? (step > 0 ? 0 : ids.length - 1) : selectedIndex + step];
      if (next !== undefined) { e.preventDefault(); focusRow(next); }
    };
  });
  useEffect(() => {
    if (!active) return;
    const handler = (e: KeyboardEvent) => onKey.current(e);
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [active]);

  // ---- header facts and export state ----

  const bpms = entries.map((entry) => facts.get(entry.id)?.bpm).filter((bpm): bpm is number => !!bpm);
  const lo = bpms.length ? Math.round(Math.min(...bpms)) : 0, hi = bpms.length ? Math.round(Math.max(...bpms)) : 0;
  const bpmRange = !bpms.length ? null : lo === hi ? `${lo} BPM` : `${lo}–${hi} BPM`;
  const meta = n ? [plural(n, "track", "tracks"), totalDuration ? fmtTotal(totalDuration) : null, bpmRange].filter(Boolean).join(" · ") : "No tracks yet";

  const missingCount = new Set([
    ...entries.filter((entry) => !entry.track || entry.track.pendingDelete).map((entry) => entry.id),
    ...gaps.filter((gap) => gap.kind === "file").map((gap) => gap.trackId),
  ]).size;
  const waitReason = !n ? "Add tracks first" : saveIssue ? "Fix the save first" : loadFailed ? "Set didn’t load" : "Waiting for save";
  const runSheetReason = canExport ? null : waitReason;
  const m3uReason = !canExport ? waitReason
    : hasMissingFiles ? (missingCount === 1 ? "1 file missing" : `${missingCount || "Some"} files missing`)
    : null;

  // ---- up next ----

  const seedEntry = entries.find((entry) => entry.id === seedId) ?? null;
  const seedBpm = suggestions?.seed?.bpm ?? (seedId === null ? null : facts.get(seedId)?.bpm ?? null);
  const seedKey = parseKey(suggestions?.seed?.key ?? (seedId === null ? null : facts.get(seedId)?.key));
  const aiOn = showAi && ai !== null;
  const picks: Pick[] = aiOn
    ? ai.suggestions.flatMap((s): Pick[] => {
      const id = Number(s.candidateId), track = trackById.get(id), f = facts.get(id);
      return track ? [{ id, title: titleOf(track), artist: track.artist, bpm: f?.bpm ?? null, key: f?.key ?? null, reason: s.reason }] : [];
    })
    : (suggestions?.candidates ?? []).map((c): Pick => {
      const track = trackById.get(c.trackId);
      return {
        id: c.trackId, title: track ? titleOf(track) : c.title, artist: track?.artist ?? c.artist, bpm: c.bpm, key: c.key,
        reason: aiReasons.get(c.trackId) ?? candidateReason(c, seedBpm),
      };
    });
  const pending = suggestionsLoading || aiBusy;

  const steer = async () => {
    if (!intent.trim() || seedId === null) return;
    setShowAi(true);
    await set.steer(intent);
  };

  // ---- render ----

  const rovingIndex = selectedIndex >= 0 ? selectedIndex : 0;
  const issueCopy = saveIssue ? ISSUE_COPY[saveIssue.kind] : null;
  const menuEntry = menu ? entries[menu.index] ?? null : null;
  const closeMenu = (refocus = true) => {
    const trigger = menu?.trigger;
    setMenu(null);
    if (refocus) trigger?.focus();
  };
  const menuAction = (action: () => void) => () => { closeMenu(false); action(); };

  return (
    <div className="sv">
      <section className="sv-main" aria-labelledby="sv-name">
        <header className="sv-head">
          <div className="sv-head-text">
            <h1 id="sv-name" className="sv-name">{loading ? <span className="ui-skel sv-skel-name" aria-label="Loading set" /> : draft.name ?? "Untitled set"}</h1>
            {loading ? null : <p className="sv-meta">{meta}</p>}
          </div>
          <div className="sv-actions">
            <button type="button" className="ui-icon-btn" aria-label="Undo" title="Undo (Ctrl+Z)" disabled={!canUndo}
              onClick={() => { set.undo(); setAnnouncement("Order change undone."); }}>
              <Icon name="undo" />
            </button>
            <button
              type="button" className="ui-btn outline" aria-haspopup="menu" aria-expanded={exportMenu !== null}
              onClick={(e) => setExportMenu({ anchor: e.currentTarget.getBoundingClientRect(), trigger: e.currentTarget })}
            ><Icon name="export" />Export</button>
            {ready && n ? <button type="button" className="ui-btn primary" onClick={onBrowseLibrary}><Icon name="plus" stroke={2.2} />Add tracks</button> : null}
          </div>
        </header>

        {saveIssue && issueCopy ? (
          <div className={cls("sv-banner", saveIssue.kind !== "recovered" && "error")} role={saveIssue.kind === "recovered" ? "status" : "alert"}>
            <span className="ui-dot" aria-hidden="true" />
            <p className="sv-banner-text" title={saveIssue.message}>{issueCopy.text}</p>
            <div className="sv-banner-actions">
              <button type="button" className="ui-btn sm" onClick={set.resolveKeepMine}>{issueCopy.keep}</button>
              <button type="button" className="ui-btn sm ghost" onClick={() => void set.resolveUseLatest()}>{issueCopy.drop}</button>
            </div>
          </div>
        ) : null}
        {error ? (
          <div className="sv-banner error" role="alert">
            <span className="ui-dot" aria-hidden="true" />
            <p className="sv-banner-text">{error}</p>
            <div className="sv-banner-actions">
              <button type="button" className="ui-icon-btn sm" aria-label="Dismiss" title="Dismiss" onClick={set.clearError}><Icon name="x" /></button>
            </div>
          </div>
        ) : null}

        <div className="sv-scroll">
          {loading ? (
            <div aria-hidden="true">
              {[0, 1, 2, 3, 4].map((i) => (
                <div key={i} className="sv-skel-row"><span className="ui-skel a" /><span className="t"><span className="ui-skel" /><span className="ui-skel" /></span></div>
              ))}
            </div>
          ) : loadFailed ? (
            <EmptyState
              title="Your set didn’t open"
              action={<button type="button" className="ui-btn primary" onClick={() => void set.retryLoad()}>Try again</button>}
            >Check that the app’s server is running.</EmptyState>
          ) : !n ? (
            <EmptyState
              title="Start your set"
              action={<button type="button" className="ui-btn primary" onClick={onBrowseLibrary}><Icon name="library" />Browse library</button>}
            />
          ) : (
            <ol
              className="sv-list" aria-label="Set order" onDrop={onDrop}
              onDragOver={(e) => { if (drag && e.target === e.currentTarget) e.preventDefault(); }}
            >
              {entries.map((entry, index) => {
                const { id, track } = entry;
                const title = titleOf(track);
                const f = factsFor(id);
                const note = draft.trackNotes[String(id)] ?? "";
                const current = player.playingId === id;
                const pair = pairs[index];
                return (
                  <li key={id}>
                    <div
                      ref={(el) => { if (el) rowRefs.current.set(id, el); else rowRefs.current.delete(id); }}
                      data-sv-row="" role="group" aria-label={`${index + 1}. ${title}`}
                      tabIndex={index === rovingIndex ? 0 : -1}
                      className={cls(
                        "sv-row", selected === id && "selected", current && "current", !track && "missing",
                        drag?.from === index && "dragging", dropAt === index && "drop-before", dropAt === n && index === n - 1 && "drop-after",
                      )}
                      draggable
                      onDragStart={onRowDragStart(index)} onDragOver={onRowDragOver(index)} onDragEnd={() => setDrag(null)}
                      onFocus={() => setSelectedId(id)}
                      onDoubleClick={() => { if (track) preview(id); }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setSelectedId(id);
                        setMenu({ index, anchor: new DOMRect(e.clientX, e.clientY, 0, 0), trigger: e.currentTarget });
                      }}
                    >
                      <span className="sv-handle" aria-hidden="true" title="Drag to reorder"><Icon name="drag" size={16} /></span>
                      <span className="sv-index">{index + 1}</span>
                      {track
                        ? <Art trackId={id} label={title} size={52} playing={current && !player.paused} onPlay={() => preview(id)} />
                        : <span className="ui-art sv-art-missing" aria-hidden="true" />}
                      <div className="sv-text">
                        <span className="sv-title" title={title}>{title}</span>
                        {!track ? (
                          <span className="sv-sub"><span className="ui-tag danger">File missing</span></span>
                        ) : track.pendingDelete ? (
                          <span className="sv-sub"><span className="ui-tag danger">Marked for deletion</span></span>
                        ) : (
                          <span className="sv-artist" title={track.artist ?? undefined}>{track.artist ?? "Unknown artist"}</span>
                        )}
                        {note && editingNote !== id ? (
                          <button type="button" className="sv-note" title={note} aria-label={`Edit note: ${note}`} onClick={() => setEditingNote(id)}>{firstLine(note)}</button>
                        ) : null}
                      </div>
                      <KeyBadge value={f?.key} />
                      <span className="sv-bpm" title={f?.bpm ? `${fmtBpm(f.bpm)} BPM` : "BPM unknown"}>
                        {fmtBpm(f?.bpm)}<span className="sr-only"> BPM</span>
                      </span>
                      <span className="sv-len">{fmtLength(track?.duration)}</span>
                      <button
                        type="button" className="ui-icon-btn sv-more" aria-label={`More for ${title}`} title="More" aria-haspopup="menu"
                        aria-expanded={menu?.index === index}
                        onClick={(e) => setMenu({ index, anchor: e.currentTarget.getBoundingClientRect(), trigger: e.currentTarget })}
                      ><Icon name="more" /></button>
                    </div>
                    {editingNote === id ? (
                      <NoteEditor
                        value={note} onChange={(value) => set.setTrackNote(id, value)}
                        onDone={(refocus) => { setEditingNote(null); if (refocus) focusRow(id); }}
                      />
                    ) : null}
                    {pair ? (
                      <Connector
                        pair={pair} fromTitle={title} toTitle={titleOf(entries[index + 1]?.track)} from={f} to={factsFor(pair.toId)}
                        onOpen={() => onOpenTransition(pair.fromId, pair.toId)} onDragOver={overAt(index + 1)}
                      />
                    ) : null}
                  </li>
                );
              })}
            </ol>
          )}
        </div>
        <div className="sr-only" role="status" aria-live="polite">{announcement}</div>
      </section>

      <aside className="sv-panel" aria-label="Plan the set">
        {seedEntry ? (
          <section className="sv-sec" aria-labelledby="sv-upnext">
            <div className="sv-sec-head">
              <div>
                <h2 id="sv-upnext" className="sv-sec-title">Up next</h2>
                <p className="sv-after" title={titleOf(seedEntry.track)}>after <b>{titleOf(seedEntry.track)}</b></p>
              </div>
              {aiOn ? (
                <button type="button" className="ui-btn ghost sm" title="Back to the usual picks" onClick={() => setShowAi(false)}>Clear</button>
              ) : null}
            </div>

            <div className="sv-prefs">
              <Segmented<SuggestionPriority>
                label="Prioritize" value={prefs.priority} options={PRIORITIES} onChange={(priority) => set.setPrefs({ priority })}
              />
              <button
                type="button" role="switch" className="sv-switch" aria-checked={prefs.allowHalfDouble}
                title="Also match tracks at half or double tempo"
                onClick={() => set.setPrefs({ allowHalfDouble: !prefs.allowHalfDouble })}
              >
                <span className="sv-switch-track" aria-hidden="true"><span className="sv-switch-knob" /></span>
                Half/double tempo
              </button>
            </div>

            {pending && !picks.length ? (
              <div className="sv-cand-skels" aria-hidden="true">{[0, 1, 2].map((i) => <div key={i} className="ui-skel sv-cand-skel" />)}</div>
            ) : picks.length ? (
              <ul className="sv-cands" aria-label={`After ${titleOf(seedEntry.track)}`} aria-busy={pending}>
                {picks.map((pick) => {
                  const match = compat(seedKey, parseKey(pick.key));
                  const current = player.playingId === pick.id;
                  return (
                    <li key={pick.id} className={cls("sv-cand", current && "current")} title={pick.reason ?? undefined}>
                      <Art trackId={pick.id} label={pick.title} size={40} playing={current && !player.paused} onPlay={() => preview(pick.id)} />
                      <div className="sv-cand-text">
                        <span className="sv-cand-title">{pick.title}</span>
                        <span className="sv-cand-artist" title={pick.artist ?? undefined}>{pick.artist ?? "Unknown artist"}</span>
                        <span className="sv-cand-why"><span className={cls("ui-tag", COMPAT_TONE[match])}>{COMPAT_LABEL[match]}</span></span>
                      </div>
                      <KeyBadge value={pick.key} size="sm" />
                      <span className="sv-cand-bpm">{fmtBpm(pick.bpm)}<span className="sr-only"> BPM</span></span>
                      <AddButton added={inSet.has(pick.id)} disabled={!ready} label={pick.title} onClick={() => addPick(pick.id, pick.title)} />
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="sv-quiet">{seedEntry.track ? "No close matches" : "File missing"}</p>
            )}

            {seedEntry.track && aiStatus?.configured ? (
              <form className="sv-steer-row" onSubmit={(e) => { e.preventDefault(); void steer(); }}>
                <div className="ui-field">
                  <Icon name="sparkle" />
                  <input
                    aria-label="Describe the vibe" value={intent} placeholder="Describe the vibe…" autoComplete="off"
                    onChange={(e) => setIntent(e.target.value)}
                  />
                </div>
                <button type="submit" className="ui-btn ghost" disabled={aiBusy || !intent.trim()}>{aiBusy ? "Steering…" : "Steer"}</button>
              </form>
            ) : seedEntry.track && aiStatus ? (
              <>
                <button type="button" className="sv-link" aria-expanded={aiSetupOpen} onClick={() => setAiSetupOpen((open) => !open)}>Set up AI</button>
                {aiSetupOpen ? <div className="sv-ai-setup"><OpenRouterSettings status={aiStatus} onStatus={set.setAiStatus} /></div> : null}
              </>
            ) : null}
          </section>
        ) : null}

        <section className="sv-sec" aria-labelledby="sv-notes">
          <h2 id="sv-notes" className="sv-sec-title">Set notes</h2>
          <textarea
            className="ui-textarea" aria-labelledby="sv-notes" disabled={!ready} value={draft.notes}
            placeholder="Opening idea, backup plan…" onChange={(e) => set.setSetNotes(e.target.value)}
          />
        </section>

        {gaps.length ? (
          <section className="sv-sec" aria-labelledby="sv-prep">
            <div className="sv-sec-head">
              <h2 id="sv-prep" className="sv-sec-title">Before you play</h2>
              <button type="button" className="ui-icon-btn sm" aria-label="Check again" title="Check again" disabled={refreshingFacts} onClick={() => void set.refreshFacts()}>
                <Icon name="sync" className={refreshingFacts ? "sv-spin" : undefined} />
              </button>
            </div>
            <ul className="sv-checks">
              {gaps.map((gap) => {
                const index = ids.indexOf(gap.trackId);
                const track = trackById.get(gap.trackId);
                const title = gap.kind === "file" ? `Track ${index + 1}` : track ? titleOf(track) : gap.title;
                const { issue, fix } = gapIssue(gap, facts);
                return (
                  <li key={gap.id}>
                    <button
                      type="button" className={cls("sv-check", gap.kind === "file" && "danger")} title={`${title}: ${fix}`}
                      disabled={index < 0} onClick={() => focusRow(gap.trackId)}
                    >
                      <span className="ui-dot" aria-hidden="true" />
                      <span className="sv-check-title">{title}</span>
                      <span className="sv-check-issue">{issue}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}
      </aside>

      {menu && menuEntry ? (
        <Popover anchor={menu.anchor} onClose={() => closeMenu()} width={230} align={menu.trigger instanceof HTMLButtonElement ? "end" : "start"}>
          <MenuBody onLeave={() => closeMenu(false)}>
            <Item icon={<Icon name="sparkle" />} disabled={!menuEntry.track} onClick={menuAction(() => suggestAfter(menu.index))}>Suggest after</Item>
            <Item icon={<Icon name="edit" />} onClick={menuAction(() => setEditingNote(menuEntry.id))}>
              {draft.trackNotes[String(menuEntry.id)] ? "Edit note" : "Add note"}
            </Item>
            <Item icon={<Icon name="studio" />} disabled={n < 2} onClick={menuAction(() => openStudioFor(menu.index))}>Open in Studio</Item>
            <div className="sep" role="separator" />
            <Item icon={<Icon name="chevronDown" className="sv-flip" />} hint="Alt+Up" disabled={menu.index === 0} onClick={menuAction(() => moveTrack(menu.index, menu.index - 1))}>Move up</Item>
            <Item icon={<Icon name="chevronDown" />} hint="Alt+Down" disabled={menu.index === n - 1} onClick={menuAction(() => moveTrack(menu.index, menu.index + 1))}>Move down</Item>
            <div className="sep" role="separator" />
            <Item icon={<Icon name="trash" />} danger onClick={menuAction(() => removeAt(menu.index))}>Remove</Item>
          </MenuBody>
        </Popover>
      ) : null}

      {exportMenu ? (
        <Popover anchor={exportMenu.anchor} align="end" width={270} onClose={() => { setExportMenu(null); exportMenu.trigger.focus(); }}>
          <MenuBody className="sv-export" onLeave={() => setExportMenu(null)}>
            {runSheetUrl ? (
              <a className="item" role="menuitem" href={runSheetUrl} target="_blank" rel="noreferrer" onClick={() => setExportMenu(null)}>
                <Icon name="notes" /><span>Run sheet</span>
              </a>
            ) : (
              <div className="item" role="menuitem" aria-disabled="true">
                <Icon name="notes" />
                <span className="sv-export-text"><span>Run sheet</span><small>{runSheetReason}</small></span>
              </div>
            )}
            {m3uUrl ? (
              <a className="item" role="menuitem" href={m3uUrl} download title="Track order to import into Rekordbox" onClick={() => setExportMenu(null)}>
                <Icon name="playlist" /><span>Rekordbox playlist (M3U8)</span>
              </a>
            ) : (
              <div className="item" role="menuitem" aria-disabled="true">
                <Icon name="playlist" />
                <span className="sv-export-text"><span>Rekordbox playlist (M3U8)</span><small>{m3uReason}</small></span>
              </div>
            )}
          </MenuBody>
        </Popover>
      ) : null}
    </div>
  );
}
