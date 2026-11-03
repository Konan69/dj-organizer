"""Apply the app's pending rekordbox additions. See APPLYING.md.

The app itself never writes to rekordbox; this standalone script does, once,
with a full backup first and an independent verification pass afterwards.

Two details matter:
  * add_content() reads tags off the real file so it needs the WSL path, but
    rekordbox only understands C:/... - FolderPath is rewritten after insert.
  * A track can legitimately be in several playlists. If a content row already
    exists for the path, reuse it and just add the playlist link - never create
    a second content row for the same file.

Usage:  python3 scripts/apply-rekordbox.py [--playlist NAME]
Exit 0 = clean. Exit 1 = review needed. Exit 2 = refused to run.
"""
import argparse
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import time
import urllib.request

import sqlalchemy as sa
from pyrekordbox import Rekordbox6Database

RB = "/mnt/c/Users/you/AppData/Roaming/Pioneer/rekordbox"
DB = f"{RB}/master.db"
API = "http://127.0.0.1:8765/api"
# {wsl path: comment} - DJ notes written to rekordbox's Comment field on import,
# only where the track has no comment yet, so an edit made in rekordbox wins.
COMMENTS_FILE = os.path.join(os.path.dirname(__file__), "..", "data", "rekordbox-comments.json")
COMMENTS = json.load(open(COMMENTS_FILE)) if os.path.exists(COMMENTS_FILE) else {}

parser = argparse.ArgumentParser()
parser.add_argument("--playlist", help="apply additions for only this playlist")
args = parser.parse_args()


# Any app that reads the rekordbox library can hold master.db-shm open. While
# it does, SQLite cannot open the database on /mnt/c at all (it fails with a
# bare "disk I/O error"), so check for the known readers by name rather than
# letting the write blow up halfway through.
DB_READERS = ("rekordbox", "dj.studio")


def holders() -> list[str]:
    out = subprocess.run(["cmd.exe", "/c", "tasklist"],
                         capture_output=True, text=True).stdout
    found = set()
    for line in out.splitlines():
        low = line.lower()
        for name in DB_READERS:
            if name in low:
                found.add(name)
    return sorted(found)


def db_opens() -> str | None:
    """Return None if the real database opens, else the failure reason."""
    try:
        probe = Rekordbox6Database(path=DB)
        probe.session.execute(sa.text("SELECT COUNT(*) FROM djmdContent")).scalar()
        probe.close()
        return None
    except Exception as e:  # noqa: BLE001
        return f"{type(e).__name__}: {str(e)[:120]}"


def file_metadata(path: str) -> tuple[dict, str | None]:
    """Read the fields add_content does not extract from the audio file."""
    probe = subprocess.run([
        "ffprobe", "-v", "error", "-show_entries",
        "stream=codec_type,sample_rate:format=duration:format_tags=title,artist",
        "-of", "json", path,
    ], capture_output=True, text=True, check=True)
    info = json.loads(probe.stdout)
    tags = {key.lower(): value for key, value in info.get("format", {}).get("tags", {}).items()}
    fields = {"Title": tags.get("title") or os.path.splitext(os.path.basename(path))[0]}
    duration = info.get("format", {}).get("duration")
    if duration:
        fields["Length"] = round(float(duration))
    audio = next((stream for stream in info.get("streams", [])
                  if stream.get("codec_type") == "audio"), None)
    if audio and audio.get("sample_rate"):
        fields["SampleRate"] = int(audio["sample_rate"])
    return fields, tags.get("artist")


# ---- guards ----------------------------------------------------------------
held = holders()
if held:
    sys.exit(f"REFUSED - these hold the rekordbox database: {', '.join(held)}. "
             "Close them, then re-run.")

# Even with nothing obvious running, a stale lock can linger. Prove the database
# is writable before taking a backup and starting work.
why = db_opens()
if why:
    sys.exit(f"REFUSED - cannot open the rekordbox database ({why}). "
             "Something still holds master.db-shm; close any DJ app and re-run.")

