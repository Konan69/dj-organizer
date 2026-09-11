import { useEffect, useState } from "react";
import { api, unwrap, type Op, type PlanFor, type StoresView } from "./api";
import { Modal } from "./Modals";

const STORES = ["rekordbox", "serato", "fs"] as const;
type StoreName = (typeof STORES)[number];

const LABEL: Record<StoreName, string> = {
  rekordbox: "rekordbox", serato: "Serato", fs: "Filesystem",
};

const ago = (ts: number | null | undefined) => {
  if (!ts) return "never";
  const s = Math.floor(Date.now() / 1000) - ts;
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
};

/**
 * The three stores side by side, plus the per-store replay plan.
 * Nothing here writes anywhere — the plan is the list to apply by hand.
 */
export function StoresModal({ onClose, notify }: {
  onClose: () => void;
  notify: (m: string, k?: "ok" | "err") => void;
}) {
  const [data, setData] = useState<StoresView | null>(null);
  const [store, setStore] = useState<StoreName>("rekordbox");
  const [plan, setPlan] = useState<PlanFor | null>(null);
  const [tab, setTab] = useState<"drift" | "plan">("drift");
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    setBusy(true);
    try { setData(await unwrap(api.stores.get())); }
    catch (e) { notify((e as Error).message, "err"); }
    setBusy(false);
  };

  useEffect(() => { void refresh(); }, []);
  useEffect(() => {
    unwrap(api.plan({ store }).get()).then(setPlan).catch((e) => notify(e.message, "err"));
  }, [store, notify]);

  const c = data?.comparison;

  return (
    <Modal
      title="Stores · where the library actually lives"
      onClose={onClose}
      footer={
        <>
          <button className="pill" onClick={refresh} disabled={busy}>
            {busy ? "Reading…" : "↻ Re-observe all three"}
          </button>
          {tab === "plan" ? (
            <a className="pill" href={`/api/plan/${store}/text`} download style={{ textDecoration: "none" }}>
              ↓ plan-{store}.txt
            </a>
          ) : null}
          <span className="mut">
            Nothing is written to Serato or rekordbox. This is the list to apply yourself.
          </span>
        </>
      }
    >
      <div className="banner">
        No store is the source of truth — they have diverged. Identity is the audio
        content hash, so a track is the same track across renames and folder moves.
      </div>

      <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
        {(["drift", "plan"] as const).map((t) => (
          <button key={t} className={`pill ${tab === t ? "go" : ""}`} onClick={() => setTab(t)}>
            {t === "drift" ? "Drift" : "Replay plan"}
          </button>
        ))}
        <div className="spacer" />
        {tab === "plan" ? STORES.map((s) => (
          <button key={s} className={`pill ${store === s ? "go" : ""}`} onClick={() => setStore(s)}>
            {LABEL[s]}
          </button>
        )) : null}
      </div>

      {tab === "drift" ? (
        !c ? <div className="mut">Reading stores…</div> : (
          <>
            <div className="dl" style={{ borderBottom: "1px solid var(--line)" }}>
              <span className="grow"><b>Store</b></span>
              <span className="mut" style={{ width: 90, textAlign: "right" }}>unique tracks</span>
              <span className="mut" style={{ width: 110, textAlign: "right" }}>points at missing</span>
            </div>
            {STORES.map((s) => (
              <div className="dl" key={s}>
                <span className={`s ${c.available[s] ? "m" : "x"}`}>{c.available[s] ? "ok" : "off"}</span>
                <span className="grow">
                  {LABEL[s]}
                  {s === "rekordbox" && c.available.rekordboxReason
                    ? <span className="mut"> — {c.available.rekordboxReason}</span> : null}
                </span>
                <span style={{ width: 90, textAlign: "right" }}>{c.totals[s]}</span>
                <span style={{ width: 110, textAlign: "right" }} className="mut">
                  {s === "serato" ? c.dangling.serato : s === "rekordbox" ? c.dangling.rekordbox : "—"}
                </span>
              </div>
            ))}

            <div className="mut" style={{ margin: "14px 0 8px" }}>
              On disk but missing from Serato: <b>{c.missing.notInSerato}</b> ·
              missing from rekordbox: <b>{c.missing.notInRekordbox}</b> ·
              rekordbox referencing tracks not on disk: <b>{c.missing.rekordboxNotOnDisk}</b>
            </div>

            <div className="dl" style={{ borderBottom: "1px solid var(--line)" }}>
              <span className="grow"><b>Playlist</b></span>
              {STORES.map((s) => (
                <span key={s} className="mut" style={{ width: 76, textAlign: "right" }}>{LABEL[s]}</span>
              ))}
            </div>
            {c.groups.map((g) => (
              <div className="dl" key={g.name}>
                <span className={`s ${g.agree ? "" : "e"}`}>{g.agree ? "" : "drift"}</span>
                <span className="grow">
                  {g.name}
                  {g.caseMismatch ? <span className="tag bad">case</span> : null}
                </span>
                <span style={{ width: 76, textAlign: "right" }}>{g.rekordbox}</span>
                <span style={{ width: 76, textAlign: "right" }}>{g.serato}</span>
                <span style={{ width: 76, textAlign: "right" }}>{g.fs}</span>
              </div>
            ))}
          </>
        )
      ) : !plan ? (
        <div className="mut">Computing plan…</div>
      ) : (
        <>
          <div className="mut" style={{ marginBottom: 10 }}>
            {plan.pending} to apply to {LABEL[store]} · {plan.satisfied} already match ·
            observed {ago(plan.observedAt)}
            {plan.stale ? " · no observation yet, re-observe first" : ""}
          </div>
          {!plan.actions.length ? (
            <div className="mut">No staged changes yet.</div>
          ) : plan.actions.map((a, i) => (
            <div className="dl" key={i} style={a.satisfied ? { opacity: 0.45 } : undefined}>
              <span className={`s ${a.action === "add" || a.action === "create_playlist" ? "m"
                : a.action === "delete_file" ? "x" : "e"}`}>
                {a.satisfied ? "ok" : a.action.replace("_playlist", "").replace("_file", "")}
              </span>
              <span className="grow">
                {a.label ?? a.playlist ?? a.path}
                {a.playlist && a.label ? <span className="mut"> → {a.playlist}</span> : null}
              </span>
              <span className="mut">{a.satisfied ? "already matches" : ""}</span>
            </div>
          ))}
        </>
      )}
    </Modal>
  );
}

