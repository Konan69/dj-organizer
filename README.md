# dj-organizer

Staging UI for the DJ library at `C:\Users\you\Music\tracks`.

**It never writes to Serato or rekordbox.** It observes all three stores, keeps every
edit in its own SQLite DB, and hands you a per-store plan to apply by hand.

```
  rekordbox master.db ─┐
  Serato .crate files ─┼─ observed (read-only) ─→ staging DB ─→ per-store replay plan
  filesystem ──────────┘                          (op log)      + rekordbox XML export
```

## Where the source of truth is

Nowhere. All three have diverged, measured on this library:

| | rekordbox | Serato | filesystem |
|---|---|---|---|
| unique tracks (by content hash) | 668 | 662 | **684** |
| Dub | **40** | 19 | 19 |
| Hardstyle | **88** | 57 | 57 |
| BANGERS | 95 | 93 | **112** |
| references files that don't exist | 9 | 0 | — |

rekordbox is the most drifted — it still holds tracks moved out a session ago.
Serato can't read the 22 `.webm`. The filesystem has every file but can't express
membership (a file lives in exactly one folder).

So identity is **not** path, folder or mtime. It is an xxHash64 of the `mdat` audio
payload, which survives renames, folder moves and tag rewrites (Serato and rekordbox
both rewrite tags). Two copies of the same track in different folders hash equal.
That turned a guessed 75 duplicate groups into 41 provably byte-identical ones.

## Applying changes

**rekordbox — use the XML export.** Pioneer documents this format for playlist
interchange and rekordbox imports it non-destructively into its own browser source.
Preferred over writing `master.db` because that database is SQLCipher-encrypted, the
key extraction has broken before (6.6.5 compiled `app.asar` to `.jsc`), this machine
runs 7.2.14 while pyrekordbox is tested to 7.0.9, and direct writes must maintain USN
bookkeeping. An XML file is inert.

```
GET /api/export/rekordbox.xml        # 704 tracks, 19 playlists, every Location verified
GET /api/export/rekordbox/info       # + the import steps
```

**Serato — crate rewrites must preserve `ovct`.** Serato writes one `ovct` chunk per
visible column (song/artist/bpm/key/album/length/comment, with widths) plus `osrt` for
sort order. Writing only `vrsn`+`otrk` is accepted but silently resets that crate's
column layout — which earlier writes in this library already did. `build()` now takes
the preserved chunks; `GET /api/serato/inspect` shows what each crate currently holds.

Note `database V2` (1121 entries) is separate from crates: crates carry only paths,
while BPM/key/comments live in the index, which Serato repopulates itself.

## Run

```bash
./serve.sh start      # http://localhost:8765   (stop | restart | status | log)
bun run web           # optional: Vite dev server on :5173 with HMR
bun run build         # rebuild the SPA that serve.sh serves
```

## What it does

| | |
|---|---|
| **Organize** | drag tracks onto a playlist in the sidebar. Default = add, hold **⇧** = move |
| **Add / remove** | drag, or select + `Remove from playlist` |
| **Create / delete playlists** | `+` in the sidebar header; delete removes membership only, never files |
| **Delete tracks** | staged first. `Apply` moves files to `_TRASH` — never `unlink` |
| **Duplicates** | finds same-name and same-video-id copies, proposes a keeper, merges playlists into it |
| **Upstream** | diffs each playlist against YouTube Music: what failed to download, what's local-only |
| **Changeset** | the list of everything staged, as grouped view or `changeset.txt` |
| **Stores** | all three side by side, drift per playlist, and the per-store replay plan |
| **Change log** | the append-only op log — keyed by content hash + playlist name |

Keyboard: `/` filter · `space` preview · `⌘/ctrl+A` select all · `⌫` stage delete · `esc` clear.

## Safety

- `BANGERS !!!!` is marked manual. Nothing automatic writes to it — dedupe always
  prefers the copy already in a manual playlist as the keeper, so those playlists
  can never gain or lose a track on their own.
- Deletes are two-step (stage, then Apply) and move to `_TRASH`.
- Snapshots of the staging DB are taken on startup and before any bulk action,
  kept in `data/snapshots/` (last 20). To roll back:
  ```bash
  ./serve.sh stop
  cp data/snapshots/<snap>.db data/library.db
  rm -f data/library.db-wal data/library.db-shm
  ./serve.sh start
  ```
- `bun api/src/selftest.ts` verifies the crate parser round-trips and that every
  video id actually appears in the file it was read from.
- Both targets are fingerprinted before and after test runs; playlist create,
  rename, membership, dedupe and observation all leave them byte-identical.

## Layout

```
api/src/
  index.ts     Elysia routes + audio streaming (Range)
  db.ts        bun:sqlite schema
  tags.ts      MP4 atom parser — title/artist/duration/bitrate/video id
  scan.ts      → library.ts: disk walk, seed playlists from crates, apply deletes
  serato.ts    crate format, READ-ONLY (imports no fs write API on purpose)
  identity.ts  content hashing — xxHash64 over the mdat audio payload
  stores.ts    observe fs / Serato / rekordbox, and measure drift
  ops.ts       append-only replayable intent log + per-store plans
  rbxml.ts     rekordbox XML export (the sanctioned import path)
  dupes.ts     duplicate detection, tiered by strength of evidence
  changes.ts   staged vs. on-disk crates → the manual changeset
  snapshots.ts staging DB backups
  ytm.ts       upstream diff (caching + matching)
api/py/
  rekordbox_bridge.py  READ ONLY — status | dump. No write path exists in it.
  ytm_bridge.py        ytmusicapi has no TS equivalent
web/src/       Vite + React, Eden-typed client
data/          library.db, snapshots/, ops.log, server.log  (gitignored)
```

## Notes

- Video ids come from the `©cmt` atom only. The `desc` atom holds the uploader's
  description, which links other people's videos — reading ids from it attributes
  the wrong source and makes distinct songs look like duplicates.
- `ytmusicapi`'s `get_library_playlists()` / `get_liked_songs()` are broken
  server-side. Only `get_playlist(id)` works, so playlist ids are hardcoded in
  `api/py/ytm_bridge.py`.
- The 22 `.webm` files are duplicates of existing `.m4a` tracks and are unreadable
  by Serato and rekordbox. They show under **Unfiled** and **Duplicates**.
- The embedded genre tag is the uploader's YouTube category ("Music",
  "Entertainment"), so the XML export uses the folder as Genre instead.
- `&` is legal in these filenames and `encodeURI` leaves it alone, which produces
  invalid XML inside a `Location` attribute. 163 tracks here are affected; it is
  percent-encoded explicitly.

## References

- rekordbox XML spec — <https://rekordbox.com/en/support/developer/>
- pyrekordbox XML docs — <https://pyrekordbox.readthedocs.io/en/latest/formats/xml.html>
- Serato database format — <https://github.com/mixxxdj/mixxx/wiki/Serato-Database-Format>
  (note: some copies of this page say `otat` for crate tracks; real crates on this
  machine use `otrk`, verified against Serato's own backup files)
