# Configuration

The server reads environment variables. Copy `config.example.env` to `.env` in the repository root. Bun loads `.env` at startup and the Python helpers inherit it. `serve.sh` also loads `data/sync.env` if it exists. Every value is optional.

| Variable | Default | What it does |
| --- | --- | --- |
| `DJ_LIBRARY_ROOT` | `~/Music/tracks` | The music folder the app scans and downloads into. |
| `DJ_REKORDBOX_DIR` | `~/AppData/Roaming/Pioneer/rekordbox` | rekordbox app data folder that holds `master.db` and `share/`. Under WSL, point it at the Windows profile. |
| `DJ_REKORDBOX_EXE` | `C:\Program Files\rekordbox\rekordbox 7.2.14\rekordbox.exe` | rekordbox executable that **Apply** reopens. |
| `DJ_DATA_DIR` | `./data` | App state: `library.db`, snapshots, art cache, `openrouter.json`. |
| `DJ_BACKUP_DIR` | `$DJ_DATA_DIR/backups` | Where `scripts/apply-rekordbox.py` copies `master.db` before it writes. |
| `DJ_YTDLP` | `yt-dlp` | The `yt-dlp` binary. |
| `DJ_NODE` | `node` | The Node.js binary that `yt-dlp` uses for YouTube's JavaScript challenge. |
| `DJ_YTM_COOKIES` | `$DJ_DATA_DIR/cookies/ytm-premium.txt` | Netscape cookie file exported from your own signed-in browser. |
| `DJ_YTM_SEED_PLAYLIST` | none | Id of a public playlist you own. The app discovers playlists on that playlist's channel. |
| `DJ_SYNC_URL` | none | URL of your deployed dj-sync Worker, for `POST /api/ytm/pull`. |
| `DJ_SYNC_TOKEN` | none | Bearer token. Use the same value as the Worker's `SYNC_TOKEN` secret. |
| `DJ_MANUAL_PLAYLISTS` | none | Comma-separated playlist names that you curate by hand. Dedupe never writes into them. |
| `DJ_SYNC_EXCLUDED_PLAYLISTS` | none | Comma-separated playlist names that sync never pulls or stages. |
| `DJ_AUTO_MEMBERSHIP_EXCLUDED_PLAYLISTS` | none | Comma-separated playlist names that never get automatic memberships. |
| `OPENROUTER_API_KEY` | none | Enables AI set suggestions. You can also save the key from the UI. |
| `PORT` | `8765` | Server port. |

`tools/dl` and `MusicDownload.psm1` read these variables:

| Variable | Default | What it does |
| --- | --- | --- |
| `YTDLP_COOKIES` | `yt-cookies.txt` in your home folder | Netscape cookie file for YouTube Music. |
| `SOUNDCLOUD_OAUTH_TOKEN` | none | Your SoundCloud OAuth token, for streams your account can play. |
| `SOUNDCLOUD_PROXY_URL` | none | Proxy for SoundCloud requests. |
| `BGUTIL_POT_PROVIDER_DIR` | `bgutil-ytdlp-pot-provider` in your home folder | Provider checkout. Only `MusicDownload.psm1` reads it. `dl` always uses the default. |

`render_grid.py` takes flags: `--mix`, `--stems` and `--out` (required), `--bpm` (default 150), `--source-bpm` (tempo hint for the beat tracker, default 66.3), `--min-source-beat` and `--max-source-beat` (the beat lengths in seconds it accepts from the source, default 0.8 and 1.0), and `--semitones` (pitch shift, default 2).
