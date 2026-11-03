import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Modal, Wait } from "./Modals";
import { EmptyState, Icon } from "./ui";

/**
 * Discovery -> staging -> approval -> download.
 *
 * Nothing here downloads anything on its own. Discovery only ever writes rows
 * to `ytm_staged`; a track is fetched when it has been explicitly approved and
 * the download button is pressed. Rejection is sticky, so a track you have
 * turned down does not come back on the next discovery run.
 */

type Status = "pending" | "approved" | "rejected" | "downloaded";

type StagedTrack = {
  videoId: string;
  title: string | null;
  artist: string | null;
  status: Status;
  flags: string | null;
  localPlaylist: string;
};

type StagedGroup = {
  localPlaylist: string;
  rows: StagedTrack[];
  counts: Partial<Record<Status, number>>;
};

const FLAG_HINT: Record<string, string> = {
  oversized: "From a huge upstream playlist you only ever curated a slice of",
  junk: "Looks like a playlist artefact or non-music, not a track",
  unavailable: "Deleted or blocked on YouTube — can't be downloaded from there",
  premium: "Only streams for Music Premium members — can't be downloaded",
  "in-library": "Already in your library under another upload",
};

const FLAG_LABEL: Record<string, string> = { oversized: "Big playlist", junk: "Not music?",
  unavailable: "Unavailable", premium: "Premium only", "in-library": "Already have" };

const STATUS_TAG: Record<Status, [string, string]> = {
  pending: ["Pending", ""],
  approved: ["Approved", "ok"],
  rejected: ["Rejected", ""],
  downloaded: ["Downloaded", "ok"],
};

