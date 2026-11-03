import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { api, unwrap, type Changes, type DownloadJob, type Duplicates, type Playlist,
  type Track, type TrackHistory, type YtmCandidates, type YtmClassify, type YtmDiff,
  type YtmStatus } from "./api";
import { fmtMb } from "./hooks";
import { Art, EmptyState, Icon, Segmented } from "./ui";

const FOCUSABLE = [
  "a[href]", "button:not([disabled])", "input:not([disabled])", "select:not([disabled])",
  "textarea:not([disabled])", "summary", "[tabindex]:not([tabindex='-1'])",
].join(",");

/**
 * The one dialog chrome. Focus moves into the panel on open, Tab cycles
 * inside it, Escape and the scrim close it, and focus goes back to whatever
 * opened it. The background is not made `inert`: the shell's toast lives
 * there, and inert would silence its live region while a dialog is open.
 */
export function Modal({ title, subtitle, onClose, children, footer, size = "lg" }: {
  title: string;
  /** Identifies what the dialog is about (a track name). Never an explanation. */
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg";
}) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  // Read during render, before any autoFocus inside the dialog has run.
  const [opener] = useState(() => document.activeElement as HTMLElement | null);

  useEffect(() => {
    const h = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  useEffect(() => {
    if (!panel.current?.contains(document.activeElement)) panel.current?.focus();
    return () => { if (opener?.isConnected) opener.focus(); };
  }, [opener]);

  const trap = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab" || !panel.current) return;
    const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)]
      .filter((el) => el.getClientRects().length > 0);
    const first = items[0], last = items[items.length - 1];
    if (!first || !last) { e.preventDefault(); return; }
    const at = document.activeElement;
    if (e.shiftKey && (at === first || at === panel.current)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && at === last) { e.preventDefault(); first.focus(); }
  };

  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        ref={panel} className={`modal ${size}`} role="dialog" aria-modal="true"
        aria-labelledby={titleId} tabIndex={-1} onKeyDown={trap}
      >
        <div className="modal-hd">
          <div className="modal-ttl">
            <h2 id={titleId}>{title}</h2>
            {subtitle ? <p>{subtitle}</p> : null}
          </div>
          <button type="button" className="ui-icon-btn" onClick={onClose} aria-label="Close" title="Close">
            <Icon name="x" />
          </button>
        </div>
        <div className="modal-bd">{children}</div>
        {footer ? <div className="modal-ft">{footer}</div> : null}
      </div>
    </div>
  );
}

/** Status tones only: coral is reserved for the one primary action. */
type Tone = "" | "ok" | "warn" | "danger";

/** A fixed-width status column, so the text after it lines up row to row. */
export function Mark({ tone = "", title, children }: { tone?: Tone; title?: string; children: ReactNode }) {
  return <span className="dl-mark"><span className={`ui-tag ${tone}`} title={title}>{children}</span></span>;
}

/** Skeleton rows while a dialog loads, rather than a sentence about loading. */
export function Wait({ rows = 4 }: { rows?: number }) {
  return (
    <div className="dlist" aria-busy="true">
      <span className="sr-only" role="status">Loading</span>
      {Array.from({ length: rows }, (_, i) => (
        <div className="dl" key={i} aria-hidden="true">
          <span className="ui-skel" style={{ width: 56, height: 20 }} />
          <span className="ui-skel" style={{ flex: 1, maxWidth: `${70 - i * 9}%`, height: 14 }} />
        </div>
      ))}
    </div>
  );
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function Group({ head, title, children }: { head: ReactNode; title?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`dg ${open ? "open" : ""}`}>
      <button type="button" className="hd" aria-expanded={open} title={title} onClick={() => setOpen((o) => !o)}>
        <Icon name="chevronRight" className="chev" />{head}
      </button>
      {open ? <div className="bd">{children}</div> : null}
    </div>
  );
}

/**
 * A collapsible list whose open state is owned by the parent, so opening one
 * closes the others. `Group` keeps its own state instead because diff groups
 * are siblings you want open side by side.
 */
