# dj-organizer

Backend and staging UI for the DJ library at `C:\Users\you\Music\tracks`.
The only stores are rekordbox and the filesystem. Both are observed read-only;
changes are recorded in SQLite and emitted as plans to apply by hand.

```
  rekordbox master.db ─┐
  filesystem ──────────┴─ observed ─→ staging DB ─→ replay plans
```

## Applying changes

Use `GET /api/export/rekordbox.xml` to create the documented, non-destructive
rekordbox XML interchange file. `GET /api/export/rekordbox/info` gives the import
steps. Never write to rekordbox `master.db`.

Use `GET /api/plan/fs/text` for filesystem work. Deletions are intentionally
manual; the app never moves, renames, overwrites, or removes library files.

## Run

```bash
./serve.sh start      # http://localhost:8765
bun run web           # optional Vite dev server on :5173
bun run build         # rebuild the SPA
```

## What it does

| Feature | Behavior |
|---|---|
| Organize | Add or move tracks between playlists |
| Playlists | Create, rename, and delete membership without deleting files |
| Deletes | Stage first; apply from the filesystem plan by hand |
| Duplicates | Detect identical audio, shared sources, and same-name containers |
| Upstream | Compare local playlists with YouTube Music and stage downloads |
| Changeset | Show staged playlist changes against the latest rekordbox observation |
| Stores | Compare rekordbox and filesystem observations and produce replay plans |
| Watch & learn | A queue of tutorials and filmed sets: watch in place, resume where you stopped, jump by chapter, keep notes |

Track identity is an xxHash64 of the audio payload where possible, then the
source video id and a fuzzy title/duration key. This survives renames, folder
moves, and metadata changes.

## Watch & learn

A second queue beside the library: the videos to work through before the set.
Each one keeps its own status (`queued` / `watching` / `done` / `skipped`), the
second you stopped at, and the notes written while watching. `watching` is set
by the player once a video has actually run for 30 seconds, not by opening it.

Title, channel, length and chapters come from `yt-dlp` — the same binary the
downloader uses — so a pasted link fails loudly rather than being stored as its
own URL. Thumbnails reuse the library's on-disk art cache, keyed by video id.

```bash
bun scripts/seed-learn.ts                 # import ~/dj/watchlist.md
bun scripts/seed-learn.ts path/to/list.md # or another file in that format
```

The seed is re-runnable and never touches a video already on the list, so a
status or a note is safe from a second import. Videos struck from the source
file arrive as `skipped` with the reason, not missing — a cut stays reversible.

## Safety

- `BANGERS !!!!` is manual. Dedupe never adds or removes membership from it.
- Downloads are the sole write exception outside `data/`: they may add new
  folders and `.m4a` files under the tracks directory, with `yt-dlp --no-overwrites`.
- All other changes remain in the staging database or as a hand-applied plan.
- Snapshots live in `data/snapshots/`; restore one only after stopping the server.
- `bun api/src/selftest.ts` checks file metadata integrity and the no-destructive-
  writer contract, including the read-only rekordbox boundary.

## Layout

```
api/src/
  index.ts     Elysia routes + audio streaming
  db.ts        bun:sqlite schema
  library.ts   filesystem scan and content hashing
  tags.ts      media metadata parser
  identity.ts  stable track identity
  stores.ts    rekordbox/filesystem observations and drift
  ops.ts       append-only intent log and per-store plans
  rbxml.ts     rekordbox XML export
  dupes.ts     duplicate detection and staging
  changes.ts   staged vs. rekordbox changeset
  snapshots.ts staging DB backups
  ytm.ts       upstream diff and download staging
  learn.ts     the watchlist: videos, status, resume position, notes
api/py/
  rekordbox_bridge.py  read-only status and dump
  ytm_bridge.py        YouTube Music bridge
scripts/
  seed-learn.ts        import ~/dj/watchlist.md into the watchlist
web/src/       Vite + React client
data/          local database, snapshots, and logs (gitignored)
```

## References

- rekordbox XML spec — <https://rekordbox.com/en/support/developer/>
- pyrekordbox XML docs — <https://pyrekordbox.readthedocs.io/en/latest/formats/xml.html>
