import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, unwrap, type Changes, type Duplicates, type Playlist, type YtmCandidates,
  type YtmDiff, type YtmStatus } from "./api";
import { fmtMb } from "./hooks";

export function Modal({ title, onClose, children, footer }: {
  title: string; onClose: () => void; children: ReactNode; footer?: ReactNode;
}) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal">
        <h3>{title}<button className="x" onClick={onClose} aria-label="Close">×</button></h3>
        <div className="in">{children}</div>
        {footer ? <div className="ft">{footer}</div> : null}
      </div>
    </div>
  );
}

function Group({ head, children }: { head: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="dg">
      <button className="hd" onClick={() => setOpen((o) => !o)}>{head}</button>
      {open ? <div className="bd">{children}</div> : null}
    </div>
  );
}

/* ---------------- duplicates ---------------- */

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
        `${r.staged} staged · ${r.membershipsMerged} playlist links merged into keepers` +
        (r.skippedManual ? ` · ${r.skippedManual} manual-playlist links left alone` : ""),
        "ok",
      );
      onResolved();
      onClose();
    } catch (e) {
      notify((e as Error).message, "err");
      setBusy(false);
    }
  };

  if (!data) return <Modal title="Duplicates" onClose={onClose}><div className="mut">Scanning…</div></Modal>;
  if (!data.count) {
    return (
      <Modal title="Duplicates" onClose={onClose}>
        <div className="mut">No duplicates. Library is clean.</div>
      </Modal>
    );
  }

  return (
    <Modal
      title="Duplicates"
      onClose={onClose}
      footer={
        <>
          <button className="pill go" onClick={resolve} disabled={busy}>
            {busy ? "Staging…" : `Stage all ${data.count} for deletion`}
          </button>
          <span className="mut">
            frees {fmtMb(data.reclaim)} · playlists merge into the kept copy first ·
            staging only — no file moves, you delete them yourself
          </span>
        </>
      }
    >
      <div className="mut" style={{ marginBottom: 11 }}>
        {data.groups.length} groups · {data.count} redundant files · {fmtMb(data.reclaim)} recoverable.
        The higher-bitrate, DJ-readable copy is kept, and a copy sitting in a manually
        curated playlist always wins so those playlists never change.
      </div>
      {data.groups.map((g, i) => (
        <Group
          key={i}
          head={
            <>
              <b>{g.keep.title ?? g.keep.filename}</b>
              <span className="num">{g.kind === "twin" ? "same name" : "same source"}</span>
              <span className="num dn">{g.redundant.length} redundant</span>
              <span className="num">{fmtMb(g.reclaim)}</span>
            </>
          }
        >
          <div className="dl">
            <span className="s m">keep</span>
            <span className="grow">{g.keep.folder}/{g.keep.filename}</span>
            <span className="mut">{g.keep.ext} · {g.keep.bitrate ?? "?"}k</span>
          </div>
          {g.redundant.map((r) => (
            <div className="dl" key={r.id}>
              <span className="s e">drop</span>
              <span className="grow">{r.folder}/{r.filename}</span>
              <span className="mut">
                {r.ext} · {r.bitrate ?? "?"}k
                {r.playlists.length ? ` · in ${r.playlists.map(plName).join(", ")}` : ""}
              </span>
            </div>
          ))}
          <div className="dl"><span className="mut">{g.why}</span></div>
        </Group>
      ))}
    </Modal>
  );
}

/* ---------------- changeset ---------------- */

