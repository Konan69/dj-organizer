# dj-organizer

Staging UI for the DJ library at `C:\Users\you\Music\tracks`.

**It never writes to Serato or rekordbox.** It reads the `.crate` files once to learn
the current state, then everything you do lives in its own SQLite DB. When you're
happy, it hands you a changeset to apply by hand.

```
Serato .crate files ──read once──> staging DB ──> changeset.txt ──> you apply manually
   (never written)                 (all edits)
```

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

## Layout

```
api/src/
  index.ts     Elysia routes + audio streaming (Range)
  db.ts        bun:sqlite schema
  tags.ts      MP4 atom parser — title/artist/duration/bitrate/video id
  scan.ts      → library.ts: disk walk, seed playlists from crates, apply deletes
  serato.ts    crate format, READ-ONLY (imports no fs write API on purpose)
  dupes.ts     duplicate detection
  changes.ts   staged vs. on-disk crates → the manual changeset
  snapshots.ts staging DB backups
  ytm.ts       upstream diff (caching + matching)
api/py/
  ytm_bridge.py   only Python left; ytmusicapi has no TS equivalent
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
