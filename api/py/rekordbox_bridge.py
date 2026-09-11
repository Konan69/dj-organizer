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
import subprocess
import sys

RBX_DB = "/mnt/c/Users/you/AppData/Roaming/Pioneer/rekordbox/master.db"


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


def open_db():
    from pyrekordbox import Rekordbox6Database
    db = Rekordbox6Database(path=RBX_DB)
    db.open()
    return db


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
    db = open_db()

    content = {}
    for c in db.get_content().all():
        p = c.FolderPath or ""
        content[c.ID] = {
            "path": to_wsl(p),
            "title": c.Title,
            "fileSize": c.FileSize,
            "bitRate": c.BitRate,
            "length": c.Length,
        }

    names = {}
    parents = {}
    for p in db.query(tables.DjmdPlaylist).all():
        names[p.ID] = p.Name
        parents[p.ID] = p.ParentID

    playlists = {}
    for sp in db.query(tables.DjmdSongPlaylist).all():
        c = content.get(sp.ContentID)
        if not c:
            continue
        playlists.setdefault(names.get(sp.PlaylistID, f"?{sp.PlaylistID}"), []).append(c["path"])

    out({
        "running": False,
        "playlists": playlists,
        "content": [c["path"] for c in content.values()],
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