plan = json.load(urllib.request.urlopen(f"{API}/plan/rekordbox", timeout=60))
if plan.get("stale"):
    sys.exit("REFUSED - plan is stale. GET /api/stores to re-observe first.")

todo = [a for a in plan["actions"] if not a.get("satisfied")
        and (args.playlist is None or a.get("playlist") == args.playlist)]
adds = [a for a in todo if a["action"] == "add"]
edits = [a for a in todo if a["action"] == "edit_metadata"]
removes = [a for a in todo if a["action"] == "remove"]
PLAYLIST_OPS = ("create_playlist", "rename_playlist", "delete_playlist")
pl_ops = [a for a in todo if a["action"] in PLAYLIST_OPS]
other = [a for a in todo if a["action"] not in ("add", "edit_metadata", "remove") + PLAYLIST_OPS
         and not (args.playlist and a["action"] == "create_playlist")]
print(f"  pending {len(todo)}: {len(adds)} adds, {len(removes)} removes, {len(pl_ops)} playlist ops, {len(other)} other")
if other:
    for a in other[:10]:
        print(f"    NOT HANDLED: {a['action']} {a.get('playlist')} {a.get('label')}")
    sys.exit("REFUSED - this script only handles adds, removes and title/artist edits.")
# Tracks marked for deletion in the app. Each leaves rekordbox (playlist links
# and the collection row) and its file goes to the Windows Recycle Bin, so a
# mistake is one restore away. Only files that still exist are queued.
LIBDB = os.path.join(os.path.dirname(__file__), "..", "data", "library.db")
_lib = sqlite3.connect(LIBDB)
# A queued file that is already gone from disk has nothing left to delete.
_lib.execute("DELETE FROM pending_deletes WHERE track_id IN (SELECT id FROM tracks WHERE missing=1)")
_lib.commit()
trash = [(tid, path) for tid, path in _lib.execute(
    "SELECT t.id, t.path FROM pending_deletes p JOIN tracks t ON t.id=p.track_id WHERE t.missing=0")
    if os.path.exists(path) and (args.playlist is None)]
_lib.close()
print(f"  pending deletes {len(trash)}")
if not adds and not edits and not removes and not pl_ops and not trash:
    print("  nothing to do")
    sys.exit(0)

# ---- backup ----------------------------------------------------------------
bk = f"/mnt/c/Users/you/.dl/rbx-apply-backup-{time.strftime('%Y%m%d-%H%M%S')}"
os.makedirs(bk, exist_ok=True)
for f in ("master.db", "master.db-wal", "master.db-shm", "masterPlaylists6.xml"):
    if os.path.exists(f"{RB}/{f}"):
        shutil.copy2(f"{RB}/{f}", f"{bk}/{f}")
print(f"  backup: {bk}")
bk_root = os.path.dirname(bk)
for old in sorted(d for d in os.listdir(bk_root) if d.startswith("rbx-apply-backup-"))[:-5]:
    shutil.rmtree(os.path.join(bk_root, old), ignore_errors=True)

# ---- write -----------------------------------------------------------------
db = Rekordbox6Database(path=DB)
usn0 = db.get_local_usn()
before = db.session.execute(sa.text("SELECT COUNT(*) FROM djmdContent")).scalar()

playlists = {p.Name: p for p in db.get_playlist().all()}
# Playlist-level ops first, in the order they were made, so a rename lands
# before adds that name the new playlist.
for a in pl_ops:
    name, to = a.get("playlist"), a.get("toPlaylist")
    if a["action"] == "create_playlist" and name not in playlists:
        playlists[name] = db.create_playlist(name)
        print(f"    created playlist {name}")
    elif a["action"] == "rename_playlist" and name in playlists and to:
        db.rename_playlist(playlists[name], to)
        playlists[to] = playlists.pop(name)
        print(f"    renamed playlist {name} -> {to}")
    elif a["action"] == "delete_playlist" and name in playlists:
        db.delete_playlist(playlists.pop(name))
        print(f"    deleted playlist {name}")
