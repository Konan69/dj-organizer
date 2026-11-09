# dj-organizer

Clean up a DJ library without touching it until you say so.

My library grows from downloads, rips, rekordbox imports and set prep, so the same audio ends up in two folders under two names, and rekordbox and the disk drift apart. Tools that fix this by moving files are risky on a library you play live from. dj-organizer scans the folder, identifies tracks by a hash of the audio (so a renamed or retagged file is still the same track), finds duplicates, and lets you stage playlist changes in a local web UI. Nothing leaves the app except as a text plan, a rekordbox XML, or one guarded apply that backs up `master.db` first.

![A terminal starts dj-organizer on the sample library, stages the one duplicate track and prints the changeset that tells you to delete the copy by hand](docs/media/hero.gif)

## Install

Bun 1.3+ and `curl`. For rekordbox features, Python 3 with `pyrekordbox` and rekordbox 6 or 7. For downloads, `yt-dlp`.

```bash
git clone <this-repo-url> dj-organizer && cd dj-organizer
bun install && bun run build
cp config.example.env .env        # set DJ_LIBRARY_ROOT to your music folder
```

## Use

```bash
./serve.sh start                                        # http://localhost:8765
curl -s -X POST localhost:8765/api/duplicates/resolve   # stage duplicates (or use the UI)
curl -s localhost:8765/api/changes.txt                  # the plan against rekordbox
curl -s localhost:8765/api/export/rekordbox.xml         # or import this into rekordbox
./serve.sh stop
```

Against the bundled sample library (six sine-tone tracks, one exact copy):

```console
$ DJ_LIBRARY_ROOT=$PWD/fixtures/library ./serve.sh start
up   http://localhost:8765   (pid 895466)
$ curl -s -X POST localhost:8765/api/duplicates/resolve
{"groups":1,"staged":1,"membershipsMerged":0,"skippedManual":0,"reclaim":34054}
$ curl -s localhost:8765/api/changes.txt
# dj-organizer changeset
# generated 2026-11-09T20:56:16.516Z

## delete by hand (1) — this app moves nothing
  x Techno/Example Artist - First Light (copy).m4a   [duplicate]
```

The file is still on disk. The **Apply** button is the one path that writes to rekordbox: it closes rekordbox, copies `master.db` to `DJ_BACKUP_DIR`, adds the pending tracks and playlist links, checks the result and reopens it.

Also in the repo: `worker/`, a Cloudflare Worker that keeps your YouTube Music playlists synced to D1, and `tools/`, standalone downloaders (`dl` in Rust, a PowerShell module) and `stem-grid`, which warps four stems to one tempo grid.

How identity, the operation log and the plans work: [docs/internals.md](docs/internals.md). The tools: [docs/tools.md](docs/tools.md). Every variable: [docs/configuration.md](docs/configuration.md).

## Limits

- **Your media, your accounts.** dj-organizer and the tools do not include any music, cookies or tokens, and they do not remove DRM. Downloads go through `yt-dlp` and `scdl` with the cookies and tokens you supply from your own accounts. You are responsible for having the rights to what you download.
- **Windows and WSL.** rekordbox runs only on Windows and macOS. The **Apply** path and the `C:` to `/mnt/c` path mapping assume Windows or WSL. `MusicDownload.psm1` is written for Windows PowerShell. The scan, duplicate finder, staging UI and plans run on Linux, as in the quick start. macOS has not been tested.
- **No file moves.** The app never renames, moves or deletes library files. You do those from the plans.
- **YouTube Music sync** needs your own deployed Worker and a seed playlist. It depends on YouTube's unofficial browse protocol through `ytmusicapi` and the Worker's own fetcher, so it can break when YouTube changes.
- **stem-grid** treats 0 s as the first beat. On synthetic stems whose first beat was at 0.5 s it stopped with `Time-map frame positions are not strictly monotonic`. It has been tested only on synthetic stems, not on a real track.
- The test suites `prep.test.ts` and `prep-sets.test.ts` write temporary audio under `/mnt/c/Users/Public` unless you set `DJ_TEST_WIN_DIR`.

## License

MIT
