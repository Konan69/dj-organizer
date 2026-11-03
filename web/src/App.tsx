import { useCallback, useEffect, useRef, useState } from "react";
import { api, unwrap, type State } from "./api";
import { ChangesModal, DuplicatesModal, UpstreamModal } from "./Modals";
import { OpsModal, StoresModal } from "./Stores";
import { StagingModal } from "./Staging";
import { Learn } from "./Learn";
import { Library } from "./Library";
import { SetView } from "./SetView";
import { Studio } from "./Studio";
import { SetProvider, useSet, useTrackFacts } from "./setStore";
import { fmtTime, useToast, usePlayer } from "./hooks";
import { fmtBpm } from "./keys";
import { Art, Icon, KeyBadge, MenuItem, Popover, Toast, ToastRegion, fmtTotal } from "./ui";
import { VisualizeButton } from "./Visualize";
import "./theme.css";
import "./shell.css";

type ViewName = "library" | "set" | "studio" | "learn";
type Modal = null | "dupes" | "changes" | "upstream" | "stores" | "ops" | "staging";
type Player = ReturnType<typeof usePlayer>;

const VIEW_KEY = "dj-organizer-view-v2";
const readView = (): ViewName => {
  const v = localStorage.getItem(VIEW_KEY);
  return v === "library" || v === "set" || v === "studio" || v === "learn" ? v : "library";
};

export function App() {
  const [state, setState] = useState<State | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const { toast, show, dismiss } = useToast();
  const player = usePlayer();

  const load = useCallback(async () => {
    try { setState(await unwrap(api.state.get())); setLoadError(null); }
    catch (e) { setLoadError((e as Error).message); show((e as Error).message, "err"); }
  }, [show]);

  useEffect(() => { void load(); }, [load]);

  if (!state) {
    return (
      <div className="shell boot">
        <div />
        <div className="ui-empty">
          <div className="title">{loadError ? "Couldn't reach the library" : "Opening your library…"}</div>
          {loadError ? <p>{loadError}. Check that the server is running, then try again.</p> : null}
          {loadError ? <button className="ui-btn primary" onClick={() => void load()}>Try again</button> : null}
        </div>
        <ToastRegion msg={toast?.msg} />
      </div>
    );
  }

  return (
    <SetProvider tracks={state.tracks}>
      <Shell state={state} load={load} player={player} notify={show} />
      {toast ? <Toast msg={toast.msg} kind={toast.kind} onDismiss={dismiss} /> : null}
      <ToastRegion msg={toast?.msg} />
    </SetProvider>
  );
}