db.flush()
created = reused = linked = 0
failed: list[tuple[str, str, str]] = []

for a in adds:
    wsl, name = a["path"], a["playlist"]
    win = wsl.replace("/mnt/c/", "C:/")
    try:
        if not os.path.exists(wsl):
            failed.append((name, a["label"], "file missing on disk"))
            continue

        pl = playlists.get(name)
        if pl is None:
            pl = db.create_playlist(name)
            playlists[name] = pl
            print(f"    created playlist {name}")

        row = db.session.execute(
            sa.text("SELECT ID FROM djmdContent WHERE FolderPath=:p"), {"p": win}).fetchone()
        if row:
            cid = row[0]
            reused += 1
        else:
            fields, artist_name = file_metadata(wsl)
            if artist_name:
                artist = db.get_artist(Name=artist_name).one_or_none()
                if artist is None:
                    artist = db.add_artist(artist_name)
                fields["ArtistID"] = artist.ID
            content = db.add_content(wsl, **fields)
            db.flush()
            cid = content.ID
            db.session.execute(
                sa.text("UPDATE djmdContent SET FolderPath=:w WHERE ID=:i"),
                {"w": win, "i": cid})
            created += 1

        if wsl in COMMENTS:
            db.session.execute(
                sa.text("UPDATE djmdContent SET Commnt=:c WHERE ID=:i "
                        "AND (Commnt IS NULL OR Commnt='')"),
                {"c": COMMENTS[wsl], "i": cid})

        dup = db.session.execute(
            sa.text("SELECT 1 FROM djmdSongPlaylist WHERE PlaylistID=:p AND ContentID=:c"),
            {"p": pl.ID, "c": cid}).fetchone()
        if not dup:
            db.add_to_playlist(pl, cid)
            linked += 1
    except Exception as e:  # one bad file must not cost us the rest
        failed.append((name, a["label"], str(e)[:120]))

trashed: list[int] = []
for tid, wsl in trash:
    win = wsl.replace("/mnt/c/", "C:/")
    for (cid,) in db.session.execute(
            sa.text("SELECT ID FROM djmdContent WHERE FolderPath=:w"), {"w": win}).fetchall():
        db.session.execute(sa.text("DELETE FROM djmdSongPlaylist WHERE ContentID=:c"), {"c": cid})
        db.session.execute(sa.text("DELETE FROM djmdContent WHERE ID=:c"), {"c": cid})
    trashed.append(tid)

unlinked = 0
for a in removes:
    pl = playlists.get(a["playlist"])
    win = a["path"].replace("/mnt/c/", "C:/")
    rows = db.session.execute(
        sa.text("SELECT sp.ID FROM djmdSongPlaylist sp JOIN djmdContent c ON c.ID=sp.ContentID "
                "WHERE sp.PlaylistID=:p AND c.FolderPath=:w"),
        {"p": pl.ID if pl else None, "w": win}).fetchall() if pl else []
    for (sid,) in rows:
        db.remove_from_playlist(pl, sid)
        unlinked += 1

db.commit()
db.close()
recycled = 0
for tid, wsl in trash:
    if tid not in trashed:
        continue
    win = wsl.replace("/mnt/c/", "C:\\").replace("/", "\\")
    ps = ("Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile("
          f"'{win.replace(chr(39), chr(39) * 2)}', 'OnlyErrorDialogs', 'SendToRecycleBin')")
    r = subprocess.run(["powershell.exe", "-NoProfile", "-Command", ps], capture_output=True, text=True)
    if r.returncode != 0 or os.path.exists(wsl):
        failed.append(("(delete)", os.path.basename(wsl), (r.stderr or "still on disk").strip()[:120]))
        continue
    lib = sqlite3.connect(LIBDB)
    lib.execute("UPDATE tracks SET missing=1 WHERE id=?", (tid,))
    lib.execute("DELETE FROM pending_deletes WHERE track_id=?", (tid,))
    lib.commit(); lib.close()
    recycled += 1