function Sec({ id, open, setOpen, label, title, badges, children }: {
  id: Section; open: Section | null; setOpen: (s: Section | null) => void;
  label: string; title?: string; badges: ReactNode; children: ReactNode;
}) {
  const on = open === id;
  return (
    <div className={`dg ${on ? "open" : ""}`}>
      <button type="button" className="hd" aria-expanded={on} title={title} onClick={() => setOpen(on ? null : id)}>
        <Icon name="chevronRight" className="chev" /><b>{label}</b>{badges}
      </button>
      {on ? <div className="bd scroll">{children}</div> : null}
    </div>
  );
}

const when = (ts: number) =>
  new Date(ts * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/* ---------------- duplicates ---------------- */

const DUP_KIND: Record<string, string> = { identical: "Identical", source: "Same source", twin: "Same name" };

export function DuplicatesModal({ playlists, onClose, onResolved, notify }: {
  playlists: Playlist[];
  onClose: () => void;
  onResolved: () => void;
  notify: (m: string, k?: "ok" | "err") => void;
}) {
  const [data, setData] = useState<Duplicates | null>(null);
  const [busy, setBusy] = useState(false);
  const plName = (id: number) => playlists.find((p) => p.id === id)?.name ?? "?";

  useEffect(() => {
    unwrap(api.duplicates.get()).then(setData).catch((e) => notify(e.message, "err"));
  }, [notify]);

  const resolve = async () => {
    setBusy(true);
    try {
      const r = await unwrap(api.duplicates.resolve.post());
      notify(
        `${r.staged} marked for deletion · ${plural(r.membershipsMerged, "playlist entry", "playlist entries")} moved to the kept copy` +
        (r.skippedManual ? ` · ${r.skippedManual} in hand-made playlists left alone` : ""),
        "ok",
      );
      onResolved();
      onClose();
    } catch (e) {
      notify((e as Error).message, "err");
      setBusy(false);
    }
  };

  if (!data) return <Modal title="Duplicates" onClose={onClose}><Wait /></Modal>;
  if (!data.count) {
    return (
      <Modal title="Duplicates" onClose={onClose} size="md">
        <EmptyState title="No duplicates" />
      </Modal>
    );
  }

  return (
    <Modal
      title="Duplicates"
      onClose={onClose}
      footer={
        <>
          {/* The one safety line: marking is not deleting. */}
          <span className="note">Frees {fmtMb(data.reclaim)}. Files stay on disk until you delete them.</span>
          <button type="button" className="ui-btn ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="ui-btn primary" onClick={resolve} disabled={busy}>
            {busy ? "Marking…" : `Mark ${data.count} for deletion`}
          </button>
        </>
      }
    >
      {data.groups.map((g, i) => (
        <Group
          key={i}
          title={g.why}
          head={
            <>
              <b>{g.keep.title ?? g.keep.filename}</b>
              <span className="ui-tag">{DUP_KIND[g.kind] ?? g.kind}</span>
              <span className="ui-tag warn">{g.redundant.length} extra</span>
              <span className="end num">{fmtMb(g.reclaim)}</span>
            </>
          }
        >
          <div className="dl">
            <Mark
              tone="ok"
              title="The best copy your DJ software can read. A copy in a hand-made playlist always wins."
            >Keep</Mark>
            <span className="grow" title={`${g.keep.folder}/${g.keep.filename}`}>{g.keep.folder}/{g.keep.filename}</span>
            <span className="end">{g.keep.ext} · {g.keep.bitrate ?? "?"} kbps</span>
          </div>
          {g.redundant.map((r) => (
            <div className="dl" key={r.id}>
              <Mark tone="warn">Remove</Mark>
              <span className="grow" title={`${r.folder}/${r.filename}`}>
                <span className="p">{r.folder}/{r.filename}</span>
                {r.playlists.length ? <span className="sub">In {r.playlists.map(plName).join(", ")}</span> : null}
              </span>
              <span className="end">{r.ext} · {r.bitrate ?? "?"} kbps</span>
            </div>
          ))}
        </Group>
      ))}
    </Modal>
  );
}

/* ---------------- changeset ---------------- */

/** A track in the change list: cover, title, artist. The path stays in the tooltip. */
function TrackLine({ t, mark }: { t: Changes["playlists"]["modified"][number]["added"][number]; mark: ReactNode }) {
  const title = t.title ?? t.filename.replace(/\.[^.]+$/, "");
  return (
    <div className="dl">
      {mark}
      <Art trackId={t.id ?? undefined} label={title} size={32} />
      <span className="grow" title={t.path}>
        <span className="p">{title}</span>
        {t.artist ? <span className="sub">{t.artist}</span> : null}
      </span>
    </div>
  );
}

export function ChangesModal({ onClose, notify, onApplied }: {
  onClose: () => void;
  notify: (m: string, k?: "ok" | "err") => void;
  onApplied: () => void;
}) {
  const [data, setData] = useState<Changes | null>(null);
  const [text, setText] = useState<string>("");
  const [tab, setTab] = useState<"list" | "text">("list");
  const [applying, setApplying] = useState(false);

  const load = useCallback(() => {
    unwrap(api.changes.get()).then(setData).catch((e) => notify(e.message, "err"));
    fetch("/api/changes.txt").then((r) => r.text()).then(setText).catch(() => {});
  }, [notify]);
  useEffect(load, [load]);

  const apply = async () => {
    setApplying(true);
    try {
      const r = await unwrap(api.apply.rekordbox.post());
      if (!r.ok) throw new Error(r.output.split("\n").filter((l) => /FAILED|REFUSED|REVIEW/.test(l)).join(" · ") || "rekordbox import failed");
      notify(r.reopened ? "Applied to rekordbox, reopening it" : "Applied to rekordbox", "ok");
      onApplied();
      load();
    } catch (e) { notify((e as Error).message, "err"); }
    finally { setApplying(false); }
  };

  const rel = (p: string) => p.replace("/mnt/c/Users/you/Music/tracks/", "");

  if (!data) return <Modal title="Changes to apply" onClose={onClose}><Wait /></Modal>;

  const { summary } = data;

  return (
    <Modal
      title="Changes to apply"
      onClose={onClose}
      size={summary.clean ? "md" : "lg"}
      footer={summary.clean ? undefined : (
        <>
          <a className="ui-btn outline" href="/api/changes.txt" download title="Download as a text file">
            <Icon name="export" />Download
          </a>
          <button
            type="button" className="ui-btn outline"
            onClick={() => { void navigator.clipboard.writeText(text); notify("Copied", "ok"); }}
          >Copy list</button>
          <button
            type="button" className="ui-btn primary" disabled={applying} onClick={() => void apply()}
            title="Closes rekordbox, backs up its library, writes these changes, checks them and reopens it"
          >{applying ? "Applying…" : "Apply to rekordbox"}</button>
        </>
      )}
    >
      {summary.clean ? (
        <EmptyState title="Nothing to apply" />
      ) : (
        <>
          <div className="modal-bar">
            <Segmented
              label="View" value={tab} onChange={setTab}
              options={[{ value: "list", label: "Grouped" }, { value: "text", label: "Plain text" }]}
            />
          </div>
          {tab === "text" ? (
            <pre className="diff">{text}</pre>
          ) : (
            <>
              {data.playlists.created.length || data.playlists.deleted.length ? (
                <div className="dlist">
                  {data.playlists.created.map((p) => (
                    <div className="dl" key={`c${p.name}`}>
                      <Mark tone="ok">New</Mark>
                      <span className="grow">{p.name}</span>
                      <span className="end">{plural(p.tracks, "track")}</span>
                    </div>
                  ))}
                  {data.playlists.deleted.map((p) => (
                    <div className="dl" key={`d${p.name}`}>
                      <Mark tone="danger">Remove</Mark>
                      <span className="grow">{p.name}</span>
                      <span className="end">had {plural(p.tracks, "track")}</span>
                    </div>
                  ))}
                </div>
              ) : null}

              {data.playlists.modified.map((m) => (
                <Group
                  key={m.name}
                  head={
                    <>
                      <b>{m.name}</b>
                      {m.added.length ? <span className="ui-tag ok">+{m.added.length}</span> : null}
                      {m.removed.length ? <span className="ui-tag warn">−{m.removed.length}</span> : null}
                      <span className="end num">{m.baseline} → {m.staged}</span>
                    </>
                  }
                >
                  {m.added.map((t) => <TrackLine key={`a${t.path}`} t={t} mark={<Mark tone="ok">Add</Mark>} />)}
                  {m.removed.map((t) => <TrackLine key={`r${t.path}`} t={t} mark={<Mark tone="warn">Remove</Mark>} />)}
                </Group>
              ))}

              {data.deletes.length ? (
                <Group head={<><b>Files to delete</b><span className="ui-tag danger">{data.deletes.length}</span></>}>
                  {data.deletes.map((d) => (
                    <div className="dl" key={d.id}>
                      <Mark tone="danger">Delete</Mark>
                      <span className="grow" title={d.reason ?? d.path}>{rel(d.path)}</span>
                    </div>
                  ))}
                </Group>
              ) : null}
            </>
          )}
        </>
      )}
    </Modal>
  );
}

/* ---------------- edit metadata ---------------- */

/**
 * Edits are stored beside the track, never written into the file. That keeps
 * the library additive-only; rekordbox picks the edit up from the XML export.
 * Both facts live in tooltips so the form stays two fields and two buttons.
 */
export function EditTrackModal({ track, onClose, onSave }: {
  track: Track;
  onClose: () => void;
  onSave: (title: string | null, artist: string | null) => void;
}) {
  const [title, setTitle] = useState(track.title ?? "");
  const [artist, setArtist] = useState(track.artist ?? "");

  const clean = (s: string) => (s.trim() === "" ? null : s.trim());
  const save = () => onSave(clean(title), clean(artist));
  const fileSays = [track.fileArtist, track.fileTitle].filter(Boolean).join(" — ");

  return (
    <Modal
      title="Edit track"
      onClose={onClose}
      size="sm"
      footer={
        <>
          {track.edited ? (
            <button
              type="button" className="ui-btn ghost" style={{ marginInlineEnd: "auto" }}
              title={fileSays ? `Use the file's tags: ${fileSays}` : "Use the file's own tags"}
              onClick={() => onSave(null, null)}
            >Revert</button>
          ) : null}
          <button type="button" className="ui-btn ghost" onClick={onClose}>Cancel</button>
          <button
            type="button" className="ui-btn primary" onClick={save}
            title="Saved in this app only. rekordbox gets it from the XML export; the file is not changed."
          >Save</button>
        </>
      }
    >
      <div className="editf">
        <label title={track.fileTitle && track.fileTitle !== title ? `File says: ${track.fileTitle}` : undefined}>
          <span className="ui-label">Title</span>
          <span className="ui-field">
            <input
              value={title} onChange={(e) => setTitle(e.target.value)} spellCheck={false}
              onKeyDown={(e) => { if (e.key === "Enter") save(); }} autoFocus
            />
          </span>
        </label>
        <label title={track.fileArtist && track.fileArtist !== artist ? `File says: ${track.fileArtist}` : undefined}>
          <span className="ui-label">Artist</span>
          <span className="ui-field">
            <input
              value={artist} onChange={(e) => setArtist(e.target.value)} spellCheck={false}
              onKeyDown={(e) => { if (e.key === "Enter") save(); }}
            />
          </span>
        </label>
      </div>
    </Modal>
  );
}

/* ---------------- per-track paper trail ---------------- */

const KIND_LABEL: Record<string, string> = {
  download_track: "Downloaded",
  add_to: "Added to",
  remove_from: "Removed from",
  delete_track: "Marked for deletion",
  edit_metadata: "Edited",
};

const human = (s: string) => {
  const t = s.replace(/_/g, " ");
  return t.charAt(0).toUpperCase() + t.slice(1);
};

export function TrackHistoryModal({ track, onClose, notify }: {
  track: Track;
  onClose: () => void;
  notify: (m: string, k?: "ok" | "err") => void;
}) {
  const [rows, setRows] = useState<TrackHistory | null>(null);

  useEffect(() => {
    unwrap(api.track({ id: String(track.id) }).history.get())
      .then(setRows)
      .catch((e) => notify((e as Error).message, "err"));
  }, [track.id, notify]);

  return (
    <Modal title="History" subtitle={track.title ?? track.filename} onClose={onClose} size="md">
      {!rows ? <Wait rows={3} />
        : !rows.length ? (
          <EmptyState title="No changes yet" />
        ) : (
          <div className="dlist">
            {rows.map((r) => (
              <div className={`hist ${r.undone ? "undone" : ""}`} key={r.id}>
                <span className="kind">
                  {KIND_LABEL[r.kind] ?? human(r.kind)}
                  {r.playlist ? <span className="pl"> {r.playlist}</span> : null}
                </span>
                {r.undone ? <span className="ui-tag">Undone</span> : null}
                {!r.appliedRekordbox
                  ? <span className="ui-tag warn" title="Not in rekordbox yet">Pending</span> : null}
                <span className="when">{when(r.at)}</span>
              </div>
            ))}
          </div>
        )}
    </Modal>
  );
}

/* ---------------- upstream diff ---------------- */

/** Only one section is open at a time — three stacked lists is already a lot. */
type Section = "upstream" | "local" | "links";

const REFRESHING = "Refreshing…";

export function UpstreamModal({ onClose, notify, playlists, onChange }: {
  onClose: () => void;
  notify: (m: string, k?: "ok" | "err") => void;
  playlists: Playlist[];
  onChange: () => void;
}) {
  const [status, setStatus] = useState<YtmStatus | null>(null);
  const [diff, setDiff] = useState<YtmDiff | null>(null);
  const [cands, setCands] = useState<YtmCandidates | null>(null);
  const [cls, setCls] = useState<YtmClassify | null>(null);
  const [jobs, setJobs] = useState<DownloadJob[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<Section | null>(null);

  const reload = useCallback(async () => {
    const [s, d, c, k] = await Promise.all([
      unwrap(api.ytm.status.get()),
      unwrap(api.ytm.diff.get()),
      unwrap(api.ytm.candidates.get()),
      unwrap(api.ytm.classify.get()),
    ]);
    setStatus(s); setDiff(d); setCands(c); setCls(k);
    return s;
  }, []);

  /**
   * Discovery is cheap, safe and idempotent, so an empty cache resolves itself
   * on open. Fetching every playlist is neither, so that stays a button.
   */
  useEffect(() => {
    (async () => {
      try {
        const s = await reload();
        if (s.reachable && s.discovered === 0) {
          setBusy("Finding your playlists…");
          await unwrap(api.ytm.discover.post());
          await reload();
          setBusy(null);
        }
      } catch (e) { setBusy(null); notify((e as Error).message, "err"); }
    })();
  }, [reload, notify]);

  const act = async (label: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(label);
    try { await fn(); await reload(); notify(done, "ok"); }
    catch (e) { notify((e as Error).message, "err"); }
    setBusy(null);
  };

  const running = jobs.some((j) => j.state === "running");

  /**
   * Poll only while something is running, and keep the interval keyed off that
   * flag rather than off `jobs` — depending on the array would rebuild the
   * timer on every tick. The last poll is what tears the timer down, so the
   * library reload happens exactly once, when the final job stops running.
   */
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => {
      void (async () => {
        try {
          const list = await unwrap(api.download.get());
          setJobs(list);
          if (!list.some((j) => j.state === "running")) { await reload(); onChange(); }
        } catch (e) { notify((e as Error).message, "err"); }
      })();
    }, 1500);
    return () => clearInterval(t);
  }, [running, reload, onChange, notify]);

  const download = async (folder: string, body: { ytmId?: string; videoIds?: string[] }) => {
    try {
      await unwrap(api.download.post({ ...body, folder }));
      setJobs(await unwrap(api.download.get()));
      notify(`Downloading into “${folder}”`, "ok");
    } catch (e) { notify((e as Error).message, "err"); }
  };

  if (!status) {
    return <Modal title="YouTube Music" onClose={onClose}><Wait /></Modal>;
  }
  if (!status.reachable) {
    return (
      <Modal title="YouTube Music" onClose={onClose} size="md">
        <EmptyState title="Can't reach YouTube Music">Check your connection and try again.</EmptyState>
        {status.reason ? (
          <details className="why">
            <summary>Details</summary>
            <pre className="diff">{status.reason}</pre>
          </details>
        ) : null}
      </Modal>
    );
  }

  const unlinked = (cands ?? []).filter((c) => !c.localPlaylistId);
  const linkedRows = (cands ?? []).filter((c) => c.localPlaylistId);
  const neverFetched = linkedRows.filter((c) => !c.fetchedAt).length;
  const unloadedUpstream = cls?.upstreamOnly.filter((u) => !u.fetchedAt).length ?? 0;
  const summary = [
    status.owner,
    plural(status.discovered, "playlist"),
    `${status.linked} linked`,
    status.lastSync ? `updated ${when(status.lastSync)}` : null,
  ].filter(Boolean).join(" · ");

  return (
    <Modal
      title="YouTube Music"
      onClose={onClose}
      footer={
        <>
          <span className="note" role="status">{busy ?? ""}</span>
          <button
            type="button" className="ui-btn ghost" disabled={!!busy} title="Look for playlists on your channel again"
            onClick={() => act("Scanning your channel…", () => unwrap(api.ytm.discover.post()), "Channel rescanned")}
          ><Icon name="search" />Rescan</button>
          <button
            type="button" className="ui-btn primary" disabled={!!busy} title={summary}
            onClick={() => act(REFRESHING, () => unwrap(api.ytm.refresh.post({})), "Playlists refreshed")}
          ><Icon name="sync" />{busy === REFRESHING ? "Refreshing…" : `Refresh ${status.linked}`}</button>
        </>
      }
    >
      {/* A running job is the only thing in here that changes on its own, so it
          gets the top of the dialog for as long as it lasts. */}
      {jobs.filter((j) => j.state !== "done" || j.files.length).map((j) => (
        <div className={`job ${j.state}`} key={j.jobId}>
          <Icon name={j.state === "running" ? "sync" : j.state === "error" ? "warning" : "check"} className="s" />
          <span className="grow">{j.folder}</span>
          {j.skipped.length ? <span className="ui-tag" title="Already in your library">{j.skipped.length} skipped</span> : null}
          {j.failed.length ? <span className="ui-tag danger">{j.failed.length} failed</span> : null}
          {j.error ? <span className="mut" title={j.error}>{j.error}</span> : null}
          <span className="end">{j.completed}/{j.total}</span>
        </div>
      ))}

      {/* Three questions, three lists: what exists only upstream, what exists
          only here, and how the rest is paired. `count: 0` on something never
          fetched means "not asked" — it is shown as unknown so it cannot be
          misread as an empty playlist. */}
      <Sec
        id="upstream" open={open} setOpen={setOpen} label="Only on YouTube"
        badges={<>
          {unloadedUpstream
            ? <span className="ui-count warn" title="Not loaded yet">{unloadedUpstream}</span> : null}
          <span className="ui-count">{cls?.upstreamOnly.length ?? 0}</span>
        </>}
      >
        {!cls?.upstreamOnly.length
          ? <div className="dl"><span className="grow mut">None</span></div>
          : cls.upstreamOnly.map((u) => (
            <div className="dl" key={u.ytmId}>
              <a
                className="grow" href={`https://music.youtube.com/playlist?list=${u.ytmId}`}
                target="_blank" rel="noreferrer"
              >{u.title}</a>
              {u.fetchedAt ? <span className="end">{plural(u.count ?? 0, "track")}</span> : (
                <button
                  type="button" className="ui-btn sm ghost" disabled={!!busy} title="Load the track count"
                  onClick={() => void act("Loading…",
                    () => unwrap(api.ytm.refresh.post({ ytmIds: [u.ytmId] })),
                    `Loaded “${u.title}”`)}
                >Load</button>
              )}
              {/* Adopt is what turns an upstream-only playlist into a local
                  download queue, so it reads as one action, not two. */}
              <button
                type="button" className="ui-btn sm outline" disabled={!!busy || running}
                title={`Create “${u.title}” here, then download its tracks`}
                onClick={() => void (async () => {
                  await act("Creating playlist…",
                    () => unwrap(api.ytm.adopt.post({ ytmId: u.ytmId })),
                    `Created “${u.title}”`);
                  await download(u.title, { ytmId: u.ytmId });
                })()}
              >Download</button>
            </div>
          ))}
      </Sec>

      <Sec
        id="local" open={open} setOpen={setOpen} label="Only here"
        title="Nothing on YouTube Music tracks these, so nothing proposes changes to them"
        badges={<span className="ui-count">{cls?.localOnly.length ?? 0}</span>}
      >
        {!cls?.localOnly.length
          ? <div className="dl"><span className="grow mut">None</span></div>
          : cls.localOnly.map((l) => (
            <div className="dl" key={l.localPlaylistId}>
              <span className="grow">{l.name}</span>
              <span className="end">{l.localCount == null ? "" : plural(l.localCount, "track")}</span>
            </div>
          ))}
      </Sec>

      {/* Nothing in the diff works until a local playlist is paired with an
          upstream one, so the pairing lives up here rather than behind a setting. */}
      <Sec
        id="links" open={open} setOpen={setOpen} label="Links"
        badges={<>
          {neverFetched ? <span className="ui-count warn" title="Linked but not loaded yet">{neverFetched}</span> : null}
          {unlinked.length ? <span className="ui-count warn" title="Not linked">{unlinked.length}</span> : null}
          <span className="ui-count" title="Linked">{status.linked}</span>
        </>}
      >
        {(cands ?? []).map((c) => (
          <div className="dl" key={c.ytmId}>
            <a
              className="grow" href={`https://music.youtube.com/playlist?list=${c.ytmId}`}
              target="_blank" rel="noreferrer"
            >{c.title}</a>
            {!c.localPlaylistId ? (
              <button
                type="button" className="ui-btn sm ghost" disabled={!!busy}
                title={`Create a playlist “${c.title}” here and link it`}
                onClick={() => void act("Creating playlist…",
                  () => unwrap(api.ytm.adopt.post({ ytmId: c.ytmId })),
                  `Created “${c.title}”`)}
              ><Icon name="plus" />Create</button>
            ) : null}
            <select
              className="ui-select sm" aria-label={`Local playlist for ${c.title}`}
              value={c.localPlaylistId ?? ""}
              disabled={!!busy}
              onChange={(e) => {
                const v = e.target.value;
                if (!v) return void act("Unlinking…",
                  () => unwrap(api.ytm.unlink.post({ ytmId: c.ytmId })), "Unlinked");
                void act("Linking…", () => unwrap(api.ytm.link.post({
                  ytmId: c.ytmId, localPlaylistId: Number(v),
                })), `Linked to ${playlists.find((p) => p.id === Number(v))?.name ?? ""}`);
              }}
            >
              <option value="">Not linked</option>
              {playlists.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
        ))}
      </Sec>

      {!diff?.length ? (
        status.linked
          ? <EmptyState title="Not loaded yet" />
          : <EmptyState title="Nothing linked yet" />
      ) : (
        <>
          <h3 className="modal-sub">Linked playlists</h3>
          {diff.map((p) => (
            <Group
              key={p.localPlaylistId}
              title={`${p.ytmCount} on YouTube Music · ${p.localCount} here`}
              head={
                <>
                  <b>{p.playlist}</b>
                  {p.sources.length > 1
                    ? <span className="ui-tag" title={p.sources.map((s) => s.title).join(" + ")}>
                        {p.sources.length} sources
                      </span>
                    : null}
                  {p.missingLocally.length
                    ? <span className="ui-tag">{p.missingLocally.length} on YouTube only</span> : null}
                  {p.extraLocally.length
                    ? <span className="ui-tag">{p.extraLocally.length} only here</span> : null}
                  <span className="end num">{p.matched} matched</span>
                </>
              }
            >
              {/* YouTube-only tracks can be downloaded into this playlist. */}
              {p.missingLocally.length ? (
                <div className="dl">
                  <span className="grow mut">{p.missingLocally.length} not downloaded</span>
                  <button
                    type="button" className="ui-btn sm outline" disabled={!!busy || running}
                    onClick={() => void download(p.playlist, {
                      videoIds: p.missingLocally.map((m) => m.videoId),
                    })}
                  >Download {p.missingLocally.length}</button>
                </div>
              ) : null}
              {p.missingLocally.map((m) => (
                <div className="dl" key={m.videoId}>
                  <Mark>YouTube only</Mark>
                  <a className="grow" href={m.url} target="_blank" rel="noreferrer">
                    {m.artist} — {m.title}
                  </a>
                </div>
              ))}
              {p.extraLocally.map((m) => (
                <div className="dl" key={m.trackId}>
                  <Mark>Only here</Mark>
                  <span className="grow">{m.artist} — {m.title}</span>
                </div>
              ))}
              {!p.missingLocally.length && !p.extraLocally.length
                ? <div className="dl"><Mark tone="ok"><Icon name="check" stroke={2.2} />Same tracks</Mark></div> : null}
            </Group>
          ))}
        </>
      )}
    </Modal>
  );
}