function Shell({ state, load, player, notify }: {
  state: State; load: () => Promise<void>; player: Player;
  notify: (msg: string, kind?: "" | "ok" | "err") => void;
}) {
  const [view, setViewState] = useState<ViewName>(readView);
  /** Views stay mounted once opened so filters, scroll and zoom survive a tab switch. */
  const [visited, setVisited] = useState<Set<ViewName>>(() => new Set([readView()]));
  const [modal, setModal] = useState<Modal>(null);
  const [focusPair, setFocusPair] = useState<{ fromId: number; toId: number } | null>(null);

  const go = useCallback((next: ViewName) => {
    setViewState(next);
    setVisited((v) => (v.has(next) ? v : new Set(v).add(next)));
    localStorage.setItem(VIEW_KEY, next);
  }, []);

  const openTransition = useCallback((fromId: number, toId: number) => {
    setFocusPair({ fromId, toId });
    go("studio");
  }, [go]);

  const pane = (name: ViewName, node: React.ReactNode) =>
    visited.has(name) ? <div className="view" hidden={view !== name} key={name}>{node}</div> : null;

  const showPlayer = view === "library" || view === "set";

  return (
    <div className="shell">
      <TopBar state={state} view={view} onView={go} onModal={setModal} />

      {pane("library", <Library state={state} reload={load} player={player} notify={notify} active={view === "library"} />)}
      {pane("set", <SetView
        tracks={state.tracks} player={player} active={view === "set"}
        onBrowseLibrary={() => go("library")} onOpenTransition={openTransition}
      />)}
      {pane("studio", <Studio
        tracks={state.tracks} player={player} active={view === "studio"}
        focusPair={focusPair} onFocusConsumed={() => setFocusPair(null)} onBrowseLibrary={() => go("library")}
      />)}
      {pane("learn", <Learn onChanged={load} notify={notify} />)}

      {showPlayer ? <PlayerBar state={state} player={player} /> : null}

      {modal === "dupes" ? (
        <DuplicatesModal
          playlists={state.playlists} onClose={() => setModal(null)} notify={notify}
          onResolved={() => { void load(); go("library"); notify("Duplicates staged — see Pending deletes", "ok"); }}
        />
      ) : null}
      {modal === "changes" ? <ChangesModal onClose={() => setModal(null)} notify={notify} onApplied={() => void load()} /> : null}
      {modal === "upstream" ? (
        <UpstreamModal onClose={() => setModal(null)} notify={notify} playlists={state.playlists} onChange={() => void load()} />
      ) : null}
      {modal === "stores" ? <StoresModal onClose={() => setModal(null)} notify={notify} /> : null}
      {modal === "staging" ? <StagingModal onClose={() => setModal(null)} notify={notify} /> : null}
      {modal === "ops" ? <OpsModal onClose={() => setModal(null)} notify={notify} onChange={() => void load()} /> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ top bar */

function TopBar({ state, view, onView, onModal }: {
  state: State; view: ViewName; onView: (v: ViewName) => void; onModal: (m: Modal) => void;
}) {
  const [menu, setMenu] = useState<DOMRect | null>(null);
  const owed = state.plan.rekordbox.pending;
  const dirty = !state.changes.clean;
  /** A plan is only as true as the last look at rekordbox. */
  const stale = state.plan.rekordbox.stale;
  const lastLook = state.plan.rekordbox.observedAt ?? 0;

  return (
    <header className="topbar">
      <div className="lead">
        <div className="logo"><span className="mark"><Icon name="studio" stroke={2.2} /></span>dj-organizer</div>
        <SetSwitcher />
      </div>

      <nav className="tabs" aria-label="Views">
        {([
          ["library", "Library", "library"],
          ["set", "Set", "playlist"],
          ["studio", "Studio", "studio"],
          ["learn", "Learn", "learn"],
        ] as const).map(([v, label, icon]) => (
          <button
            key={v} className={`tab ${view === v ? "on" : ""}`} aria-current={view === v ? "page" : undefined}
            onClick={() => onView(v)}
            title={v === "learn" && state.counts.learnOpen ? `${state.counts.learnOpen} videos to watch` : undefined}
          >
            <Icon name={icon} />{label}
            {v === "learn" && state.counts.learnOpen ? <span className="ui-count">{state.counts.learnOpen}</span> : null}
          </button>
        ))}
      </nav>

      <div className="trail">
        {/* Count what rekordbox actually still owes (plan.pending), never raw
            log rows — those also count churn a store already satisfies. */}
        <button
          className={`sync-pill ${owed || dirty ? "owed" : ""} ${stale ? "stale" : ""}`}
          onClick={() => onModal(owed || dirty ? "changes" : "ops")}
          title={[
            owed ? `${owed} changes not yet in rekordbox` : "Rekordbox matches the app",
            stale ? `Counted against ${lastLook ? new Date(lastLook * 1000).toLocaleString() : "no check yet"} — re-check in Compare` : null,
          ].filter(Boolean).join("\n")}
        >
          <span className="ui-dot" />
          {owed ? `${stale ? "About " : ""}${owed} to apply` : dirty ? "Changes staged" : "In sync"}
        </button>
        <button
          className={`ui-icon-btn ${menu ? "on" : ""}`} aria-label="Library tools"
          onClick={(e) => setMenu(menu ? null : e.currentTarget.getBoundingClientRect())}
        ><Icon name="more" /></button>
        {menu ? (
          <Popover anchor={menu} align="end" width={260} onClose={() => setMenu(null)}>
            <div className="head">Library tools</div>
            {([
              ["staging", "plus", "Pull new music"],
              ["upstream", "link", "Compare with YouTube Music"],
              ["stores", "sync", "Compare rekordbox and disk"],
              ["changes", "export", "Changes to apply"],
              ["dupes", "folder", `Duplicates${state.counts.duplicates ? ` (${state.counts.duplicates})` : ""}`],
              ["ops", "history", "Change log"],
            ] as const).map(([m, icon, label]) => (
              <MenuItem key={m} icon={icon} onClick={() => { setMenu(null); onModal(m); }}>{label}</MenuItem>
            ))}
          </Popover>
        ) : null}
      </div>
    </header>
  );
}

/** Which set every view is working on, and the set-level actions. */
function SetSwitcher() {
  const set = useSet();
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const [renaming, setRenaming] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const close = () => { setAnchor(null); setRenaming(false); };

  const name = set.draft.name ?? "Untitled set";
  const sub = !set.ready
    ? set.loadFailed ? "Couldn't open" : "Opening…"
    : `${set.draft.trackIds.length} track${set.draft.trackIds.length === 1 ? "" : "s"}${set.totalDuration ? ` · ${fmtTotal(set.totalDuration)}` : ""}`;
  const saveLabel = { loading: "Opening", saving: "Saving", saved: "Saved", pending: "Unsaved", issue: "Needs attention" }[set.saveState];

  return (
    <>
      <button className="set-switch" onClick={(e) => setAnchor(e.currentTarget.getBoundingClientRect())} aria-haspopup="menu">
        <span className="chip">Set</span>
        <span className="txt"><span className="name">{name}</span><span className="sub">{sub}</span></span>
        <Icon name="chevronDown" size={16} />
      </button>
      <span className={`save-state ${set.saveState}`} title={set.saveIssue?.message ?? saveLabel} role="status" aria-label={saveLabel}>
        <span className="ui-dot" />{set.saveState === "issue" ? saveLabel : null}
      </span>
      {anchor ? (
        <Popover anchor={anchor} width={300} onClose={close}>
          {renaming ? (
            <form
              className="set-rename"
              onSubmit={(e) => {
                e.preventDefault();
                const next = nameRef.current?.value.trim();
                if (next && next !== name) void set.renameSet(next);
                close();
              }}
            >
              <label className="ui-label" htmlFor="set-rename">Set name</label>
              <div className="ui-field"><input id="set-rename" ref={nameRef} defaultValue={name} autoFocus maxLength={120} /></div>
              <div className="row">
                <button type="button" className="ui-btn ghost sm" onClick={() => setRenaming(false)}>Cancel</button>
                <button type="submit" className="ui-btn primary sm">Save name</button>
              </div>
            </form>
          ) : (
            <>
              <div className="head">Your sets</div>
              <div className="set-list">
                {set.sets.map((s) => (
                  <MenuItem
                    key={s.id} icon={s.id === set.activeSetId ? "check" : undefined}
                    active={s.id === set.activeSetId}
                    disabled={s.id !== set.activeSetId && !set.canSwitchSets}
                    hint={`${s.trackCount} tracks`}
                    onClick={() => { close(); if (s.id !== set.activeSetId) void set.openSet(s.id); }}
                  >{s.name}</MenuItem>
                ))}
              </div>
              <div className="sep" />
              <MenuItem icon="plus" disabled={!set.canSwitchSets} onClick={() => { close(); void set.createSet(); }}>New empty set</MenuItem>
              <MenuItem icon="playlist" disabled={!set.canSwitchSets} onClick={() => { close(); void set.duplicateSet(); }}>Duplicate this set</MenuItem>
              <MenuItem icon="edit" disabled={!set.ready} onClick={() => setRenaming(true)}>Rename…</MenuItem>
              <MenuItem
                icon="trash" danger disabled={!set.canDeleteSet || !set.activeSetId}
                onClick={() => {
                  close();
                  if (set.activeSetId && window.confirm(`Delete the set “${name}”?\n\nYour music and playlists are untouched.`)) {
                    void set.deleteSet(set.activeSetId);
                  }
                }}
              >Delete this set…</MenuItem>
            </>
          )}
        </Popover>
      ) : null}
    </>
  );
}

/* ------------------------------------------------------------ preview bar */

function PlayerBar({ state, player }: { state: State; player: Player }) {
  const now = state.tracks.find((t) => t.id === player.playingId);
  const facts = useTrackFacts(player.playingId);
  const ratio = player.duration ? player.time / player.duration : 0;
  const label = now ? now.title ?? now.filename : "Nothing playing";

  return (
    <footer className="player">
      <div className="now">
        {now ? <Art trackId={now.id} label={label} size={44} /> : <span className="ui-art" style={{ width: 44, height: 44 }} />}
        <div className="txt">
          <span className="t">{label}</span>
          {now ? <span className="a">{now.artist ?? "Unknown artist"}</span> : null}
        </div>
        {now ? (
          <div className="facts">
            <KeyBadge value={facts?.key} size="sm" />
            <span className="bpm">{fmtBpm(facts?.bpm)} BPM</span>
          </div>
        ) : null}
      </div>

      <div className="transport">
        <button
          className={`big-play ${now ? "" : "idle"}`} disabled={!now} onClick={player.toggle}
          aria-label={player.paused ? "Play preview" : "Pause preview"}
        ><Icon name={player.paused ? "play" : "pause"} /></button>
        <VisualizeButton player={player} now={now} />
      </div>

      <div className="seek">
        <span className="tm">{fmtTime(player.time)}</span>
        <div
          className="bar" role="slider" tabIndex={0} aria-label="Preview position"
          aria-valuemin={0} aria-valuemax={Math.round(player.duration)} aria-valuenow={Math.round(player.time)}
          aria-valuetext={`${fmtTime(player.time)} of ${fmtTime(player.duration)}`}
          onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); player.seek((e.clientX - r.left) / r.width); }}
          onKeyDown={(e) => {
            if (!player.duration || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
            e.preventDefault();
            const next = e.key === "Home" ? 0 : e.key === "End" ? 1
              : Math.max(0, Math.min(1, (player.time + (e.key === "ArrowRight" ? 5 : -5)) / player.duration));
            player.seek(next);
          }}
        >
          <div className="fill" style={{ width: `${ratio * 100}%` }} />
          <div className="knob" style={{ left: `${ratio * 100}%` }} />
        </div>
        <span className="tm">{fmtTime(player.duration)}</span>
      </div>

      <label className="vol">
        <Icon name="volume" />
        <input type="range" min={0} max={1} step={0.01} defaultValue={0.8} aria-label="Preview volume"
          onChange={(e) => player.setVolume(Number(e.target.value))} />
      </label>
    </footer>
  );
}
