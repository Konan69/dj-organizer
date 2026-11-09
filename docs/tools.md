# Tools

`tools/` holds standalone command-line tools that the app does not call.

`tools/dl` is a Rust wrapper around `yt-dlp` for YouTube Music and SoundCloud audio:

```text
$ cargo build --release --manifest-path tools/dl/Cargo.toml
$ tools/dl/target/release/dl --help
usage:
  dl URL [OUT_DIR]          download best available audio
  dl -F URL                 list formats
  dl doctor                 show setup status

YouTube Music:
  uses PO-token provider + EJS + web_music client
  prefers 774/141/251/140/bestaudio
  reads cookies from %YTDLP_COOKIES% or %USERPROFILE%\yt-cookies.txt
$ tools/dl/target/release/dl doctor
yt-dlp: true
node: true
pot_provider_repo: false
pot_provider_port: false
cookies: not found (expected %YTDLP_COOKIES% or %USERPROFILE%\yt-cookies.txt)
```

For YouTube URLs, `dl` starts the [bgutil-ytdlp-pot-provider](https://github.com/Brainicism/bgutil-ytdlp-pot-provider) server from `~/bgutil-ytdlp-pot-provider` if nothing listens on port 4416. You install that provider yourself.

`tools/powershell/MusicDownload.psm1` gives Windows PowerShell the same downloads as short commands: `sc`, `scf`, `scy` and `sci` for SoundCloud, `ytm` and `ytmf` for YouTube Music, and `Start-YtPotProvider`. Add these lines to your profile:

```powershell
Remove-Item Alias:sc -Force -ErrorAction SilentlyContinue
Import-Module <path>\MusicDownload.psm1
```

The first line is needed because Windows PowerShell maps `sc` to `Set-Content`.

`tools/stem-grid/render_grid.py` takes four stems in the htdemucs layout (`vocals.wav`, `other.wav`, `drums.wav`, `bass.wav`) and a full mix. It builds one beat map from the drums and the mix, warps every stem through that map with `rubberband` to a target tempo, and checks the output for clicks at the joins and for a steady beat. On a synthetic 40 s, 66.7 BPM set of stems, `--bpm 150` gave four 17.79 s files with 45 output beats at a median 0.4005 s apart and 0 join clicks:

```bash
python3 tools/stem-grid/render_grid.py --mix mix.wav --stems stems --out out --bpm 150
```

The script never overwrites an existing `<stem>_final_<bpm>.wav`.
