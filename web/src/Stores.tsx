import { useEffect, useState } from "react";
import { api, unwrap, type Op, type PlanFor, type StoresView } from "./api";
import { Mark, Modal, Wait, plural } from "./Modals";
import { EmptyState, Icon, Segmented } from "./ui";

const STORES = ["rekordbox", "fs"] as const;
type StoreName = (typeof STORES)[number];

/** Start-of-label form, for controls and column heads. */
const LABEL: Record<StoreName, string> = { rekordbox: "Rekordbox", fs: "Disk" };
/** Mid-sentence form. */
const NAME: Record<StoreName, string> = { rekordbox: "rekordbox", fs: "disk" };

const ago = (ts: number | null | undefined) => {
  if (!ts) return "never";
  const s = Math.floor(Date.now() / 1000) - ts;
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

type Tone = "" | "ok" | "warn" | "danger";

/** Plan actions, in the words you would use applying them by hand. */
const ACTION: Record<string, [string, Tone]> = {
  create_playlist: ["Create", "ok"],
  delete_playlist: ["Delete", "danger"],
  rename_playlist: ["Rename", ""],
  add: ["Add", "ok"],
  remove: ["Remove", "warn"],
  delete_file: ["Delete", "danger"],
  edit_metadata: ["Edit", ""],
};

/** Logged changes, same vocabulary. */
const OP: Record<string, [string, Tone]> = {
  create_playlist: ["Create", "ok"],
  delete_playlist: ["Delete", "danger"],
  rename_playlist: ["Rename", ""],
  add_to: ["Add", "ok"],
  remove_from: ["Remove", "warn"],
  delete_track: ["Delete", "danger"],
  download_track: ["Download", "ok"],
  edit_metadata: ["Edit", ""],
};

/**
 * The observed stores side by side, plus the per-store replay plan.
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
    try {
      const [nextData, nextPlan] = await Promise.all([
        unwrap(api.stores.get()),
        unwrap(api.plan({ store }).get()),
      ]);
      setData(nextData);
      setPlan(nextPlan);
    }
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
      title="Rekordbox and disk"
      onClose={onClose}
      footer={
        <>
          {tab === "plan" ? (
            <a
              className="ui-btn outline" href={`/api/plan/${store}/text`} download
              title={`Download the ${NAME[store]} plan. Nothing is written to ${NAME[store]}; apply it yourself.`}
            ><Icon name="export" />Download plan</a>
          ) : null}
          <button
            type="button" className="ui-btn primary" onClick={refresh} disabled={busy}
            title="Read rekordbox and the disk again"
          ><Icon name="sync" />{busy ? "Checking…" : "Check again"}</button>
        </>
      }
    >
      <div className="modal-bar">
        <Segmented
          label="View" value={tab} onChange={setTab}
          options={[{ value: "drift", label: "Files & folders" }, { value: "plan", label: "To apply" }]}
        />
        {tab === "plan" ? (
          <span className="push">
            <Segmented
              label="Apply to" value={store} onChange={setStore}
              options={STORES.map((s) => ({ value: s, label: LABEL[s] }))}
            />
          </span>
        ) : null}
      </div>

      {tab === "drift" ? (
        !c ? <Wait /> : (
          <>
            <div className="stat-row">
              {STORES.map((s) => (
                <div className="stat" key={s}>
                  <div className="stat-hd">
                    {LABEL[s]}
                    <span
                      className={`ui-tag ${c.available[s] ? "ok" : "danger"}`}
                      title={s === "rekordbox" ? c.available.rekordboxReason ?? undefined : undefined}
                    ><span className="ui-dot" />{c.available[s] ? "Connected" : "Unavailable"}</span>
                  </div>
                  <div className="stat-n">{c.totals[s]}</div>
                  <div className="stat-sub">
                    {s === "rekordbox" && c.dangling.rekordbox
                      ? `tracks · ${plural(c.dangling.rekordbox, "missing file")}` : "tracks"}
                  </div>
                </div>
              ))}
            </div>

            <div className="dlist">
              <div className="dl">
                <span className="grow">On disk, not in rekordbox</span>
                <span className="col">{c.missing.notInRekordbox}</span>
              </div>
              <div className="dl">
                <span className="grow">In rekordbox, not on disk</span>
                <span className="col">{c.missing.rekordboxNotOnDisk}</span>
              </div>
            </div>

            <h3 className="modal-sub" title="A track can be in several playlists but only one disk folder">Playlists / folders</h3>
            <div className="dlist">
              <div className="dl head">
                <span className="grow">Name</span>
                <span className="col">Playlist</span>
                <span className="col">Folder</span>
              </div>
              {c.groups.map((g) => (
                <div className="dl" key={g.name}>
                  <span className="grow">{g.name}</span>
                  <span className="col">{g.rekordbox}</span>
                  <span className="col">{g.fs}</span>
                </div>
              ))}
            </div>
          </>
        )
      ) : !plan ? (
        <Wait />
      ) : (
        <>
          <p className="mut lead">
            {plan.pending} to apply · {plan.satisfied} done · checked {ago(plan.observedAt)}
            {plan.stale
              ? <> <span className="ui-tag warn" title="Press Check again for an up-to-date plan">Out of date</span></>
              : null}
          </p>
          {!plan.actions.length ? (
            <EmptyState title="Nothing to apply" />
          ) : (
            <div className="dlist">
              {plan.actions.map((a, i) => {
                const [label, tone] = ACTION[a.action] ?? [a.action, ""];
                return (
                  <div className={`dl ${a.satisfied ? "done" : ""}`} key={i}>
                    {a.satisfied
                      ? <Mark title={`Already matches ${NAME[store]}`}><Icon name="check" stroke={2.2} />Done</Mark>
                      : <Mark tone={tone}>{label}</Mark>}
                    <span className="grow" title={a.path}>
                      {a.label ?? a.playlist ?? a.path}
                      {a.playlist && a.label ? <span className="mut"> · {a.playlist}</span> : null}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
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
      load(); onChange(); notify("Change undone", "ok");
    } catch (e) { notify((e as Error).message, "err"); }
  };

  return (
    <Modal title="Change log" onClose={onClose}>
      {!ops ? <Wait />
        : !ops.length ? <EmptyState title="No changes yet" />
        : (
          <div className="dlist">
            {ops.map((o) => {
              const [label, tone] = OP[o.kind] ?? [o.kind, ""];
              return (
                <div className="dl" key={o.id}>
                  <Mark tone={tone}>{label}</Mark>
                  <span className="grow">
                    {o.track_label ?? o.playlist}
                    {o.track_label && o.playlist ? <span className="mut"> · {o.playlist}</span> : null}
                    {o.to_playlist ? <span className="mut"> to {o.to_playlist}</span> : null}
                  </span>
                  <span className="end">{ago(o.at)}</span>
                  <button type="button" className="ui-btn sm ghost" onClick={() => undo(o.id)}>
                    <Icon name="undo" />Undo
                  </button>
                </div>
              );
            })}
          </div>
        )}
    </Modal>
  );
}