print(f"  deleted to Recycle Bin {recycled}")
# Title/artist edits made in the app (track_overrides), matched to rekordbox by
# path. Their own session and commit: pyrekordbox cannot flush new content rows
# and a modified existing row together.
db = Rekordbox6Database(path=DB)
lib = sqlite3.connect(os.path.join(os.path.dirname(__file__), "..", "data", "library.db"))
edited = 0
edited_ops: list[int] = []
for a in edits:
    row = lib.execute(
        "SELECT t.path, o.title, o.artist FROM tracks t JOIN track_overrides o "
        "ON o.track_hash=t.content_hash WHERE t.content_hash=? AND t.missing=0", (a["hash"],)).fetchone()
    if not row:
        failed.append(("(edit)", a["label"], "no current override for this track"))
        continue
    path, title, artist_name = row
    content = db.get_content(FolderPath=path.replace("/mnt/c/", "C:/")).one_or_none()
    if content is None:
        failed.append(("(edit)", a["label"], "track not in rekordbox yet"))
        continue
    if title:
        content.Title = title
    if artist_name:
        artist = db.get_artist(Name=artist_name).one_or_none() or db.add_artist(artist_name)
        db.flush()
        content.ArtistID = artist.ID
    edited += 1
    edited_ops += a.get("opIds", [])

db.commit()
db.close()
# Without this the plan keeps the edit pending and every pass re-applies it
# (and takes another backup).
if edited_ops:
    req = urllib.request.Request(
        f"{API}/ops/applied", method="POST",
        data=json.dumps({"store": "rekordbox", "ids": edited_ops}).encode(),
        headers={"Content-Type": "application/json"})
    urllib.request.urlopen(req, timeout=30).read()
print(f"  title/artist edits applied {edited}")
print(f"  content rows created {created}, reused {reused}, playlist links added {linked}, removed {unlinked}")
for n, label, err in failed:
    print(f"    FAILED {n} | {label[:40]} | {err}")

# ---- verify on a fresh connection ------------------------------------------
v = Rekordbox6Database(path=DB)
after = v.session.execute(sa.text("SELECT COUNT(*) FROM djmdContent")).scalar()
dups = v.session.execute(sa.text(
    "SELECT COUNT(*) FROM (SELECT FolderPath FROM djmdContent "
    "GROUP BY FolderPath HAVING COUNT(*)>1)")).scalar()
bad = v.session.execute(sa.text(
    "SELECT COUNT(*) FROM djmdContent WHERE FolderPath LIKE '/mnt/%'")).scalar()
print(f"  djmdContent {before} -> {after} | duplicate paths {dups} | bad /mnt paths {bad}")
print(f"  USN {usn0} -> {v.get_local_usn()}")
for name in sorted({a["playlist"] for a in adds + removes}):
    c = v.session.execute(sa.text(
        "SELECT COUNT(*) FROM djmdSongPlaylist sp JOIN djmdPlaylist p ON p.ID=sp.PlaylistID "
        "WHERE p.Name=:n"), {"n": name}).scalar()
    print(f"    {name:<22}{c}")
v.close()
# Re-read rekordbox now, while it is still closed. Otherwise the app keeps its
# pre-write look (it cannot read the library while rekordbox runs) and shows
# every change just written as still to apply.
urllib.request.urlopen(f"{API}/stores", timeout=300).read()

ok = not failed and dups == 0 and bad == 0
print("  ->", "ALL CLEAR" if ok else "REVIEW NEEDED")
sys.exit(0 if ok else 1)
