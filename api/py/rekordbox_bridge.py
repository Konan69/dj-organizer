#!/usr/bin/env python3
"""rekordbox master.db bridge — READ ONLY.

Stays Python because pyrekordbox is the only library that can decrypt
rekordbox's SQLCipher database.

This script has NO write path. It opens the database, reads playlists and
content, and prints JSON. It never calls add_content / add_to_playlist /
delete / commit, and it never touches the file. Keep it that way: rekordbox is
the user's primary library and nothing here is authorised to modify it.

    python3 rekordbox_bridge.py status
    python3 rekordbox_bridge.py dump
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
from contextlib import contextmanager

RBX_DB = os.path.join(os.path.abspath(os.path.expanduser(os.environ.get("DJ_REKORDBOX_DIR") or "~/AppData/Roaming/Pioneer/rekordbox")), "master.db")


def out(obj):
    json.dump(obj, sys.stdout, default=str)
    sys.stdout.write("\n")
    sys.exit(0)


def is_running():
    try:
        r = subprocess.run(["cmd.exe", "/c", "tasklist"], capture_output=True,
                           text=True, timeout=30, cwd="/mnt/c")
        return "rekordbox.exe" in r.stdout
    except (subprocess.SubprocessError, OSError):
        return False


def to_wsl(p):
    return "/mnt/c/" + p[len("C:/"):] if p.startswith("C:/") else p


@contextmanager
def open_db():
    from pyrekordbox import Rekordbox6Database
    from sqlalchemy import text

    snapshot_dir = tempfile.mkdtemp(prefix="rekordbox-bridge-")
    snapshot_db = os.path.join(snapshot_dir, "master.db")
    db = None
    try:
        shutil.copy2(RBX_DB, snapshot_db)

        wal = f"{RBX_DB}-wal"
        if os.path.isfile(wal) and os.path.getsize(wal) > 0:
            shutil.copy2(wal, os.path.join(snapshot_dir, "master.db-wal"))

        db = Rekordbox6Database(path=snapshot_db)
        db.open()
        # Defense in depth: even accidental ORM writes fail in this connection.
        db.session.execute(text("PRAGMA query_only = ON"))
        yield db
    finally:
        try:
            if db is not None:
                db.close()
        finally:
            shutil.rmtree(snapshot_dir)


def related_name(row, relationship):
    """Read a pyrekordbox relationship without depending on its presence."""
    try:
        related = getattr(row, relationship, None)
        if related is None:
            return None
        # DjmdKey exposes its display value as ScaleName in current
        # pyrekordbox, while artist/genre-like relationships use Name.
        return getattr(related, "Name", None) or getattr(related, "ScaleName", None)
    except Exception:  # an incomplete relationship must not abort the snapshot
        return None


def normalized_bpm(value):
    """Rekordbox stores BPM as BPM*100; reject corrupt/unsupported values."""
    try:
        bpm = float(value)
    except (TypeError, ValueError):
        return None
    if bpm > 1000:
        bpm /= 100.0
    if not 20 <= bpm <= 300:
        return None
    return round(bpm, 2)


def normalized_cue(cue):
    """Normalize native milliseconds and Rekordbox's non-contiguous hot slots."""
    raw_kind = int(cue.Kind) if cue.Kind is not None else 0
    # Native values reserve 4: 1,2,3 => A,B,C and 5..17 => D..P.
    index = raw_kind if 1 <= raw_kind <= 3 else raw_kind - 1 if 5 <= raw_kind <= 17 else None
    kind = "hot" if index is not None else "memory"
    comment = cue.Comment.strip() if isinstance(cue.Comment, str) and cue.Comment.strip() else None
    slot = chr(ord("A") + index - 1) if index is not None else None
    label = comment or (f"Hot cue {slot}" if slot else "Memory cue")
    start = max(0, int(cue.InMsec or 0)) / 1000
    end_ms = int(cue.OutMsec) if cue.OutMsec is not None else -1
    end = end_ms / 1000 if end_ms >= 0 else None
    if end is not None and end <= start:
        end = None
    return {
        "id": str(cue.ID),
        "time": round(start, 6),
        "endTime": round(end, 6) if end is not None else None,
        "kind": kind,
        "index": index,
        "rawKind": raw_kind,
        "label": label,
        "comment": comment,
    }


def cmd_status():
    out({"running": is_running(), "dbExists": os.path.exists(RBX_DB)})


def cmd_dump():
    if not os.path.exists(RBX_DB):
        out({"error": "master.db not found", "running": is_running()})
    if is_running():
        # Reading a live SQLCipher file yields "disk I/O error" often enough
        # that a clean refusal beats a confusing partial read.
        out({"error": "rekordbox is running — close it to read the library",
             "running": True})

    from pyrekordbox.db6 import tables
    with open_db() as db:
        content = {}
        for c in db.get_content().all():
            p = c.FolderPath or ""
            content[c.ID] = {
                "sourceId": str(c.ID),
                "path": to_wsl(p),
                "title": c.Title,
                "artist": related_name(c, "Artist"),
                "bpm": normalized_bpm(c.BPM),
                "key": related_name(c, "Key"),
                "comment": c.Commnt or None,
                "analysisDataPath": c.AnalysisDataPath or None,
                "cues": sorted((normalized_cue(cue) for cue in (c.Cues or [])),
                               key=lambda cue: (cue["time"], cue["id"])),
                "trackNo": c.TrackNo,
                "fileSize": c.FileSize,
                "bitRate": c.BitRate,
                "length": c.Length,
            }

        names = {}
        parents = {}
        playlist_rows = {}
        for p in db.query(tables.DjmdPlaylist).all():
            names[p.ID] = p.Name
            parents[p.ID] = p.ParentID
            playlist_rows[p.ID] = {
                "sourceId": str(p.ID),
                "name": p.Name or "(unnamed)",
                "parentSourceId": str(p.ParentID) if p.ParentID else None,
                "sort": p.Seq,
                "members": [],
            }

        playlists = {}
        for sp in db.query(tables.DjmdSongPlaylist).all():
            c = content.get(sp.ContentID)
            if not c:
                continue
            playlists.setdefault(names.get(sp.PlaylistID, f"?{sp.PlaylistID}"), []).append(c["path"])
            playlist = playlist_rows.get(sp.PlaylistID)
            if playlist is not None:
                playlist["members"].append({
                    "sourceId": str(sp.ID),
                    "trackSourceId": str(sp.ContentID),
                    "position": sp.TrackNo,
                })

        rich_playlists = list(playlist_rows.values())
        for playlist in rich_playlists:
            playlist["members"].sort(key=lambda m: (m["position"] is None,
                                                     m["position"] or 0,
                                                     m["sourceId"]))
        rich_playlists.sort(key=lambda p: (p["sort"] is None, p["sort"] or 0,
                                           p["name"], p["sourceId"]))

        out({
            "running": False,
            "playlists": playlists,
            "content": [c["path"] for c in content.values()],
            "tracks": list(content.values()),
            "playlistRecords": rich_playlists,
            "meta": {
                "contentRows": len(content),
                "playlistRows": len(names),
                "folders": {names[i]: names.get(parents[i]) for i in names},
            },
        })


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    try:
        if cmd == "status":
            cmd_status()
        elif cmd == "dump":
            cmd_dump()
        else:
            out({"error": f"unknown command: {cmd} (read-only bridge: status | dump)"})
    except Exception as e:                                    # noqa: BLE001
        import traceback
        traceback.print_exc(file=sys.stderr)
        out({"error": f"{type(e).__name__}: {e}"})


if __name__ == "__main__":
    main()