export function ChangesModal({ onClose, notify }: {
  onClose: () => void;
  notify: (m: string, k?: "ok" | "err") => void;
}) {
  const [data, setData] = useState<Changes | null>(null);
  const [text, setText] = useState<string>("");
  const [tab, setTab] = useState<"list" | "text">("list");

  useEffect(() => {
    unwrap(api.changes.get()).then(setData).catch((e) => notify(e.message, "err"));
    fetch("/api/changes.txt").then((r) => r.text()).then(setText).catch(() => {});
  }, [notify]);

  const rel = (p: string) => p.replace("/mnt/c/Users/you/Music/tracks/", "");

  if (!data) return <Modal title="Changeset" onClose={onClose}><div className="mut">Computing…</div></Modal>;

  const { summary } = data;

  return (
    <Modal
      title="Changeset · staged vs. crates on disk"
      onClose={onClose}
      footer={
        <>
          <button className="pill" onClick={() => setTab(tab === "list" ? "text" : "list")}>
            {tab === "list" ? "Plain text" : "Grouped"}
          </button>
          <a className="pill" href="/api/changes.txt" download style={{ textDecoration: "none" }}>
            ↓ changeset.txt
          </a>
          <button
            className="pill"
            onClick={() => { void navigator.clipboard.writeText(text); notify("Copied", "ok"); }}
          >
            Copy
          </button>
          <span className="mut">
            {summary.clean
              ? "nothing staged"
              : `${summary.tracksAdded} added · ${summary.tracksRemoved} removed · ` +
                `${summary.created} new · ${summary.deleted} dropped · ${summary.pendingDeletes} deletes`}
          </span>
        </>
      }
    >
      <div className="banner">
        This app never writes to Serato or rekordbox. This is the list to apply by hand.
      </div>

      {summary.clean ? (
        <div className="mut">Staged state matches the crates on disk. Nothing to apply.</div>
      ) : tab === "text" ? (
        <pre className="diff">{text}</pre>
      ) : (
        <>
          {data.playlists.created.map((p) => (
            <div className="dl" key={`c${p.name}`}>
              <span className="s m">new</span>
              <span className="grow">{p.name}</span>
              <span className="mut">{p.tracks} tracks</span>
            </div>
          ))}
          {data.playlists.deleted.map((p) => (
            <div className="dl" key={`d${p.name}`}>
              <span className="s x">drop</span>
              <span className="grow">{p.name}</span>
              <span className="mut">was {p.tracks} tracks</span>
            </div>
          ))}

          {data.playlists.modified.map((m) => (
            <Group
              key={m.name}
              head={
                <>
                  <b>{m.name}</b>
                  {m.added.length ? <span className="num up">+{m.added.length}</span> : null}
                  {m.removed.length ? <span className="num dn">−{m.removed.length}</span> : null}
                  <span className="num">{m.baseline} → {m.staged}</span>
                </>
              }
            >
              {m.added.map((t) => (
                <div className="dl" key={`a${t.path}`}>
                  <span className="s m">add</span><span className="grow">{rel(t.path)}</span>
                </div>
              ))}
              {m.removed.map((t) => (
                <div className="dl" key={`r${t.path}`}>
                  <span className="s e">remove</span><span className="grow">{rel(t.path)}</span>
                </div>
              ))}
            </Group>
          ))}

          {data.deletes.length ? (
            <Group
              head={<><b>Delete to _TRASH</b><span className="num dn">{data.deletes.length}</span></>}
            >
              {data.deletes.map((d) => (
                <div className="dl" key={d.id}>
                  <span className="s x">delete</span>
                  <span className="grow">{rel(d.path)}</span>
                  {d.reason ? <span className="mut">{d.reason}</span> : null}
                </div>
              ))}
            </Group>
          ) : null}
        </>
      )}
    </Modal>
  );
}

/* ---------------- upstream diff ---------------- */