const post = async (path: string, body?: unknown) => {
  const r = await fetch(`/api/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  if (!r.ok) {
    // The server answers errors as { error }; never show its raw body or a status code.
    const body = await r.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error ?? "The server hit an error. Try again.");
  }
  return r.json().catch(() => ({}));
};

export function StagingModal({ onClose, notify }: {
  onClose: () => void;
  notify: (m: string, k?: "ok" | "err") => void;
}) {
  const [groups, setGroups] = useState<StagedGroup[] | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<null | "discover" | "download" | "mark">(null);
  const [job, setJob] = useState<{ done: number; total: number; label?: string } | null>(null);
  const [hideRejected, setHideRejected] = useState(true);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/ytm/staged");
      if (!r.ok) throw new Error("Couldn't load new tracks. Try again.");
      const d = await r.json();
      setGroups(Array.isArray(d) ? d : (d.groups ?? []));
    } catch (e) {
      notify(String((e as Error).message), "err");
      setGroups([]);
    }
  }, [notify]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => () => { if (poll.current) clearInterval(poll.current); }, []);

  const visible = useMemo(() => (groups ?? []).map((g) => ({
    ...g,
    rows: g.rows.filter((t) =>
      t.status !== "downloaded" && (!hideRejected || t.status !== "rejected")),
  })).filter((g) => g.rows.length), [groups, hideRejected]);

  const approved = useMemo(
    () => (groups ?? []).flatMap((g) => g.rows).filter((t) => t.status === "approved"),
    [groups]);

  const discover = async () => {
    setBusy("discover");
    try {
      const r = await post("ytm/stage");
      const n = r.staged ?? 0;
      notify(n ? `Discovered ${n} new track${n === 1 ? "" : "s"}` : "Nothing new upstream", "ok");
      await load();
    } catch (e) {
      notify(String((e as Error).message), "err");
    } finally { setBusy(null); }
  };

  /** Approval and rejection are the same call shape, so share one path. */
  const mark = async (videoIds: string[], how: "approve" | "reject") => {
    if (!videoIds.length) return;
    setBusy("mark");
    try {
      await post(`ytm/staged/${how}`, { videoIds });
      setSel((s) => { const n = new Set(s); videoIds.forEach((v) => n.delete(v)); return n; });
      await load();
    } catch (e) {
      notify(String((e as Error).message), "err");
    } finally { setBusy(null); }
  };

  /**
   * The server downloads one local playlist per job (it needs a single target
   * folder), so walk the approved playlists in turn rather than firing one
   * request for everything and getting a 409 back.
   */
  const download = async () => {
    if (!approved.length) return;
    setBusy("download");
    const queue = [...new Set(approved.map((t) => t.localPlaylist))];
    const grand = approved.length;
    let finished = 0;
    try {
      for (const localPlaylist of queue) {
        const r = await post("ytm/staged/download", { localPlaylist });
        const id = r.jobId ?? r.id;
        const n = r.videoIds?.length ?? 0;
        if (!id) { finished += n; continue; }
        await new Promise<void>((resolve, reject) => {
          poll.current = setInterval(async () => {
            try {
              const j = await (await fetch(`/api/download/${id}`)).json();
              const done = j.done ?? 0;
              setJob({ done: finished + done, total: grand, label: localPlaylist });
              if (j.state === "error") {
                if (poll.current) clearInterval(poll.current);
                reject(new Error(j.error || `Download failed for ${localPlaylist}`));
              } else if (j.state === "done" || done >= (j.total ?? n)) {
                if (poll.current) clearInterval(poll.current);
                finished += j.total ?? n;
                resolve();
              }
            } catch { /* a blip mid-job is not a failure; keep polling */ }
          }, 1500);
        });
      }
      notify(`Downloaded ${grand} track${grand === 1 ? "" : "s"}`, "ok");
    } catch (e) {
      notify(String((e as Error).message), "err");
    } finally {
      if (poll.current) clearInterval(poll.current);
      setJob(null); setBusy(null);
      void load();
    }
  };

  const toggle = (v: string) =>
    setSel((s) => { const n = new Set(s); n.has(v) ? n.delete(v) : n.add(v); return n; });

  const groupIds = (g: StagedGroup, only?: Status) =>
    g.rows.filter((t) => !only || t.status === only).map((t) => t.videoId);

  return (
    <Modal
      title="New tracks"
      onClose={onClose}
      footer={
        <>
          <label className="check" style={{ marginInlineEnd: "auto" }}>
            <input type="checkbox" checked={hideRejected}
              onChange={(e) => setHideRejected(e.target.checked)} />
            Hide rejected
          </label>
          <button
            type="button" className="ui-btn outline" onClick={discover} disabled={!!busy}
            title="Look on YouTube Music for tracks you don't have yet"
          >
            <Icon name="search" />{busy === "discover" ? "Looking…" : "Find new"}
          </button>
          {/* Discovery only stages rows; nothing downloads until this is pressed. */}
          <button
            type="button" className="ui-btn primary"
            onClick={download}
            disabled={!!busy || !approved.length}
            title={approved.length ? "Downloads approved tracks only" : "Approve something first"}
          >
            {busy === "download"
              ? (job ? `Downloading ${job.done}/${job.total}` : "Starting…")
              : `Download ${approved.length || ""}`.trim()}
          </button>
        </>
      }
    >
      {sel.size ? (
        <div className="stg-sel" role="region" aria-label="Selection">
          <span className="grow"><b>{sel.size}</b> selected</span>
          <button type="button" className="ui-btn sm ghost" onClick={() => setSel(new Set())}>Clear</button>
          <button type="button" className="ui-btn sm" disabled={!!busy}
            onClick={() => mark([...sel], "reject")}>Reject</button>
          <button type="button" className="ui-btn sm" disabled={!!busy}
            onClick={() => mark([...sel], "approve")}><Icon name="check" />Approve</button>
        </div>
      ) : null}

      {groups === null ? <Wait />
        : !visible.length ? (
          <EmptyState title="Nothing to review" />
        ) : visible.map((g) => {
          const isOpen = open.has(g.localPlaylist);
          const pend = g.rows.filter((t) => t.status === "pending").length;
          return (
            <div key={g.localPlaylist} className={`stg ${isOpen ? "open" : ""}`}>
              <div className="stg-hd">
                <button type="button" className="stg-toggle" onClick={() => setOpen((s) => {
                  const n = new Set(s);
                  n.has(g.localPlaylist) ? n.delete(g.localPlaylist) : n.add(g.localPlaylist);
                  return n;
                })} aria-expanded={isOpen}>
                  <Icon name="chevronRight" className="chev" />
                  <b>{g.localPlaylist}</b>
                  <span className="ui-count">{g.rows.length}</span>
                </button>
                {pend ? (
                  <>
                    <button type="button" className="ui-btn sm ghost" disabled={!!busy}
                      onClick={() => mark(groupIds(g, "pending"), "reject")}>
                      Reject {pend}
                    </button>
                    <button type="button" className="ui-btn sm" disabled={!!busy}
                      onClick={() => mark(groupIds(g, "pending"), "approve")}>
                      Approve {pend}
                    </button>
                  </>
                ) : null}
              </div>

              {isOpen ? <div className="stg-body">{g.rows.map((t) => {
                const flags = (t.flags ?? "").split(",").filter(Boolean);
                const [label, tone] = STATUS_TAG[t.status];
                return (
                  <div key={t.videoId} className={`stg-row ${t.status}`}>
                    <label className="stg-check">
                      <input
                        type="checkbox"
                        aria-label={`Select ${t.title ?? "untitled track"}`}
                        checked={sel.has(t.videoId)}
                        onChange={() => toggle(t.videoId)}
                        disabled={t.status === "downloaded"}
                      />
                    </label>
                    <div className="meta">
                      <div className="t1">
                        <span className="nm" title={t.title ?? undefined}>{t.title ?? "Untitled"}</span>
                        {flags.map((f) => (
                          <span key={f} className="ui-tag warn" title={FLAG_HINT[f] ?? f}>{FLAG_LABEL[f] ?? f}</span>
                        ))}
                      </div>
                      {t.artist ? <div className="t2">{t.artist}</div> : null}
                    </div>
                    <span className={`ui-tag ${tone}`}>{label}</span>
                  </div>
                );
              })}</div> : null}
            </div>
          );
        })}
    </Modal>
  );
}