/** The raw append-only intent log. */
export function OpsModal({ onClose, notify, onChange }: {
  onClose: () => void;
  notify: (m: string, k?: "ok" | "err") => void;
  onChange: () => void;
}) {
  const [ops, setOps] = useState<Op[] | null>(null);

  const load = () => {
    unwrap(api.ops.get({ query: { limit: "300" } }))
      .then(setOps).catch((e) => notify(e.message, "err"));
  };
  useEffect(load, [notify]);

  const undo = async (id: number) => {
    try {
      await unwrap(api.ops.undo.post({ ids: [id] }));
      load(); onChange(); notify("Op undone", "ok");
    } catch (e) { notify((e as Error).message, "err"); }
  };

  return (
    <Modal
      title="Change log · replayable intent"
      onClose={onClose}
      footer={<span className="mut">
        Keyed by content hash and playlist name, so the same op replays against any store.
      </span>}
    >
      {!ops ? <div className="mut">Loading…</div>
        : !ops.length ? <div className="mut">Nothing staged yet.</div>
        : ops.map((o) => (
          <div className="dl" key={o.id}>
            <span className={`s ${o.kind.startsWith("add") || o.kind === "create_playlist" ? "m"
              : o.kind === "delete_track" ? "x" : "e"}`}>
              {o.kind.replace("_playlist", "").replace("_track", "").replace("_to", "").replace("_from", "")}
            </span>
            <span className="grow">
              {o.track_label ?? o.playlist}
              {o.track_label && o.playlist ? <span className="mut"> → {o.playlist}</span> : null}
              {o.to_playlist ? <span className="mut"> → {o.to_playlist}</span> : null}
            </span>
            <span className="mut" title={o.track_hash ?? ""}>
              {o.track_hash ? o.track_hash.slice(0, 8) : ""}
            </span>
            <span className="mut">{ago(o.at)}</span>
            <button className="act" onClick={() => undo(o.id)}>undo</button>
          </div>
        ))}
    </Modal>
  );
}