export function UpstreamModal({ onClose, notify, playlists }: {
  onClose: () => void;
  notify: (m: string, k?: "ok" | "err") => void;
  playlists: Playlist[];
}) {
  const [status, setStatus] = useState<YtmStatus | null>(null);
  const [diff, setDiff] = useState<YtmDiff | null>(null);
  const [cands, setCands] = useState<YtmCandidates | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showLinks, setShowLinks] = useState(false);

  const reload = useCallback(async () => {
    const [s, d, c] = await Promise.all([
      unwrap(api.ytm.status.get()),
      unwrap(api.ytm.diff.get()),
      unwrap(api.ytm.candidates.get()),
    ]);
    setStatus(s); setDiff(d); setCands(c);
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

  if (!status) {
    return <Modal title="Upstream · YouTube Music" onClose={onClose}><div className="mut">Checking…</div></Modal>;
  }
  if (!status.reachable) {
    return (
      <Modal title="Upstream · YouTube Music" onClose={onClose}>
        <div className="mut">
          Cannot reach YouTube Music.<br /><br />
          <code>{status.reason}</code>
        </div>
      </Modal>
    );
  }

  const unlinked = (cands ?? []).filter((c) => !c.localPlaylistId);
  const linkedRows = (cands ?? []).filter((c) => c.localPlaylistId);
  const neverFetched = linkedRows.filter((c) => !c.fetchedAt).length;

  return (
    <Modal
      title="Upstream · YouTube Music"
      onClose={onClose}
      footer={
        <>
          <button
            className="pill" disabled={!!busy}
            onClick={() => act("Fetching…", () => unwrap(api.ytm.refresh.post({})), "Upstream refreshed")}
          >{busy === "Fetching…" ? "Fetching…" : `↻ Fetch ${status.linked} linked`}</button>
          <button
            className="pill" disabled={!!busy}
            onClick={() => act("Finding…", () => unwrap(api.ytm.discover.post()), "Rescanned your channel")}
          >⌕ Rediscover</button>
          <span className="mut">
            {busy ?? <>
              {status.owner ? `${status.owner} · ` : ""}
              {status.discovered} upstream · {status.linked} linked
              {status.lastSync ? ` · last ${new Date(status.lastSync * 1000).toLocaleString()}` : ""}
            </>}
          </span>
        </>
      }
    >
      {/* Nothing here works until a local playlist is paired with an upstream
          one, so the pairing lives at the top rather than behind a setting. */}
      <button className="linkhd" onClick={() => setShowLinks((v) => !v)}>
        {showLinks ? "▾" : "▸"} Links
        <span className="num">{status.linked} linked</span>
        {unlinked.length ? <span className="num up">{unlinked.length} upstream unlinked</span> : null}
        {neverFetched ? <span className="num dn">{neverFetched} never fetched</span> : null}
      </button>

      {showLinks ? (
        <div className="links">
          {(cands ?? []).map((c) => (
            <div className="dl" key={c.ytmId}>
              <a
                className="grow" href={`https://music.youtube.com/playlist?list=${c.ytmId}`}
                target="_blank" rel="noreferrer"
              >{c.title}</a>
              <select
                value={c.localPlaylistId ?? ""}
                disabled={!!busy}
                onChange={(e) => {
                  const v = e.target.value;
                  if (!v) return void act("Unlinking…",
                    () => unwrap(api.ytm.unlink.post({ ytmId: c.ytmId })), "Unlinked");
                  void act("Linking…", () => unwrap(api.ytm.link.post({
                    ytmId: c.ytmId, localPlaylistId: Number(v),
                  })), `Linked → ${playlists.find((p) => p.id === Number(v))?.name ?? ""}`);
                }}
              >
                <option value="">— not linked —</option>
                {playlists.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
          ))}
        </div>
      ) : null}

      {!diff?.length ? (
        <div className="mut">
          {status.linked
            ? "Linked, but nothing fetched yet — hit Fetch below."
            : "No playlist is linked yet. Open Links above and pair them up."}
        </div>
      ) : (
        diff.map((p) => (
          <Group
            key={p.ytmId}
            head={
              <>
                <b>{p.playlist}</b>
                <span className="num">{p.matched} matched</span>
                {p.missingLocally.length
                  ? <span className="num up">{p.missingLocally.length} not downloaded</span> : null}
                {p.extraLocally.length
                  ? <span className="num dn">{p.extraLocally.length} local only</span> : null}
                <span className="num">{p.ytmCount} ⇅ {p.localCount}</span>
              </>
            }
          >
            {p.missingLocally.map((m) => (
              <div className="dl" key={m.videoId}>
                <span className="s m">missing</span>
                <a className="grow" href={m.url} target="_blank" rel="noreferrer">
                  {m.artist} — {m.title}
                </a>
              </div>
            ))}
            {p.extraLocally.map((m) => (
              <div className="dl" key={m.trackId}>
                <span className="s e">local</span>
                <span className="grow">{m.artist} — {m.title}</span>
              </div>
            ))}
            {!p.missingLocally.length && !p.extraLocally.length
              ? <div className="dl"><span className="mut">In sync.</span></div> : null}
          </Group>
        ))
      )}
    </Modal>
  );
}
